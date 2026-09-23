#!/usr/bin/env python3
"""Independent, local-only Claude Teams token audit (Python standard library).

Reads the app's ownership registry and explicit historical creation records.
Never reads credentials or emits transcript content. The private output manifest
contains local log paths/IDs plus counters, for the ignored Rust acceptance test:

  CLAUDE_TEAMS_AUDIT_MANIFEST=<output> cargo test --manifest-path src-tauri/Cargo.toml \
    retained_owned_logs_match_independent_sums --lib -- --ignored --nocapture

Counters use component maxima of cumulative message snapshots, independently of
Rust's last-row parser. Regressing snapshots are reported, not silently hidden.
Missing historical files cannot establish complete historical coverage.
"""

import argparse
import collections
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import tempfile

UTC = dt.timezone.utc
FIELDS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except ValueError:
        return None


def number(value):
    return max(0, value) if type(value) is int and value <= 2**63 - 1 else 0


def ownership(home, created_ids=None):
    """Read one consistent DB snapshot; explicit external decisions always win."""
    owned, external = set(), set()
    roots = {home / ".claude"}
    db = sqlite3.connect((home / ".agmux/agmux.db").as_uri() + "?mode=ro", uri=True)
    try:
        db.execute("BEGIN")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for sid, created in db.execute("""
            SELECT owner_id,created_in_agmux FROM session_origins WHERE provider='ClaudeCode'
            UNION ALL SELECT b.session_id,o.created_in_agmux FROM session_origin_bindings b
            JOIN session_origins o ON b.provider=o.provider AND b.owner_id=o.owner_id
            WHERE o.provider='ClaudeCode'
        """):
            (owned if created else external).add(sid)
        for sid, alias in db.execute("""
            SELECT id,sdk_session_id FROM threads WHERE provider='ClaudeCode' AND (
                id IN (SELECT owner_id FROM session_legacy_thread_claims WHERE provider='ClaudeCode')
                OR id IN (SELECT owner_id FROM session_origins WHERE provider='ClaudeCode' AND created_in_agmux=1)
            ) AND id NOT IN (SELECT owner_id FROM session_origins WHERE provider='ClaudeCode' AND created_in_agmux=0)
        """):
            owned.update(s for s in (sid, alias) if s)
        if "teams_created_claude_sessions" in tables:
            owned.update(row[0] for row in db.execute("SELECT session_id FROM teams_created_claude_sessions"))
        for (cwd,) in db.execute("SELECT work_dir FROM threads WHERE provider='ClaudeCode'"):
            path = Path(cwd)
            if path.name == "outputs" and path.parent.name.startswith("local_"):
                config = path.parent / ".claude"
                if config.is_dir():
                    roots.add(config)
    finally:
        db.close()
    if created_ids:
        ids = json.loads(created_ids.read_text())
        if not isinstance(ids, list) or not all(isinstance(s, str) and s for s in ids):
            raise ValueError("creation snapshot must be a JSON array of nonempty explicit IDs")
        owned.update(ids)
    return owned - external, external, roots


def totals(rows):
    fields = [0] * 4
    hours = {}
    for row in rows:
        bucket = hours.setdefault(row["at"].strftime("%Y-%m-%dT%H"), [0] * 4)
        for i, value in enumerate(row["fields"]):
            fields[i] += value
            bucket[i] += value
    return {"expected": sum(fields), "fields": fields, "hours": dict(sorted(hours.items()))}


def parse(path, session, since, until, stats):
    groups = {}
    stamp = path.stat()
    with path.open(encoding="utf-8") as source:
        for index, line in enumerate(source):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                stats["malformed_rows"] += 1
                continue
            if not isinstance(value, dict):
                continue
            message = value.get("message")
            message = message if isinstance(message, dict) else {}
            usage = message.get("usage", value.get("usage"))
            model = message.get("model", value.get("model"))
            if (value.get("type", "assistant") != "assistant" or not isinstance(usage, dict)
                    or not isinstance(model, str) or not model.strip() or model.strip().startswith("<")):
                continue
            at = timestamp(value.get("timestamp"))
            if at is None:
                stats["invalid_timestamps"] += 1
                continue
            if not since <= at <= until:
                stats["outside_window_rows"] += 1
                continue
            fields = [number(usage.get(name)) for name in FIELDS]
            stats["usage_rows"] += 1
            cache = usage.get("cache_creation")
            if isinstance(cache, dict) and number(cache.get("ephemeral_1h_input_tokens")):
                stats["one_hour_cache_rows"] += 1
            if not any(fields):
                stats["zero_rows"] += 1
                continue
            mid, request = message.get("id"), value.get("requestId")
            keyed = isinstance(mid, str) and bool(mid) and isinstance(request, str) and bool(request)
            if not keyed:
                stats["unkeyed_rows"] += 1
            # Tuple identities avoid delimiter collisions. Without both IDs we
            # cannot prove a duplicate: preserve the row and report uncertainty.
            key = (mid, request) if keyed else (str(path), index, None)
            row = {"fields": fields, "at": at, "session": session,
                   "side": value.get("isSidechain") is True,
                   "subagent": path.parent.name == "subagents"}
            if key in groups:
                previous = groups[key]
                stats["stream_duplicate_rows"] += 1
                if any(a > b for a, b in zip(previous["fields"], fields)):
                    stats["regressing_rows"] += 1
                row["fields"] = [max(a, b) for a, b in zip(previous["fields"], fields)]
            groups[key] = row
    after = path.stat()
    if (stamp.st_size, stamp.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("an audited log changed during reading; rerun on a stable snapshot")
    return groups


def audit(roots, owned, external, until):
    since = until - dt.timedelta(days=90)
    stats = collections.Counter(dict.fromkeys((
        "top_files", "subagent_files", "usage_rows", "stream_duplicate_rows",
        "cross_file_copies", "one_hour_cache_rows", "zero_rows", "unkeyed_rows",
        "regressing_rows", "malformed_rows", "invalid_timestamps", "outside_window_rows",
    ), 0))
    files, global_rows, found = [], {}, set()
    # Resolve duplicate roots but do not follow transcript symlinks.
    paths = sorted({p for root in {r.resolve() for r in roots} for p in (root / "projects").rglob("*.jsonl")
                    if not p.is_symlink() and not any(parent.is_symlink() for parent in p.parents)})
    for path in paths:
        sid = path.stem
        parent = path.parent.parent.name if path.parent.name == "subagents" else None
        if sid in external:
            continue
        if sid in owned:
            session = sid
            found.add(sid)
        elif parent in owned:
            session = f"{parent}:{sid}"
        else:
            continue
        stats["subagent_files" if parent else "top_files"] += 1
        groups = parse(path, session, since, until, stats)
        files.append({"path": str(path), "session": session, **totals(groups.values())})
        for key, row in groups.items():
            if key in global_rows:
                stats["cross_file_copies"] += 1
                previous = global_rows[key]
                # Select a whole snapshot, never fabricate a hybrid of two
                # copies. Prefer fuller counters, then parent, then stable tie.
                rank = lambda r: (-sum(r["fields"]), r["side"], r["subagent"], r["at"], r["session"])
                row = min((previous, row), key=rank)
            global_rows[key] = row
    return {"version": 1, "since": since.isoformat(), "until": until.isoformat(),
            "files": files, "global": totals(global_rows.values()),
            "summary": {**stats, "files": len(files), "events": len(global_rows),
                        "claimed_ids": len(owned),  # Owner IDs and aliases, not unique sessions. "found_claimed_ids": len(found),
                        "absent_claimed_ids": len(owned - found),
                        "per_file_tokens": sum(f["expected"] for f in files)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--output", type=Path, default=Path(tempfile.gettempdir()) / "claude-teams-audit-manifest.json")
    parser.add_argument("--created-ids", type=Path, help="optional explicit historical creation JSON array")
    parser.add_argument("--config-dir", type=Path, action="append", default=[], help="additional known Claude home (repeatable)")
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    owned, external, roots = ownership(home, args.created_ids)
    roots.update(path.expanduser().resolve() for path in args.config_dir)
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        roots.add(Path(os.environ["CLAUDE_CONFIG_DIR"]).expanduser().resolve())
    manifest = audit(roots, owned, external, dt.datetime.now(UTC))
    output = args.output.expanduser().resolve()
    # Private paths/IDs stay in a local mode-0600 manifest, never in stdout.
    with tempfile.NamedTemporaryFile(mode="w", dir=output.parent, delete=False) as destination:
        temporary = Path(destination.name)
        try:
            json.dump(manifest, destination, sort_keys=True, indent=2)
            destination.write("\n")
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({**manifest["summary"], "global_tokens": manifest["global"]["expected"]}, sort_keys=True))


if __name__ == "__main__":
    main()
