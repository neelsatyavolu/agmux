#!/usr/bin/env python3
"""Bounded, read-only request accounting diagnostics; outputs counters, no content/IDs.

This is not an ownership selector or a billing reconciliation. Inspect the most
recent Codex files and the exact file cohort in a supplied Claude audit manifest.
"""
import argparse
import collections
import datetime
import json
from pathlib import Path


CODEX_FIELDS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
                'output_tokens', 'reasoning_output_tokens')


def timestamp(value):
    try:
        return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (AttributeError, ValueError):
        return None


def compare_codex(previous, total, last, counts):
    """Compare consecutive positive, non-reset cumulative reports independently."""
    delta = tuple(a - b for a, b in zip(total, previous))
    if any(n < 0 for n in delta):
        counts['nonzero_decreasing_rows'] += 1
        return
    if not any(delta):
        return
    counts['positive_consecutive_deltas'] += 1
    if last is None:
        counts['positive_deltas_without_last'] += 1
        return
    counts['compared_delta_last_pairs'] += 1
    if delta != last:
        counts['delta_last_mismatches'] += 1
        for key, a, b in zip(CODEX_FIELDS, delta, last):
            counts['delta_minus_last_' + key] += a - b
            counts['mismatch_rows_' + key] += a != b
        for threshold in (200000, 272000):
            counts[f'mismatch_prompt_straddles_{threshold}'] += (delta[0] > threshold) != (last[0] > threshold)


def inspect(paths, provider):
    counts = collections.Counter()
    for key in ('delta_last_mismatches', 'mismatch_prompt_straddles_200000',
                'mismatch_prompt_straddles_272000', 'positive_deltas_without_last'):
        counts[key] = 0
    models = collections.Counter()
    comparisons_by_model = collections.defaultdict(collections.Counter)
    usage_fields = collections.Counter()
    nonzero_write_fields = collections.Counter()
    for path in paths:
        before = path.stat()
        model = ""
        previous = None
        seen = set()
        totals_seen = set()
        header_seen = False
        fork_at = None
        with path.open(encoding="utf-8") as source:
            for line in source:
                # Avoid decoding large content/tool rows with no usage/context.
                if not any(key in line for key in ('"usage"', '"token_usage"', '"turn_context"', '"session_meta"', '"total_token_usage"', '"last_token_usage"')):
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    counts['malformed_candidate_rows'] += 1
                    continue
                if provider == 'Claude':
                    message = row.get('message') or {}
                    usage = message.get('usage')
                    if row.get('type', 'assistant') != 'assistant' or not isinstance(usage, dict):
                        continue
                    model = message.get('model') or ''
                    if model.startswith('<'):
                        continue
                    key = (message.get('id'), row.get('requestId'))
                    if all(key):
                        counts['duplicate_stream_rows'] += key in seen
                        seen.add(key)
                    else:
                        counts['unkeyed_rows'] += 1
                    cache = usage.get('cache_creation') or {}
                    split = sum(cache.get(k, 0) or 0 for k in ('ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'))
                    counts['cache_lifetime_sum_mismatch'] += bool(cache and split != usage.get('cache_creation_input_tokens', 0))
                else:
                    payload = row.get('payload') or {}
                    if row.get('type') == 'session_meta':
                        if not header_seen:
                            header_seen = True
                            if payload.get('forked_from_id') or payload.get('forkedFromId'):
                                fork_at = timestamp(payload.get('timestamp'))
                                counts['forks_without_creation_timestamp'] += fork_at is None
                        continue
                    model = payload.get('model') or model
                    info = payload.get('info') or row.get('info') or {}
                    total = info.get('total_token_usage')
                    usage = info.get('last_token_usage')
                    if not isinstance(total, dict) and not isinstance(usage, dict):
                        continue
                    for label, fields in [('total', total), ('last', usage)]:
                        if isinstance(fields, dict):
                            for key, value in fields.items():
                                usage_fields[label + '.' + key] += 1
                                if 'cache' in key and ('write' in key or 'creation' in key):
                                    nonzero_write_fields[label + '.' + key] += isinstance(value, (int, float)) and value > 0
                    counts['total_only_rows_unknown_request_granularity'] += not isinstance(usage, dict)
                    if isinstance(total, dict):
                        current = tuple(total.get(k, 0) or 0 for k in CODEX_FIELDS)
                        at = timestamp(row.get('timestamp'))
                        copied = bool(fork_at and at and at < fork_at)
                        if not any(current):
                            totals_seen.clear()
                            previous = current
                            counts['zero_reset_rows'] += 1
                            continue
                        if current in totals_seen:
                            counts['duplicate_total_rows'] += 1
                            continue
                        totals_seen.add(current)
                        if copied:
                            counts['copied_prefix_rows'] += 1
                        elif previous is not None and at:
                            last = tuple(usage.get(k, 0) or 0 for k in CODEX_FIELDS) if isinstance(usage, dict) else None
                            compare_codex(previous, current, last, counts)
                            compare_codex(previous, current, last, comparisons_by_model[model or '(missing)'])
                        elif previous is None:
                            counts['first_reports_without_prior_baseline'] += 1
                        previous = current
                        if copied:
                            continue
                    usage = usage if isinstance(usage, dict) else total
                    counts['cache_exceeds_input_rows'] += (usage.get('cached_input_tokens', 0) or 0) + (usage.get('cache_write_input_tokens', 0) or 0) > (usage.get('input_tokens', 0) or 0)
                    counts['reasoning_exceeds_output_rows'] += (usage.get('reasoning_output_tokens', 0) or 0) > (usage.get('output_tokens', 0) or 0)
                counts['usage_rows'] += 1
                counts['missing_model_rows'] += not model
                counts['reported_cost_rows'] += any(k in usage or k in row for k in ('cost', 'cost_usd', 'total_cost_usd'))
                models[model or '(missing)'] += 1
        after = path.stat()
        counts['changed_during_read_files'] += (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
        counts['files'] += 1
    return {'counts': dict(counts), 'models': dict(models),
            'comparisons_by_model': {k: dict(v) for k, v in comparisons_by_model.items()},
            'usage_fields': dict(usage_fields), 'nonzero_write_fields': dict(nonzero_write_fields)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claude-manifest', type=Path, required=True)
    parser.add_argument('--codex-root', type=Path, default=Path.home() / '.codex/sessions')
    parser.add_argument('--limit', type=int, default=128)
    args = parser.parse_args()
    manifest = json.loads(args.claude_manifest.read_text())
    claude = [Path(row['path']) for row in manifest['files']]
    codex = sorted(args.codex_root.rglob('*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)[:max(0, args.limit)]
    print(json.dumps({'Claude': inspect(claude, 'Claude'), 'Codex': inspect(codex, 'Codex')}, sort_keys=True))
