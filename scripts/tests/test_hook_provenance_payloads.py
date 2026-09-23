import builtins
import io
import json
from pathlib import Path
import re
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]


class PayloadTests(unittest.TestCase):
    def socket(self, output):
        class Socket:
            def settimeout(self, *args): pass
            def connect(self, *args): pass
            def sendall(self, data): output.append(json.loads(data))
            def close(self): pass
        return types.SimpleNamespace(socket=lambda *a: Socket(), AF_UNIX=1, SOCK_STREAM=1)

    def execute(self, code, replacements):
        def imported(name, *args, **kwargs):
            if name in replacements:
                return replacements[name]
            return builtins.__import__(name, *args, **kwargs)
        namespace = {'__builtins__': dict(vars(builtins), __import__=imported)}
        exec(code, namespace)
        return namespace

    def test_grok_initial_id_proof_never_follows_resume_to_other_id(self):
        source = (ROOT / 'src-tauri/src/hooks/script.rs').read_text()
        python = source.split("exec python3 -c '\n", 1)[1].split("\n' \"$EVENT\"", 1)[0]
        for sid, proof in [('initial', 'grok-initial-id'), ('outside', None)]:
            output = []
            self.execute(python, {
                'socket': self.socket(output),
                'os': types.SimpleNamespace(environ={'AGMUX_INITIAL_CREATED_SESSION_ID': 'initial'}),
                'sys': types.SimpleNamespace(argv=['hook', 'prompt-submit', 'owner', '/fixture/socket', 'grok'],
                    stdin=io.StringIO(json.dumps({'sessionId': sid, 'source': 'new'}))),
            })
            self.assertEqual(output[0]['session_id'], 'owner')
            self.assertEqual(output[0]['payload'].get('agmux_creation'), proof)

    def test_hermes_explicit_child_callback_and_observer_proof_replay(self):
        source = (ROOT / 'src-tauri/src/hooks/hermes_settings.rs').read_text()
        python = re.search(r'const PLUGIN_PY: &str = r#"([\s\S]*?)"#;', source).group(1)
        output, callbacks = [], {}
        observer = types.SimpleNamespace(creation_proof=lambda sid: 'hermes-create-session' if sid == 'created' else None)
        namespace = self.execute(python, {
            'socket': self.socket(output),
            'sys': types.SimpleNamespace(modules={'agmux_hermes_provenance': observer}),
            'os': types.SimpleNamespace(environ={'AGMUX_SESSION_ID': 'owner', 'AGMUX_HOOK_SOCKET': '/fixture/socket'}),
        })
        namespace['register'](types.SimpleNamespace(register_hook=lambda name, callback: callbacks.__setitem__(name, callback)))
        for sid in ['created', 'outside']:
            callbacks['pre_llm_call'](session_id=sid)
        self.assertEqual(output[0]['payload']['agmux_creation'], 'hermes-create-session')
        self.assertNotIn('agmux_creation', output[1]['payload'])
        callbacks['subagent_start'](child_session_id='child', parent_session_id='created')
        callbacks['pre_llm_call'](session_id='child')
        for message in output[2:]:
            self.assertEqual(message['payload']['agmux_creation'], 'hermes-subagent-start')
            self.assertTrue(message['payload']['agmux_subagent'])
            self.assertEqual(message['session_id'], 'owner')
        self.assertNotIn('on_session_reset', callbacks, 'reset is not creation proof')


if __name__ == '__main__':
    unittest.main()
