import collections
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).parents[1] / 'audit-teams-request-boundaries.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class RequestBoundaryAuditTests(unittest.TestCase):
    def test_detects_multi_request_delta_crossing_both_thresholds(self):
        counts = collections.Counter()
        audit.compare_codex((100, 0, 0, 1, 0), (300100, 0, 0, 201, 0),
                            (150000, 0, 0, 100, 0), counts)
        self.assertEqual(counts['delta_last_mismatches'], 1)
        self.assertEqual(counts['mismatch_prompt_straddles_200000'], 1)
        self.assertEqual(counts['mismatch_prompt_straddles_272000'], 1)

    def test_cache_write_is_a_compared_component(self):
        counts = collections.Counter()
        audit.compare_codex((100, 0, 10, 1, 0), (200, 0, 30, 2, 0),
                            (100, 0, 0, 1, 0), counts)
        self.assertEqual(counts['mismatch_rows_cache_write_input_tokens'], 1)

    def test_copied_prefix_duplicates_and_zero_reset_do_not_become_mismatches(self):
        header = {'type': 'session_meta', 'payload': {
            'forked_from_id': 'parent', 'timestamp': '2026-09-01T00:00:00Z'}}
        def row(day, total, last):
            return {'timestamp': f'2026-{day}T00:00:00Z', 'payload': {
                'model': 'gpt-6-astra', 'info': {
                    'total_token_usage': {'input_tokens': total},
                    'last_token_usage': {'input_tokens': last}}}}
        rows = [header, row('08-31', 300000, 150000), row('09-02', 300100, 100),
                row('09-02', 300100, 100), row('09-03', 0, 100), row('09-04', 100, 100)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.jsonl'
            path.write_text('\n'.join(map(json.dumps, rows)))
            counts = audit.inspect([path], 'Codex')['counts']
        self.assertEqual(counts['copied_prefix_rows'], 1)
        self.assertEqual(counts['duplicate_total_rows'], 1)
        self.assertEqual(counts['zero_reset_rows'], 1)
        self.assertEqual(counts['compared_delta_last_pairs'], 2)
        self.assertEqual(counts['delta_last_mismatches'], 0)


if __name__ == '__main__':
    unittest.main()
