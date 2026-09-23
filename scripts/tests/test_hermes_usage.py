from contextlib import closing
import importlib.util
import os
import re
import sys
from unittest.mock import patch
import sqlite3
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2] / 'src-tauri/src/hooks/hermes_usage.py'

class HermesUsageTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('hermes_usage', SOURCE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        with closing(sqlite3.connect(self.root / 'agmux.db')) as db, db:
            db.execute('CREATE TABLE session_origins(provider, owner_id, created_in_agmux)')
            db.execute("INSERT INTO session_origins VALUES ('Hermes', 'owner', 1)")
        self.payload = dict(session_id='session', api_request_id='turn:api:1',
            ended_at=1788860000.25, model='anthropic/claude-opus-4-6',
            usage=dict(input_tokens=10, output_tokens=8, cache_read_tokens=20,
                       cache_write_tokens=3, reasoning_tokens=5),
            response={'secret': 'PRIVATE'}, base_url='PRIVATE', user_message='PRIVATE')

    def persist(self):
        self.module.persist_usage(self.root, 'owner', self.payload)

    def test_persists_exact_counts_once_without_content(self):
        self.persist()
        self.persist()
        with closing(sqlite3.connect(self.root / 'teams/hermes-usage.sqlite')) as db:
            db.row_factory = sqlite3.Row
            rows = list(db.execute('SELECT * FROM hermes_api_usage'))
            self.assertEqual(len(rows), 1)
            row = dict(rows[0])
            self.assertEqual(row['ended_at'], self.payload['ended_at'])
            for key, value in self.payload['usage'].items():
                self.assertEqual(row[key], value)
            self.assertNotIn('PRIVATE', str(row))
            self.assertNotIn('response', row)
            self.assertEqual(row['session_id'], 'session')
        self.payload['api_request_id'] = 'turn:api:2'
        self.persist()
        with closing(sqlite3.connect(self.root / 'teams/hermes-usage.sqlite')) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM hermes_api_usage').fetchone()[0], 2)

    def test_imported_or_unknown_owner_is_inert(self):
        with closing(sqlite3.connect(self.root / 'agmux.db')) as db, db:
            db.execute('UPDATE session_origins SET created_in_agmux=0')
        self.persist()
        self.assertFalse((self.root / 'teams').exists())

    def test_missing_database_does_not_create_one(self):
        (self.root / 'agmux.db').unlink()
        self.persist()
        self.assertFalse((self.root / 'agmux.db').exists())
        self.assertFalse((self.root / 'teams').exists())

    def test_same_request_in_distinct_native_sessions_is_preserved(self):
        self.persist()
        self.payload['session_id'] = 'child-session'
        self.persist()
        with closing(sqlite3.connect(self.root / 'teams/hermes-usage.sqlite')) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM hermes_api_usage').fetchone()[0], 2)

    def test_plugin_callback_loads_helper_as_package_without_socket_changes(self):
        source = SOURCE.with_name('hermes_settings.rs').read_text()
        template = re.search(r'const PLUGIN_PY: &str = r#"(.*?)"#;', source, re.S)[1]
        package = self.root / 'plugin'
        package.mkdir()
        (package / '__init__.py').write_text(template)
        (package / 'hermes_usage.py').write_text(SOURCE.read_text())
        spec = importlib.util.spec_from_file_location('test_hermes_plugin',
            package / '__init__.py', submodule_search_locations=[str(package)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        self.addCleanup(lambda: sys.modules.pop(spec.name, None))
        self.addCleanup(lambda: sys.modules.pop(spec.name + '.hermes_usage', None))
        spec.loader.exec_module(module)
        class Context:
            def __init__(self):
                self.hooks = {}
            def register_hook(self, name, callback):
                self.hooks[name] = callback
        ctx = Context()
        with patch.dict(os.environ, {'AGMUX_HOOK_SOCKET': '/unused', 'AGMUX_SESSION_ID': 'owner'}):
            module.register(ctx)
        self.assertIn('post_api_request', ctx.hooks)
        # Match the installed Hermes package-loading mechanism; no socket or paid call.
        (self.root / '.agmux').mkdir()
        (self.root / 'agmux.db').rename(self.root / '.agmux/agmux.db')
        with patch('pathlib.Path.home', return_value=self.root), patch('socket.socket') as sock:
            ctx.hooks['post_api_request'](**self.payload)
            sock.assert_not_called()
        self.assertTrue((self.root / '.agmux/teams/hermes-usage.sqlite').is_file())

    def test_missing_usage_invalid_counts_or_paths_are_inert(self):
        for updates in [dict(usage=None), dict(ended_at=float('nan')),
                        dict(session_id='/private/session'), dict(model='/private/model'),
                        dict(usage={'input_tokens': -1}),
                        dict(usage={**self.payload['usage'], 'output_tokens': True})]:
            original = self.payload
            self.payload = {**original, **updates}
            self.persist()
            self.payload = original
            self.assertFalse((self.root / 'teams').exists())

if __name__ == '__main__':
    unittest.main()
