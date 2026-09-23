import importlib.util
from pathlib import Path
import sqlite3
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('hermes_provenance', ROOT / 'src-tauri/src/hooks/hermes_provenance.py')
module = importlib.util.module_from_spec(spec)
previous_bytecode = sys.dont_write_bytecode
sys.dont_write_bytecode = True
try:
    spec.loader.exec_module(module)
finally:
    sys.dont_write_bytecode = previous_bytecode


class CreationTests(unittest.TestCase):
    def test_commit_existing_resume_rollback_and_retry(self):
        reported = []

        class DB:
            def __init__(self):
                self.conn = sqlite3.connect(':memory:')
                self.conn.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY)')
                self.fail = False
                self.retry = False

            def _execute_write(self, operation):
                for attempt in range(2):
                    self.conn.execute('BEGIN IMMEDIATE')
                    try:
                        result = operation(self.conn)
                        if self.fail or (self.retry and attempt == 0):
                            raise RuntimeError('fixture rollback')
                        self.conn.commit()
                        return result
                    except RuntimeError:
                        self.conn.rollback()
                        if not self.retry:
                            raise

            def create_session(self, session_id, source, **kwargs):
                self._execute_write(lambda c: c.execute('INSERT OR IGNORE INTO sessions VALUES(?)', (session_id,)))
                return session_id

        module.observe_session_db(DB, reported.append)
        module.observe_session_db(DB, reported.append)
        db = DB()
        # Installed before any plugin or first session creation.
        self.assertEqual(db.create_session('initial', 'tui'), 'initial')
        db.create_session('initial', 'tui')
        db.conn.execute("INSERT INTO sessions VALUES('outside')")
        db.conn.commit()
        db.create_session('outside', 'tui')
        self.assertEqual(reported, ['initial'])
        db.fail = True
        with self.assertRaises(RuntimeError):
            db.create_session('failed', 'tui')
        self.assertIsNone(module.creation_proof('failed'))
        db.fail = False
        db.retry = True
        db.create_session('new', 'tui')
        self.assertEqual(reported, ['initial', 'new'])
        self.assertEqual(module.creation_proof('new'), 'hermes-create-session')
        self.assertIsNone(module.creation_proof('outside'))
        db.conn.close()

    def test_unsupported_interfaces_leave_native_methods_untouched(self):
        class MissingWrite:
            def create_session(self, session_id, source):
                return session_id
        original = MissingWrite.create_session
        for cls in [None, object, MissingWrite]:
            self.assertFalse(module.observe_session_db(cls))
        self.assertIs(MissingWrite.create_session, original)
        self.assertEqual(MissingWrite().create_session('native', 'tui'), 'native')

    def test_probe_schema_errors_do_not_hide_original_operation_errors(self):
        reported = []
        class DB:
            def __init__(self, initial_table):
                self.conn = sqlite3.connect(':memory:')
                self.conn.execute('CREATE TABLE events(id TEXT)')
                if initial_table:
                    self.conn.execute('CREATE TABLE sessions(id TEXT)')
                self.fail = False
                self.drop_after = initial_table
            def _execute_write(self, fn):
                with self.conn:
                    return fn(self.conn)
            def create_session(self, session_id, source='tui'):
                def operation(conn):
                    if self.fail:
                        raise sqlite3.OperationalError('original native failure')
                    if self.drop_after:
                        conn.execute('DROP TABLE sessions')
                    conn.execute('INSERT INTO events VALUES(?)', (session_id,))
                    return 'native result'
                return self._execute_write(fn=operation)
        self.assertTrue(module.observe_session_db(DB, reported.append))
        for initial_table in [False, True]:
            db = DB(initial_table)
            # Missing observer schema before OR after the native operation.
            self.assertEqual(db.create_session(session_id='native'), 'native result')
            self.assertEqual(db.conn.execute('SELECT id FROM events').fetchall(), [('native',)])
            db.fail = True
            with self.assertRaisesRegex(sqlite3.OperationalError, 'original native failure'):
                db.create_session('failed')
            db.conn.close()
        self.assertFalse(reported)

    def test_usage_normalizes_self_owned_native_after_imported_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with sqlite3.connect(root / 'agmux.db') as db:
                db.executescript("""CREATE TABLE session_origins(provider TEXT,owner_id TEXT,created_in_agmux INTEGER);
                    CREATE TABLE session_origin_bindings(provider TEXT,owner_id TEXT,session_id TEXT);
                    INSERT INTO session_origins VALUES('Hermes','imported',0),('Hermes','native-new',1);
                    INSERT INTO session_origin_bindings VALUES('Hermes','imported','external'),('Hermes','native-new','native-new');""")
            self.assertEqual(module.usage_owner(root, 'imported', 'native-new'), 'native-new')
            self.assertEqual(module.usage_owner(root, 'imported', 'external'), 'imported')
            self.assertEqual(module.usage_owner(root, 'imported', 'unknown'), 'imported')
            # Exercise the unchanged usage writer using the normalized owner.
            namespace = {}
            exec((ROOT / 'src-tauri/src/hooks/hermes_usage.py').read_text(), namespace)
            payload = dict(session_id='native-new', api_request_id='request', ended_at=1.0,
                model='claude-opus-4-6', usage={key: 1 for key in namespace['TOKEN_KEYS']})
            namespace['persist_usage'](root, module.usage_owner(root, 'imported', 'native-new'), payload)
            with sqlite3.connect(root / 'teams/hermes-usage.sqlite') as db:
                self.assertEqual(db.execute('SELECT owner_id,session_id FROM hermes_api_usage').fetchall(),
                                 [('native-new', 'native-new')])

    def test_bootstrap_packet_is_provenance_only_before_child_callback(self):
        module._created.add('bootstrap-child')
        with patch.dict(module.os.environ, {'AGMUX_SESSION_ID': 'parent', 'AGMUX_HOOK_SOCKET': '/fixture/socket'}):
            with patch.object(module.socket, 'socket') as connection:
                module._emit('bootstrap-child')
                raw = connection.return_value.__enter__.return_value.sendall.call_args.args[0]
        message = json.loads(raw)
        self.assertTrue(message['payload']['agmux_provenance_only'])
        self.assertEqual(message['session_id'], 'parent')
        self.assertEqual(message['payload']['session_id'], 'bootstrap-child')
        module._created.remove('bootstrap-child')

    def test_first_usage_waits_for_independent_native_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with sqlite3.connect(root / 'agmux.db') as db:
                db.executescript("""CREATE TABLE session_origins(provider TEXT,owner_id TEXT,created_in_agmux INTEGER);
                    CREATE TABLE session_origin_bindings(provider TEXT,owner_id TEXT,session_id TEXT);
                    INSERT INTO session_origins VALUES('Hermes','imported',0);""")
            namespace = {}
            exec((ROOT / 'src-tauri/src/hooks/hermes_usage.py').read_text(), namespace)
            payload = dict(session_id='waiting-native', api_request_id='first', ended_at=1.0,
                model='claude-opus-4-6', prompt='never retained', usage={key: 1 for key in namespace['TOKEN_KEYS']})
            module._pending.clear()
            module._pending_worker = False
            with patch.object(module.threading, 'Thread'):
                module.persist_usage_when_owned(root, 'imported', payload, namespace['persist_usage'], created=True)
            self.assertEqual(len(module._pending), 1)
            self.assertNotIn('prompt', next(iter(module._pending.values()))[2])
            outside = dict(payload, session_id='outside')
            module.persist_usage_when_owned(root, 'imported', outside, namespace['persist_usage'])
            self.assertEqual(len(module._pending), 1, 'unknown outside resume must not enter the buffer')
            with sqlite3.connect(root / 'agmux.db') as db:
                db.executescript("""INSERT INTO session_origins VALUES('Hermes','waiting-native',1);
                    INSERT INTO session_origin_bindings VALUES('Hermes','waiting-native','waiting-native');""")
            module._flush_pending_usage()
            self.assertFalse(module._pending)
            module._pending_worker = False
            with sqlite3.connect(root / 'teams/hermes-usage.sqlite') as db:
                self.assertEqual(db.execute('SELECT owner_id,session_id,api_request_id FROM hermes_api_usage').fetchall(),
                                 [('waiting-native', 'waiting-native', 'first')])

    def test_startup_observer_precedes_initial_create_and_plugin_load(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'agmux_hermes_provenance.py').write_text(
                (ROOT / 'src-tauri/src/hooks/hermes_provenance.py').read_text())
            (root / 'sitecustomize.py').write_text((ROOT / 'src-tauri/src/hooks/hermes_sitecustomize.py').read_text())
            original = root / 'original'
            original.mkdir()
            (original / 'sitecustomize.py').write_text('original_startup_ran = True\n')
            (root / 'hermes_state.py').write_text("""import sqlite3
import json
class SessionDB:
    def __init__(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY)')
    def _execute_write(self, operation):
        self.conn.execute('BEGIN IMMEDIATE')
        try:
            result = operation(self.conn)
            self.conn.commit()
            return result
        except BaseException:
            self.conn.rollback()
            raise
    def create_session(self, session_id, source, **kwargs):
        self._execute_write(lambda conn: conn.execute('INSERT OR IGNORE INTO sessions VALUES(?)', (session_id,)))
        return session_id
""")
            environment = dict(os.environ, PYTHONPATH=os.pathsep.join([str(root), str(original)]), AGMUX_PROVIDER='hermes')
            environment.pop('AGMUX_HOOK_SOCKET', None)
            code = """import sitecustomize
assert sitecustomize.original_startup_ran
from hermes_state import SessionDB
from agmux_hermes_provenance import creation_proof
assert SessionDB._agmux_creation_observer
assert SessionDB().create_session('before-plugin', 'tui') == 'before-plugin'
assert creation_proof('before-plugin') == 'hermes-create-session'
"""
            subprocess.run([sys.executable, '-c', code], env=environment, cwd=root, check=True,
                           capture_output=True, text=True)
            (root / 'hermes_state.py').write_text('unsupported_version = True\n')
            result = subprocess.run([sys.executable, '-c', 'import hermes_state; assert hermes_state.unsupported_version'],
                                    env=environment, cwd=root, check=True, capture_output=True, text=True)
            self.assertNotIn('Error in sitecustomize', result.stderr)


if __name__ == '__main__':
    unittest.main()
