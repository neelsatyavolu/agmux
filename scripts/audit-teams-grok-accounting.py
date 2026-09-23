#!/usr/bin/env python3
"""Read-only Grok oracle. Outputs aggregate-only private fixtures, never transcripts.

The native cohort must have one completion per prompt (replays allowed); refuse
other shapes instead of silently duplicating the scanner's watermark algorithm.
Run the Rust ignored independent_manifest_matches_native_buckets test with
AGMUX_GROK_AUDIT_MANIFEST pointing at the output to compare every prompt/model/hour.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3

FIELDS = ('inputTokens', 'cachedReadTokens', 'cacheCreationTokens',
          'outputTokens', 'reasoningTokens', 'costUsdTicks')


def counters(u):
    n = [int(u.get(k) or 0) for k in FIELDS]
    assert all(x >= 0 for x in n)
    assert n[0] >= n[1] + n[2]
    return [n[0] - n[1] - n[2], n[1], n[2], n[3], n[4], n[5]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=Path.home()/'.agmux/agmux.db')
    parser.add_argument('--root', type=Path, default=Path.home()/'.grok/sessions')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    db = sqlite3.connect(args.db.resolve().as_uri() + '?mode=ro', uri=True)
    # Fixed native aliases tie the selected cohort to agmux; legacy ties alone
    # do NOT certify historical creation. Do not mutate or infer ownership.
    ids = set()
    modes = dict(db.execute("SELECT b.session_id,t.interaction_mode FROM session_legacy_bindings b JOIN threads t ON t.id=b.owner_id WHERE b.provider='Grok'"))
    flags = collections.defaultdict(list)
    for sid, created in db.execute("SELECT b.session_id,COALESCE(o.created_in_agmux,1) FROM session_legacy_bindings b LEFT JOIN session_origins o ON o.provider=b.provider AND o.owner_id=b.owner_id WHERE b.provider='Grok'"):
        flags[sid].append(created)
    for sid, created in db.execute("SELECT owner_id,created_in_agmux FROM session_origins WHERE provider='Grok' UNION ALL SELECT b.session_id,o.created_in_agmux FROM session_origin_bindings b JOIN session_origins o ON o.provider=b.provider AND o.owner_id=b.owner_id WHERE b.provider='Grok'"):
        flags[sid].append(created)
    for sid, values in flags.items():
        if all(values): ids.add(sid)
        else: ids.discard(sid)
    result = {'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sessions': []}
    stats = collections.Counter()
    totals = [0]*6
    models = collections.defaultdict(lambda: [0]*6)
    transports = collections.defaultdict(lambda: {'files':0, 'completions':0, 'cost_unreported':0, 'values':[0]*6})
    missing = []
    present = set()
    for path in sorted(args.root.glob('*/*/updates.jsonl')):
        if path.parent.name not in ids: continue
        present.add(path.parent.name)
        stats['files'] += 1
        mode = modes.get(path.parent.name, 'unknown')
        transports[mode]['files'] += 1
        label = hashlib.sha256(str(path).encode()).hexdigest()[:16]
        rows, prompts, expected = [], {}, []
        seen = set()
        for line in path.open():
            try: v = json.loads(line)
            except ValueError: continue
            params = v.get('params', {})
            update = params.get('update', {})
            u = update.get('usage')
            if not isinstance(u, dict): continue
            event = params.get('_meta', {}).get('eventId')
            if event is not None and event in seen:
                stats['duplicate_event_ids'] += 1
                continue
            if event is not None: seen.add(event)
            pid = update.get('prompt_id') or params.get('_meta', {}).get('promptId')
            assert pid, 'Anonymous completion requires a separate oracle'
            if pid in prompts:
                assert prompts[pid] == u, 'Non-identical repeated prompt: audit oracle needs extension'
                stats['duplicate_prompt_snapshots'] += 1
                continue
            prompts[pid] = u
            timestamp = v.get('timestamp')
            assert isinstance(timestamp, int), 'Unexpected native timestamp shape'
            if timestamp > 10_000_000_000: timestamp //= 1000
            assert u['inputTokens'] + u['outputTokens'] == u['totalTokens']
            parts = u.get('modelUsage', {})
            assert parts, 'Missing model map: cannot independently certify model attribution'
            root = counters(u)
            part_total = [sum(counters(p)[i] for p in parts.values()) for i in range(6)]
            assert root == part_total, 'Incomplete model map: requires explicit reconciliation'
            stats['completions'] += 1
            transports[mode]['completions'] += 1
            stats['multi_model_completions'] += len(parts) > 1
            if 'costUsdTicks' not in u:
                stats['cost_unreported_completions'] += 1
                transports[mode]['cost_unreported'] += 1
                missing.append({'session':label, 'prompt_ordinal':len(rows), 'tokens':u['totalTokens'],
                                'incomplete':bool(u.get('usageIsIncomplete'))})
            if u.get('usageIsIncomplete'):
                stats['incomplete_completions'] += 1
                stats['incomplete_reported_tokens'] += u['totalTokens']
            # Retain only numeric usage/model names; replace native identities.
            safe = {k:u[k] for k in (*FIELDS, 'totalTokens', 'numTurns', 'usageIsIncomplete') if k in u}
            safe['modelUsage'] = {m:{k:p[k] for k in (*FIELDS, 'numTurns') if k in p} for m,p in parts.items()}
            row = {'timestamp':timestamp, 'params':{'update':{'sessionUpdate':'turn_completed',
                    'prompt_id':str(len(rows)), 'usage':safe}}}
            rows.append(row)
            for m, p in parts.items():
                nums = counters(p)
                expected.append({'prompt':str(len(rows)-1), 'model':m, 'hour':timestamp//3600, 'values':nums})
                for i, n in enumerate(nums):
                    totals[i] += n
                    models[m][i] += n
                    transports[mode]['values'][i] += n
        if rows:
            stats['files_with_usage'] += 1
            result['sessions'].append({'label':label, 'rows':rows, 'expected':expected})
    stats['tied_ids_without_updates_file'] = len(ids-present)
    result.update(stats=dict(stats), totals=totals, models=dict(models), transports=dict(transports), unreported=missing)
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(result, f)
    print(json.dumps({k:result[k] for k in ('captured_at','stats','totals','models','transports')}, indent=2))


if __name__ == '__main__':
    main()
