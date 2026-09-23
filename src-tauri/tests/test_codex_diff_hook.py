import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'src/hooks/codex_diff_hook.py'
spec = importlib.util.spec_from_file_location('codex_diff_hook', SCRIPT)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class CodexDiffHookTests(unittest.TestCase):
    def test_interrupted_preparation_remains_a_writer_guard(self):
        (self.cwd / 'a').write_text('old\n')
        self.pre("printf 'own\\n' >> a", 'first')
        with patch.object(hook, '_effective_cwd', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.pre("printf 'other\\n' >> a", 'interrupted')
        state = json.loads((self.root / 'state.json').read_text())
        interrupted = state[hashlib.sha256(b'parent-sessioninterrupted').hexdigest()]
        self.assertEqual(interrupted['status'], 'pending')
        self.assertTrue(interrupted['wide'])
        (self.cwd / 'a').write_text('old\nother\nown\n')
        self.post('first')
        self.assertEqual(self.changes(), [])
        self.post('interrupted')
        self.assertEqual(self.run_edit("printf 'later\\n' >> a", 'later').returncode, 0)
        self.assert_change('a', 1, 0)

    def native_completion_fixture(self, command="printf 'new\\n' > a", tool='native-job'):
        payload = self.payload(command, tool)
        trace = Path(payload['transcript_path'])
        trace.write_text(json.dumps({'type': 'session_meta', 'payload': {
            'id': 'parent-session', 'cwd': str(self.cwd), 'history_mode': 'paginated',
        }}) + '\n' + trace.read_text())
        hook.handle(payload, self.root)
        key = hashlib.sha256(('parent-session' + tool).encode()).hexdigest()
        entry = json.loads((self.root / 'state.json').read_text())[key]
        completion = {'type': 'event_msg', 'payload': {
            'type': 'item_completed', 'thread_id': 'parent-session',
            'completed_at_ms': int(entry['startedAt'] * 1000) + 100,
            'item': {'type': 'CommandExecution', 'id': tool, 'status': 'completed', 'exit_code': 0},
        }}
        return trace, key, completion

    def test_unpolled_native_completion_settles_without_owner_or_later_poll(self):
        (self.cwd / 'a').write_text('old\n')
        trace, key, completion = self.native_completion_fixture()
        (self.cwd / 'a').write_text('new\n')
        with trace.open('a') as file:
            file.write(json.dumps(completion) + '\n')
        result = hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)
        self.assertEqual(result, {'pending': False, 'recovered': 1})
        self.assert_change('a', 1, 1)
        self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'done')
        self.post('native-job')
        self.assertEqual(len(self.records()), 1)

    def test_unpolled_delayed_write_keeps_targets_until_exact_completion(self):
        (self.cwd / 'a').write_text('before\n')
        command = "printf 'before\\n' > a; sleep 5; printf 'after\\nextra\\n' > a"
        trace, key, completion = self.native_completion_fixture(command)
        entry = json.loads((self.root / 'state.json').read_text())[key]
        self.assertEqual(entry['paths'], [str(self.cwd / 'a')])
        self.assertFalse(entry['wide'])
        with trace.open('a') as file:
            file.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'task_complete'}}) + '\n')
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
        (self.cwd / 'a').write_text('after\nextra\n')
        with trace.open('a') as file:
            file.write(json.dumps(completion) + '\n')
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)
        self.assert_change('a', 2, 1)
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
        self.post('native-job')
        self.assertEqual(len(self.records()), 1)

    def test_only_literal_sleep_duration_is_inspection_only(self):
        for duration in ('0', '5', '0.25', '.1'):
            self.assertEqual(hook._command_paths('sleep ' + duration + '; echo new > a'), {'a'})
        for command in ('sleep', 'sleep -1', 'sleep 1 extra', 'sleep "$DELAY"',
                        'sleep $(writer)', 'sleep 1; unknown-writer'):
            with self.subTest(command=command), self.assertRaises(hook.Unsupported):
                hook._command_paths(command)

    def test_native_completion_retires_expired_guard_without_retroactive_counts(self):
        trace, key, completion = self.native_completion_fixture('unknown-writer')
        (self.cwd / 'a').write_text('old\n')
        state = json.loads((self.root / 'state.json').read_text())
        state[key]['status'] = 'expired'
        (self.root / 'state.json').write_text(json.dumps(state))
        with trace.open('a') as file:
            file.write(json.dumps(completion) + '\n')
        self.assertEqual(self.run_edit("printf 'new\\n' > a", 'new').returncode, 0)
        self.assert_change('a', 1, 1)
        self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'done')

    def test_native_patch_end_receipts_retire_guards_without_counting_patch_twice(self):
        import datetime
        for index, kind in enumerate(('FileChange', 'patch_apply_end')):
            with self.subTest(kind=kind):
                tool = 'native-patch-' + str(index)
                trace, key, completion = self.native_completion_fixture('unknown-writer', tool)
                if kind == 'FileChange':
                    completion['payload']['item'] = {'type':kind,'id':tool,'status':'failed'}
                else:
                    completion['timestamp'] = datetime.datetime.fromtimestamp(
                        completion['payload']['completed_at_ms'] / 1000, datetime.timezone.utc).isoformat()
                    completion['payload'] = {'type':kind,'call_id':tool,'status':'completed','success':True}
                with trace.open('a') as file:
                    file.write(json.dumps(completion) + '\n')
                self.assertEqual(hook.handle({'hook_event_name':'CaptureReconcile'}, self.root)['recovered'], 1)
                self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'done')
                self.assertEqual(self.changes(), [])

    def test_incomplete_or_foreign_patch_receipts_do_not_retire_guards(self):
        trace, key, completion = self.native_completion_fixture('unknown-writer')
        original = trace.read_text()
        completion['payload']['item'] = {'type':'FileChange','id':'native-job','status':'inProgress'}
        for payload in (completion['payload'],
                        {'type':'patch_apply_end','call_id':'native-job','status':'completed'},
                        {'type':'patch_apply_end','call_id':'native-job','status':'completed','success':False},
                        {'type':'patch_apply_end','call_id':'native-job','success':True,'thread_id':'foreign'}):
            trace.write_text(original + json.dumps({'type':'event_msg','timestamp':'2099-01-01T00:00:00Z','payload':payload}) + '\n')
            self.assertEqual(hook.handle({'hook_event_name':'CaptureReconcile'}, self.root)['recovered'], 0)
            self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'pending')

    def test_idle_and_wrong_or_incomplete_receipts_cannot_retire_guards(self):
        trace, key, completion = self.native_completion_fixture('unknown-writer')
        original = trace.read_text()
        invalid = [
            {'type': 'event_msg', 'payload': {'type': 'task_complete'}},
            json.loads(json.dumps(completion)), json.loads(json.dumps(completion)),
            json.loads(json.dumps(completion)), json.loads(json.dumps(completion)),
        ]
        invalid[1]['payload']['thread_id'] = 'other'
        invalid[2]['payload']['item']['id'] = 'other'
        invalid[3]['payload']['item']['status'] = 'inProgress'
        invalid[4]['payload']['item'].pop('exit_code')
        for row in invalid:
            trace.write_text(original + json.dumps(row) + '\n')
            self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
            self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'pending')
        trace.write_text(original + json.dumps(completion))  # Partial record is not proof.
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)

    def test_reconcile_without_new_evidence_does_not_rewrite_state(self):
        trace, _, _ = self.native_completion_fixture('unknown-writer')
        hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)
        before = (self.root / 'state.json').stat().st_mtime_ns
        hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)
        self.assertEqual((self.root / 'state.json').stat().st_mtime_ns, before)

    def test_completion_before_large_output_is_not_lost_to_tail_limit(self):
        trace, key, completion = self.native_completion_fixture('unknown-writer')
        with trace.open('a') as file:
            file.write(json.dumps(completion) + '\n')
            file.write((json.dumps({'type':'event_msg','payload':{'text':'x' * 1024}}) + '\n') * 2100)
        result = hook.handle({'hook_event_name':'CaptureReconcile'}, self.root)
        self.assertEqual(result['recovered'], 1)
        self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'done')

    def test_expired_capture_scans_forward_in_bounded_chunks(self):
        trace, key, completion = self.native_completion_fixture('unknown-writer')
        state = json.loads((self.root / 'state.json').read_text())
        state[key]['status'] = 'expired'
        (self.root / 'state.json').write_text(json.dumps(state))
        with trace.open('a') as file:
            file.write((json.dumps({'type':'event_msg','payload':{'text':'x' * 1024}}) + '\n') * 4200)
            file.write(json.dumps(completion) + '\n')
        first = hook.handle({'hook_event_name':'CaptureReconcile'}, self.root)
        self.assertEqual(first, {'pending':True, 'recovered':0})
        for _ in range(4):
            hook.handle({'hook_event_name':'CaptureReconcile'}, self.root)
        self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'done')

    def test_receipt_across_scan_boundary_and_partial_append(self):
        trace, key, completion = self.native_completion_fixture('unknown-writer')
        original = trace.read_bytes()
        receipt = (json.dumps(completion) + '\n').encode()
        padding = b' ' * (hook.MAX_TRANSCRIPT_BYTES - len(original) - 30) + b'\n'
        trace.write_bytes(original + padding + receipt[:60])
        self.assertEqual(hook.handle({'hook_event_name':'CaptureReconcile'}, self.root)['recovered'], 0)
        with trace.open('ab') as file:
            file.write(receipt[60:])
        for _ in range(3):
            hook.handle({'hook_event_name':'CaptureReconcile'}, self.root)
        self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'done')

    def test_receipt_scan_restarts_after_in_place_replacement(self):
        trace, key, completion = self.native_completion_fixture('unknown-writer')
        original = trace.read_text()
        other = json.loads(json.dumps(completion))
        other['payload']['item']['id'] = 'different!'
        trace.write_text(original + json.dumps(other) + '\n')
        self.assertEqual(hook.handle({'hook_event_name':'CaptureReconcile'}, self.root)['recovered'], 0)
        trace.write_text(original + json.dumps(completion) + '\n')
        self.assertEqual(hook.handle({'hook_event_name':'CaptureReconcile'}, self.root)['recovered'], 1)

    def test_result_printing_wrappers_preserve_exact_shell_scope(self):
        call = 'tools.exec_command({cmd:"echo ok",workdir:"/repo"})'
        for source in (
            'const results = await Promise.allSettled(['+call+']); results.forEach(text);',
            'await Promise.allSettled(['+call+']).then(r=>r.forEach(text));',
            'const ts=ALL_TOOLS.filter(x=>/memory_list/.test(x.name)); text(ts); text(await '+call+');',
            'text(ALL_TOOLS.find(x=>/wait_agent$/.test(x.name))); text(await '+call+');',
            'const result=await '+call+';text(result);',
            'image((await tools.view_image({path:"/image"})).image_url);text(await '+call+');',
            'text((await '+call+').output);',
        ):
            with self.subTest(source=source):
                self.assertEqual(hook.ExecLiterals(source).commands(), [{'cmd':'echo ok','workdir':'/repo'}])
        for source in (
            'await Promise.allSettled(['+call+']).then(r=>tools.exec_command({cmd:"hidden"}));',
            'const tools=await '+call+';text(tools);',
            'const r=await '+call+';r.forEach(x=>tools.exec_command(x));',
        ):
            with self.subTest(source=source), self.assertRaises(hook.Unsupported):
                hook.ExecLiterals(source).commands()

    def test_bulk_rglob_rename_measures_only_changed_matching_files(self):
        (self.cwd / 'app').mkdir()
        (self.cwd / 'app/a.tsx').write_text('INFocus Hub\nvisit the hub\n')
        (self.cwd / 'app/unchanged.ts').write_text('already Portal\n')
        (self.cwd / 'app/ignored.txt').write_text('Hub\n')
        command = r"""python3 - <<'PY'
from pathlib import Path
import re
roots = ['app', 'missing']
for root in roots:
    for p in Path(root).rglob('*'):
        if not p.is_file() or p.suffix not in {'.ts', '.tsx'}:
            continue
        old = p.read_text()
        new = re.sub(r'\bHub\b', 'Portal', old).replace('the hub', 'the portal')
        if new != old:
            p.write_text(new)
PY"""
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.assert_change('app/a.tsx', 2, 2)
        self.assertEqual((self.cwd / 'app/ignored.txt').read_text(), 'Hub\n')

    def test_mkdir_followed_by_heredocs_retains_all_concrete_targets(self):
        command = "mkdir -p nested\ncat > nested/a <<'EOF'\nfirst\nEOF\ncat > nested/b <<'EOF'\nsecond\nEOF\n"
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.assertEqual({Path(c['path']).name for c in self.changes()}, {'a', 'b'})

    def test_bulk_rename_rejects_unsafe_or_unbounded_discovery(self):
        folder = self.cwd / 'app'
        folder.mkdir()
        (folder / 'one.ts').write_text('Hub\n')
        def command(replacement):
            return "python3 - <<'PY'\nfrom pathlib import Path\nimport re\nroots=['app']\nfor root in roots:\n for p in Path(root).rglob('*'):\n  if not p.is_file() or p.suffix not in {'.ts'}:\n   continue\n  old=p.read_text()\n  new=" + replacement + "\n  if new != old:\n   p.write_text(new)\nPY"
        for replacement in ("re.sub('(a+)+', 'x', old)", "re.sub('Hub', lambda m: 'x', old)", "change(old)"):
            paths, wide = hook._capture_command_paths(command(replacement), self.cwd, [])
            self.assertEqual(paths, set())
            self.assertTrue(wide)
        safe = command("old.replace('Hub','Portal')")
        outside = self.base / 'outside.ts'
        outside.write_text('Hub\n')
        (folder / 'linked.ts').symlink_to(outside)
        self.assertTrue(hook._capture_command_paths(safe, self.cwd, [])[1])
        (folder / 'linked.ts').unlink()
        for i in range(65):
            (folder / f'{i}.ts').write_text('Hub\n')
        self.assertTrue(hook._capture_command_paths(safe, self.cwd, [])[1])
        self.assertEqual(outside.read_text(), 'Hub\n')

    def test_bulk_rename_claims_unchanged_files_and_normalizes_read_text_newlines(self):
        folder = self.cwd / 'app'
        folder.mkdir()
        path = folder / 'a.ts'
        script = "python3 - <<'PY'\nfrom pathlib import Path\nroots=['app']\nfor root in roots:\n for p in Path(root).rglob('*'):\n  if not p.is_file() or p.suffix not in {'.ts'}:\n   continue\n  old=p.read_text()\n  new=old.replace('Hub\\n','Portal\\n')\n  if new != old:\n   p.write_text(new)\nPY"
        path.write_bytes(b'Hub\r\n')
        self.assertEqual(self.run_edit(script, 'crlf').returncode, 0)
        self.assert_change('app/a.ts', 1, 1)
        # A bulk writer may start with no matches, then see another writer's
        # update. Its root claim must invalidate the earlier writer's snapshot.
        for item in (self.root / 'completed').glob('*.json'):
            item.unlink()
        path.write_text('Base\n')
        self.pre("printf 'Hub\\n' > app/a.ts", 'first')
        self.pre(script, 'bulk')
        path.write_text('Hub\n')
        self.assertEqual(self.execute(script).returncode, 0)
        self.post('first')
        self.post('bulk')
        self.assertEqual(self.changes(), [])

    def test_bulk_rename_rejects_replacement_names_changed_by_the_loop(self):
        script = "python3 - <<'PY'\nfrom pathlib import Path\nroots=['app']\nnew='Hub'\nfor root in roots:\n for p in Path(root).rglob('*'):\n  if not p.is_file() or p.suffix not in {'.ts'}:\n   continue\n  old=p.read_text()\n  new=old.replace(new,'Portal')\n  if new != old:\n   p.write_text(new)\nPY"
        paths, wide = hook._capture_command_paths(script, self.cwd, [])
        self.assertEqual(paths, set())
        self.assertTrue(wide)

    @unittest.skipUnless(os.environ.get('AGMUX_CODEX_AUDIT_MANIFEST'), 'opt-in frozen transcript corpus')
    def test_frozen_corpus_scope_replay(self):
        manifest = json.loads(Path(os.environ['AGMUX_CODEX_AUDIT_MANIFEST']).read_text())
        results = []
        for session in manifest:
            source = Path(session['path']).read_bytes()
            self.assertLessEqual(len(source), 128 * 1024 * 1024)
            self.assertEqual(hashlib.sha256(source).hexdigest(), session['sha256'])
            accepted = rejected = 0
            for line in source.splitlines():
                row = json.loads(line)
                item = row.get('payload', {})
                if row.get('type') != 'response_item' or item.get('type') != 'custom_tool_call' or item.get('name') != 'exec':
                    continue
                try:
                    calls = hook.ExecLiterals(item.get('input')).commands()
                    self.assertTrue(all(isinstance(call, dict) for call in calls))
                    accepted += 1
                except (ValueError, TypeError):
                    rejected += 1
            results.append({'session': session['id'], 'acceptedWrappers': accepted, 'unsupportedWrappers': rejected})
        self.assertEqual(len(results), len(manifest))
        if destination := os.environ.get('AGMUX_CODEX_SHELL_AUDIT_OUTPUT'):
            Path(destination).write_text(json.dumps(results, indent=2))

    def test_literal_file_loop_and_index_capture_actual_edits(self):
        for name in ('a', 'b'):
            (self.cwd / name).write_text('old\n')
        command = r"""python3 - <<'PY'
from pathlib import Path
files=['a','b']
for name in files:
 p=Path(name); s=p.read_text().replace('old','new'); p.write_text(s)
p=Path(files[0]); s=p.read_text(); p.write_text(s+'extra\n')
PY"""
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.assertEqual({Path(c['path']).name: (c['added'], c['removed']) for c in self.changes()},
                         {'a': (2, 1), 'b': (1, 1)})

    def test_dynamic_or_control_flow_file_loops_remain_unsupported(self):
        for code in (
            "files=get_files();\nfor p in files: Path(p).write_text('x')",
            "files=['a'];\nfor p in files:\n break\nPath(p).write_text('x')",
            "files=['a'];\nfor p in files:\n raise ValueError()\nPath(p).write_text('x')",
            "files=['a']; other=files; other.append('b');\nfor p in files: Path(p).write_text('x')",
            "files=['a']; other=files; other+=['b'];\nfor p in files: Path(p).write_text('x')",
            "files=['a']; Path(files[5]).write_text('x')",
            "files=['a']; Path(files).write_text('x')",
            "files=" + repr(['a'] * 65) + ";\nfor p in files: Path(p).write_text('x')",
            "files=" + repr(['a'] * 64) + ";\nfor p in files:\n for q in files: Path(q).write_text('x')",
        ):
            with self.subTest(code=code), self.assertRaises(hook.Unsupported):
                hook._command_paths(self.command('from pathlib import Path; '+code))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.cwd = self.base / 'work'
        self.cwd.mkdir()
        self.root = self.base / 'shell-diff-hooks'

    def payload(self, command='', tool='one', event='PreToolUse', native=False):
        payload = {'hook_event_name': event, 'session_id': 'parent-session',
                'tool_use_id': tool, 'cwd': str(self.cwd),
                'tool_name': 'apply_patch' if native else 'Bash',
                'tool_input': {'patch': command} if native else {'command': command}}
        if event == 'PreToolUse' and not native:
            self.trace(payload, [self.direct(command, tool)])
        return payload

    def direct(self, command, tool='one', **args):
        return {'type': 'function_call', 'name': 'exec_command', 'call_id': tool,
                'arguments': json.dumps(dict(cmd=command, **args))}

    def wrapper(self, source, tool='outer'):
        return {'type': 'custom_tool_call', 'name': 'exec', 'call_id': tool, 'input': source}

    def trace(self, payload, items):
        path = self.base / ('trace-' + hashlib.sha256(payload['tool_use_id'].encode()).hexdigest())
        path.write_text(''.join(json.dumps({'type': 'response_item', 'payload': item}) + '\n'
                                for item in items))
        payload['transcript_path'] = str(path)
        return path

    def pre(self, command, tool='one', native=False):
        self.assertTrue(callable(getattr(hook, 'handle', None)), 'handle is implemented')
        hook.handle(self.payload(command, tool, native=native), self.root)

    def post(self, tool='one', **extra):
        payload = self.payload(tool=tool, event='PostToolUse')
        payload.update(extra)
        hook.handle(payload, self.root)

    def records(self):
        return [json.loads(p.read_text()) for p in sorted((self.root / 'completed').glob('*.json'))]

    def changes(self):
        return [change for record in self.records() for change in record['changes']]

    def command(self, code):
        return 'python3 -c ' + shlex.quote(code)

    def execute(self, command):
        return subprocess.run(command, cwd=self.cwd, shell=isinstance(command, str),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def run_edit(self, command, tool='one'):
        self.pre(command, tool)
        result = self.execute(command)
        self.post(tool)
        return result

    def assert_change(self, path, added, removed):
        self.assertEqual(self.changes(), [{'path': str(self.cwd / path),
                                          'added': added, 'removed': removed}])

    def git_repo(self):
        subprocess.run(['git', 'init', '-q', str(self.cwd)], check=True)
        (self.cwd / 'a').write_text('old\n')
        subprocess.run(['git', '-C', str(self.cwd), 'add', 'a'], check=True)
        subprocess.run(['git', '-C', str(self.cwd), '-c', 'user.name=Test',
                        '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial'], check=True)

    def test_registered_worktree_edits_keep_native_session_and_capture_root(self):
        self.git_repo()
        worktree = self.base / 'worktree'
        subprocess.run(['git', '-C', str(self.cwd), 'worktree', 'add', '-q', '--detach', str(worktree)], check=True)
        stale = self.base / 'stale-worktree'
        subprocess.run(['git', '-C', str(self.cwd), 'worktree', 'add', '-q', '--detach', str(stale)], check=True)
        shutil.rmtree(stale)  # An unrelated stale Git registration must not hide the valid worktree.
        command = "printf 'new\\nextra\\n' > a"
        payload = self.payload(command)
        self.trace(payload, [self.direct(command, workdir=str(worktree))])
        hook.handle(payload, self.root)
        subprocess.run(command, shell=True, cwd=worktree, check=True)
        self.post()
        self.assertEqual(self.changes(), [{'path': str(worktree / 'a'), 'added': 2, 'removed': 1}])
        self.assertEqual(self.records()[0]['sessionId'], 'parent-session')
        self.assertEqual(self.records()[0]['cwd'], str(worktree))
        self.assertEqual((self.cwd / 'a').read_text(), 'old\n')

    def test_git_apply_measures_files_once_and_respects_exclusions(self):
        self.git_repo()
        patch_file = self.base / 'changes.patch'
        patch_file.write_text('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n'
                              'diff --git a/skipped b/skipped\nnew file mode 100644\n--- /dev/null\n+++ b/skipped\n@@ -0,0 +1 @@\n+skip\n')
        command = 'git apply --exclude=skipped ' + shlex.quote(str(patch_file))
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.post()
        self.assert_change('a', 2, 1)

    def test_explicit_other_repository_workdir_keeps_session_attribution(self):
        self.git_repo()
        other = self.base / 'other'
        subprocess.run(['git', 'init', '-q', str(other)], check=True)
        command = "printf 'new\\n' > a"
        payload = self.payload(command)
        self.trace(payload, [self.direct(command, workdir=str(other))])
        hook.handle(payload, self.root)
        (other / 'a').write_text('new\n')
        self.post()
        self.assertEqual(self.changes(), [{'path': str(other / 'a'), 'added': 1, 'removed': 0}])
        self.assertEqual(self.records()[0]['sessionId'], 'parent-session')

    def test_website_manifest_copy_and_backup_capture_destination_repo(self):
        self.git_repo()
        website = self.base / 'website'
        subprocess.run(['git', 'init', '-q', str(website)], check=True)
        (website / 'hero.tsx').write_text('old\n')
        preview = self.base / 'preview'
        preview.mkdir()
        (preview / 'hero.tsx').write_text('new\nextra\n')
        (preview / 'notes.md').write_text('notes\n')
        manifest = self.base / 'files.json'
        manifest.write_text(json.dumps(['hero.tsx']))
        backup = self.base / 'backup'
        command = f"""python3 - <<'PY'
import json,shutil
from pathlib import Path
src=Path({str(preview)!r});dst=Path({str(website)!r})
files=json.loads(Path({str(manifest)!r}).read_text())+['notes.md']
backup=Path({str(backup)!r});backup.mkdir(exist_ok=True)
for name in files:
 target=dst/name
 if target.exists():
  saved=backup/name;saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,saved)
 target.parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(src/name,target)
PY
"""
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.post()
        self.assertEqual({c['path']: (c['added'], c['removed']) for c in self.changes()},
                         {str(website / 'hero.tsx'): (2, 1), str(website / 'notes.md'): (1, 0)})
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.records()[0]['cwd'], str(website))
        self.assertEqual((backup / 'hero.tsx').read_text(), 'old\n')

    def test_reported_copy_apply_and_python_sequence_measures_actual_changes(self):
        self.git_repo()
        source = self.base / 'source'
        source.mkdir()
        (source / 'copied').write_text('copied\n')
        patch_file = self.base / 'changes.patch'
        patch_file.write_text('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n')
        command = f"""python3 - <<'PY'
from pathlib import Path
source=Path({str(source)!r}); dest=Path({str(self.cwd)!r})
for name in ['copied']:
 target=dest/name
 if target.exists():raise SystemExit('already exists: '+name)
for name in ['copied']:
 (dest/name).write_bytes((source/name).read_bytes())
PY
git apply {shlex.quote(str(patch_file))}
python3 - <<'PY'
from pathlib import Path
Path('notes').write_text('notes\\n')
PY
git diff --check
"""
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.assertEqual({Path(c['path']).name: (c['added'], c['removed']) for c in self.changes()},
                         {'a': (1, 1), 'copied': (1, 0), 'notes': (1, 0)})

    def test_multi_repository_edits_publish_separate_roots_without_duplicate_counts(self):
        self.git_repo()
        other = self.base / 'other'
        subprocess.run(['git', 'init', '-q', str(other)], check=True)
        command = self.command(f"from pathlib import Path; Path('a').write_text('new\\n'); Path({str(other / 'b')!r}).write_text('second\\n')")
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.post()
        self.assertEqual({r['cwd'] for r in self.records()}, {str(self.cwd), str(other)})
        self.assertEqual({r['sessionId'] for r in self.records()}, {'parent-session'})
        self.assertEqual(len(self.changes()), 2)
        for record in self.records():
            self.assertTrue(all(Path(c['path']).is_relative_to(record['cwd']) for c in record['changes']))

    def test_external_targets_need_exact_request_and_respect_foreign_writers(self):
        self.git_repo()
        other = self.base / 'other'
        subprocess.run(['git', 'init', '-q', str(other)], check=True)
        command = self.command(f"from pathlib import Path; Path({str(other / 'a')!r}).write_text('new\\n')")
        payload = self.payload(command, 'missing')
        payload.pop('transcript_path')
        hook.handle(payload, self.root)
        self.assertEqual(self.execute(command).returncode, 0)
        self.post('missing')
        self.assertEqual(self.changes(), [])
        self.pre(command, 'known')
        foreign = self.payload('unknown-writer', 'foreign')
        foreign.update(cwd=str(other), session_id='other-session')
        hook.handle(foreign, self.root)
        (other / 'a').write_text('changed\n')
        self.post('known')
        self.assertEqual(self.changes(), [])

    def test_changed_manifest_suppresses_partial_counts(self):
        self.git_repo()
        source = self.base / 'source'
        source.mkdir()
        for name in ('a', 'b'):
            (source / name).write_text('new\n')
        manifest = self.base / 'files.json'
        manifest.write_text(json.dumps(['a']))
        command = self.command(f"""import json,shutil
from pathlib import Path
names=json.loads(Path({str(manifest)!r}).read_text())
for name in names:
 shutil.copy2(Path({str(source)!r})/name,Path({str(self.cwd)!r})/name)
""")
        self.pre(command)
        manifest.write_text(json.dumps(['a', 'b']))
        self.assertEqual(self.execute(command).returncode, 0)
        self.post()
        self.assertEqual((self.cwd / 'a').read_text(), 'new\n')
        self.assertEqual(self.changes(), [])

    def test_external_native_patch_blocks_overlapping_shell_capture(self):
        self.git_repo()
        other = self.base / 'other'
        subprocess.run(['git', 'init', '-q', str(other)], check=True)
        path = other / 'a'
        command = self.command(f"from pathlib import Path; Path({str(path)!r}).write_text('shell\\n')")
        self.pre(command, 'shell')
        self.pre(f'*** Begin Patch\n*** Add File: {path}\n+native\n*** End Patch', 'native', native=True)
        path.write_text('native\n')
        self.post('native')
        self.post('shell')
        self.assertEqual(self.changes(), [])

    def test_manifest_bounds_and_copy_directory_destinations_fail_closed(self):
        manifest = self.base / 'files.json'
        for names in (['../escape'], ['/absolute'], [{'path': 'a'}], ['a'] * 65):
            manifest.write_text(json.dumps(names))
            code = f"import json; from pathlib import Path; names=json.loads(Path({str(manifest)!r}).read_text())"
            with self.subTest(names=names), self.assertRaises(hook.Unsupported):
                hook._command_paths(self.command(code))
        with self.assertRaises(hook.Unsupported):
            hook._command_paths(self.command(f"import shutil; shutil.copy2('/source', {str(self.cwd)!r})"))

    def test_git_apply_changed_input_and_dry_run_do_not_earn_counts(self):
        self.git_repo()
        patch_file = self.base / 'changes.patch'
        patch_file.write_text('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n')
        command = 'git apply ' + shlex.quote(str(patch_file))
        self.assertEqual(self.run_edit(command.replace('apply ', 'apply --check '), 'check').returncode, 0)
        self.assertEqual(self.changes(), [])
        self.pre(command, 'changed')
        patch_file.write_text(patch_file.read_text().replace('+new', '+different'))
        self.assertEqual(self.execute(command).returncode, 0)
        self.post('changed')
        self.assertEqual(self.changes(), [])

    def test_git_apply_add_delete_spaces_and_failed_repeat(self):
        self.git_repo()
        patch_file = self.base / 'changes.patch'
        patch_file.write_text('diff --git a/a b/a\ndeleted file mode 100644\n--- a/a\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'
                              'diff --git a/new file b/new file\nnew file mode 100644\n--- /dev/null\n+++ b/new file\n@@ -0,0 +1 @@\n+new\n')
        command = 'git apply ' + shlex.quote(str(patch_file))
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.assertEqual({Path(c['path']).name: (c['added'], c['removed']) for c in self.changes()},
                         {'a': (0, 1), 'new file': (1, 0)})
        self.assertNotEqual(self.run_edit(command, 'repeat').returncode, 0)
        self.assertEqual(len(self.records()), 1)

    def test_git_apply_from_subdirectory_uses_repository_relative_numstat_paths(self):
        self.git_repo()
        sub = self.cwd / 'sub'
        sub.mkdir()
        patch_file = self.base / 'sub.patch'
        patch_file.write_text('diff --git a/sub/a b/sub/a\nnew file mode 100644\n--- /dev/null\n+++ b/sub/a\n@@ -0,0 +1 @@\n+new\n')
        command = 'git apply ' + shlex.quote(str(patch_file))
        payload = self.payload(command)
        self.trace(payload, [self.direct(command, workdir=str(sub))])
        hook.handle(payload, self.root)
        subprocess.run(command, shell=True, cwd=sub, check=True)
        self.post()
        self.assert_change('sub/a', 1, 0)

    def test_unknown_suffix_stops_scope_discovery_but_keeps_wide_guard(self):
        command = "python3 - <<'PY'\nopen('a','w')\nPY\ncd ../outside\npython3 - <<'PY'\nopen('not-here','w')\nPY\n"
        self.pre(command)
        entry = next(iter(json.loads((self.root / 'state.json').read_text()).values()))
        self.assertEqual(entry['paths'], [str(self.cwd / 'a')])
        self.assertTrue(entry['wide'])
        self.post()

    def test_immediate_python_heredoc_captures_actual_before(self):
        (self.cwd / 'a.py').write_text('old\nkeep\n')
        command = """python3 - <<'PY'
from pathlib import Path
p = Path('a.py')
text = '''new
keep
tail
'''
p.write_text(('prefix' + text)[6:])
PY
"""
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.assert_change('a.py', 2, 1)
        record = self.records()[0]
        self.assertEqual(set(record), {'sessionId', 'toolId', 'cwd', 'changes'})
        self.assertEqual(record['sessionId'], 'parent-session')
        key = hashlib.sha256(b'parent-sessionone').hexdigest()
        self.assertTrue((self.root / 'completed' / (key + '.json')).exists())
        self.assertNotIn('prefix', json.dumps(record))

    def test_literal_path_assignments_open_append_and_keyword_mode(self):
        (self.cwd / 'a').write_text('first\n')
        code = "p = 'a'; f = open(p, mode='a'); f.write('second\\n'); f.close()"
        self.assertEqual(self.run_edit(self.command(code)).returncode, 0)
        self.assert_change('a', 1, 0)

    def test_path_read_modify_write_content_not_evaluated(self):
        (self.cwd / 'a').write_text('old\n')
        code = "from pathlib import Path; p = Path('a'); s = p.read_text(); p.write_text(s.replace('old', 'new'))"
        self.run_edit(self.command(code))
        self.assert_change('a', 1, 1)

    def test_regex_content_edits_keep_literal_targets_without_evaluating_content(self):
        (self.cwd / 'a.js').write_text('const done = true;\n')
        (self.cwd / 'index.html').write_text('<script src="/assets/app.js?v=old">\n')
        code = r"""from pathlib import Path
p = Path('a.js')
s = p.read_text()
import re
s = re.sub('done', 'active', s)
p.write_text(s)
p = Path('index.html')
s = re.sub(r'\?v=\w+', '?v=new', p.read_text())
p.write_text(s)
"""
        self.assertEqual(self.run_edit(self.command(code)).returncode, 0)
        self.assertEqual(self.changes(), [
            {'path': str(self.cwd / 'a.js'), 'added': 1, 'removed': 1},
            {'path': str(self.cwd / 'index.html'), 'added': 1, 'removed': 1}])
        self.assertFalse(next(iter(json.loads((self.root / 'state.json').read_text()).values()))['wide'])

    def test_regex_sub_rejects_callables_and_shadowed_modules(self):
        for code in [
            "import re; re.sub('x', lambda match: open('a', 'w').write('bad'), 'x')",
            "import re; replacement = input(); re.sub('x', replacement, 'x'); open('a', 'w')",
            "import re; re = input(); re.sub('x', 'new', 'x'); open('a', 'w')",
            "import re; re.sub('x', 'new', 'x', **options); open('a', 'w')",
            "import re; from pathlib import Path; re.sub(*['x', Path('other').unlink], 'x'); Path('a').write_text('new')",
            "import os; os.chdir('sub'); open('a', 'w')",
            "from pathlib import Path; p=Path('a'); s=exec(\"p=Path('b')\"); p.write_text('new')",
        ]:
            with self.subTest(code=code), self.assertRaises(hook.Unsupported):
                hook._command_paths(self.command(code))

    def test_regex_alias_and_literal_replacement_binding(self):
        code = "import re as regex; replacement='new\\n'; result=regex.sub(pattern='old', repl=replacement, string='old'); open('a', 'w').write(result)"
        self.assertEqual(self.run_edit(self.command(code)).returncode, 0)
        self.assert_change('a', 1, 0)

    def test_python_augmented_content_and_path_bindings(self):
        (self.cwd / 'a').write_text('old\n')
        command = self.command("from pathlib import Path; p = 'a'; s = Path(p).read_text(); "
                               "s += 'tail\\n'; Path(p).write_text(s); "
                               "p += '.new'; Path(p).write_text('created\\n')")
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.assertEqual(self.changes(), [
            {'path': str(self.cwd / 'a'), 'added': 1, 'removed': 0},
            {'path': str(self.cwd / 'a.new'), 'added': 1, 'removed': 0}])

    def test_python_augmented_unknown_path_does_not_keep_old_binding(self):
        code = "from pathlib import Path; p = 'a'; p += Path('suffix').read_text(); Path(p).write_text('new')"
        with self.assertRaises(hook.Unsupported):
            hook._command_paths(self.command(code))

    def test_index_triple_quote_slice_chained_replace_multiple_targets(self):
        subprocess.run(['git', 'init', '-q', str(self.cwd)], check=True)
        (self.cwd / 'a').write_text('start\nold\nend\n')
        (self.cwd / 'b').write_text('before\n')
        python = """python3 - <<'PY'
p='a';s=open(p).read();a=s.index('old');b=s.index('end',a)
s=s[:a]+'''new
inserted
'''+s[b:];open(p,'w').write(s)
p='b';s=open(p).read().replace('before','middle').replace('middle','after')
old='after';new='done';assert old in s;s=s.replace(old,new);open(p,'w').write(s)
PY
"""
        command = python + 'npm run test -- test.ts > /tmp/unused-test-output.log 2>&1'
        self.pre(command)
        # Only execute the isolated Python fixture, never the real repo/test command.
        self.assertEqual(self.execute(python).returncode, 0)
        self.post()
        self.assertEqual(self.changes(), [
            {'path': str(self.cwd / 'a'), 'added': 2, 'removed': 1},
            {'path': str(self.cwd / 'b'), 'added': 1, 'removed': 1}])

    def test_literal_trailing_commands_add_their_concrete_targets(self):
        command = "python3 - <<'PY'\nopen('a', 'w')\nPY\ncat > suffix-file"
        self.pre(command)
        (self.cwd / 'a').write_text('known\n')
        (self.cwd / 'suffix-file').write_text('also a candidate\n')
        self.post()
        self.assertEqual({Path(c['path']).name: (c['added'], c['removed']) for c in self.changes()},
                         {'a': (1, 0), 'suffix-file': (1, 0)})

    def test_with_open_and_argv(self):
        command = [sys.executable, '-c', "p = 'new file';\nwith open(p, 'w') as f:\n f.write('a\\nb\\n')"]
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.assert_change('new file', 2, 0)

    def test_json_command_and_shell_argv(self):
        command = self.command("open('a', 'w').write('one\\n')")
        self.pre(json.dumps(['bash', '-lc', command]))
        self.execute(command)
        self.post()
        self.assert_change('a', 1, 0)

    def test_json_tool_input(self):
        payload = self.payload()
        payload['tool_input'] = json.dumps({'command': self.command("open('a', 'w')")})
        self.trace(payload, [self.direct(self.command("open('a', 'w')"))])
        hook.handle(payload, self.root)
        (self.cwd / 'a').write_text('a\n')
        self.post()
        self.assert_change('a', 1, 0)

    def test_known_command_cwd_override_and_unknown_scope_skip(self):
        sub = self.cwd / 'sub'
        sub.mkdir()
        payload = self.payload()
        payload['tool_input']['command'] = json.dumps({
            'cmd': self.command("open('a', 'w')"), 'workdir': str(sub)})
        self.trace(payload, [self.direct(self.command("open('a', 'w')"), workdir=str(sub))])
        hook.handle(payload, self.root)
        (sub / 'a').write_text('new\n')
        self.post()
        self.assert_change('sub/a', 1, 0)
        self.assertEqual(self.records()[0]['cwd'], str(self.cwd))
        payload = self.payload(self.command("open('b', 'w')"), 'unknown')
        payload['tool_input']['workdir'] = {'dynamic': True}
        hook.handle(payload, self.root)
        (self.cwd / 'b').write_text('unattributed\n')
        self.post('unknown')
        self.assert_change('sub/a', 1, 0)

    def test_raw_direct_and_nested_workdir_omitted_from_hook(self):
        sub = self.cwd / 'override'
        sub.mkdir()
        for index, mode in enumerate(('direct', 'json', 'js', 'shell')):
            with self.subTest(mode=mode):
                name = 'file' + str(index)
                control = self.cwd / name
                control.write_text('control must stay unchanged\n')
                (sub / name).write_text('old\n')
                command = self.command('open(%r, "w").write("new\\ntwo\\n")' % name)
                tool = 'one' if mode == 'direct' else 'exec-00000000-0000-0000-0000-00000000000' + str(index)
                payload = self.payload(command, tool)
                args = json.dumps({'cmd': command, 'workdir': str(sub), 'login': False})
                if mode == 'direct':
                    item = self.direct(command, tool, workdir=str(sub))
                else:
                    if mode == 'js':
                        args = args.replace('"cmd":', 'cmd:').replace('"workdir":', 'workdir:')
                    if mode == 'shell':
                        args = args.replace('"cmd":', '"command":')
                    method = 'shell_command' if mode == 'shell' else 'exec_command'
                    item = self.wrapper('text(await tools.' + method + '(' + args + '));')
                self.trace(payload, [item])
                original_payload = json.dumps(payload, sort_keys=True)
                hook.handle(payload, self.root)
                self.assertEqual(json.dumps(payload, sort_keys=True), original_payload)
                result = subprocess.run(command, cwd=sub, shell=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.post(tool)
                self.assertEqual(control.read_text(), 'control must stay unchanged\n')
                self.assertIn({'path': str(sub / name), 'added': 2, 'removed': 1}, self.changes())
                self.assertNotIn(str(control), [c['path'] for c in self.changes()])

    def test_missing_trace_rejects_relative_but_keeps_absolute_session_target(self):
        for index, name in enumerate(('relative', str(self.cwd / 'absolute'))):
            command = self.command('open(%r, "w").write("new\\n")' % name)
            payload = self.payload(command, str(index))
            payload.pop('transcript_path')
            hook.handle(payload, self.root)
            self.execute(command)
            self.post(str(index))
        self.assert_change('absolute', 1, 0)

    def test_effective_workdir_does_not_expand_allowed_workspace(self):
        outside = self.base / 'outside'
        outside.mkdir()
        inside = self.cwd / 'absolute'
        command = self.command('open("relative", "w").write("outside\\n"); '
                               'open(%r, "w").write("inside\\n")' % str(inside))
        payload = self.payload(command)
        self.trace(payload, [self.direct(command, workdir=str(outside))])
        hook.handle(payload, self.root)
        result = subprocess.run(command, cwd=outside, shell=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.post()
        self.assert_change('absolute', 1, 0)
        self.assertEqual(self.records()[0]['cwd'], str(self.cwd))

    def test_nested_only_one_distinct_matching_cwd_and_active_sources(self):
        sub = self.cwd / 'sub'
        sub.mkdir()
        command = self.command("open('a', 'w')")
        tool = 'exec-11111111-1111-1111-1111-111111111111'
        payload = self.payload(command, tool)
        def source(args):
            return 'text(await tools.exec_command(' + json.dumps(args) + '));'
        default = self.wrapper(source({'cmd': command}))
        override = self.wrapper(source({'cmd': command, 'workdir': 'sub'}), 'override')
        unrelated = self.wrapper(source({'cmd': 'echo unrelated', 'workdir': 'sub'}), 'other')
        finished = {'type': 'custom_tool_call_output', 'call_id': 'override', 'output': 'done'}
        for items, expected in (([default], self.cwd), ([default, override], None),
                                ([default, unrelated], self.cwd),
                                ([default, override, finished], self.cwd),
                                ([override, finished], None),
                                ([self.wrapper(source({'cmd': command}) * 2)], self.cwd)):
            with self.subTest(items=items):
                self.trace(payload, items)
                self.assertEqual(hook._effective_cwd(payload, self.cwd, command), expected)

    def test_direct_requires_exact_active_id_name_and_command(self):
        command = self.command("open('a', 'w')")
        payload = self.payload(command)
        for items in ([self.direct(command, 'wrong')],
                      [dict(self.direct(command), name='unknown')],
                      [self.direct('echo other')],
                      [self.direct(command), {'type': 'function_call_output', 'call_id': 'one'}],
                      [self.direct(command, workdir={'dynamic': True})],
                      [self.direct(command, workdir='/nonexistent-agmux-cwd')]):
            with self.subTest(items=items):
                self.trace(payload, items)
                self.assertIsNone(hook._effective_cwd(payload, self.cwd, command))

    def test_ambiguous_raw_pre_skips_relative_and_keeps_absolute_target(self):
        sub = self.cwd / 'sub'
        sub.mkdir()
        command = self.command('open("relative", "w").write("unknown\\n"); '
                               'open(%r, "w").write("known\\n")' % str(self.cwd / 'absolute'))
        tool = 'exec-11111111-1111-1111-1111-111111111111'
        payload = self.payload(command, tool)
        source = ''.join('text(await tools.exec_command(' + json.dumps(args) + '));'
                         for args in ({'cmd': command}, {'cmd': command, 'workdir': str(sub)}))
        self.trace(payload, [self.wrapper(source)])
        hook.handle(payload, self.root)
        self.assertEqual(self.execute(command).returncode, 0)
        self.post(tool)
        self.assert_change('absolute', 1, 0)

    def test_sequential_literals_ignore_metadata_quotes_comments_and_other_tools(self):
        command = self.command("open('a', 'w')")
        payload = self.payload(command, 'exec-11111111-1111-1111-1111-111111111111')
        actual = 'text(await tools.exec_command({cmd:' + json.dumps(command) + '}));'
        fake = 'text(await tools.exec_command({cmd:' + json.dumps(command) + ',workdir:"/tmp"}));'
        source = '// ' + fake + '\n/* ' + fake + ' */\ntext(' + json.dumps(fake) + ');\n'
        source += "text(await tools.memory_add({title:'metadata', content:'literal', values:[true,null,3]}));\n"
        source += actual + 'await tools.shell_command({command:"echo other"});'
        self.trace(payload, [self.wrapper(source)])
        self.assertEqual(hook._effective_cwd(payload, self.cwd, command), self.cwd)
        for source in ('// ' + fake, '/* ' + fake + ' */', 'text(' + json.dumps(fake) + ');'):
            self.trace(payload, [self.wrapper(source)])
            self.assertIsNone(hook._effective_cwd(payload, self.cwd, command))

    def test_dynamic_or_unknown_wrapper_rejects_even_with_literal_match(self):
        command = self.command("open('a', 'w')")
        payload = self.payload(command, 'exec-11111111-1111-1111-1111-111111111111')
        literal = 'text(await tools.exec_command({cmd:' + json.dumps(command) + '}));'
        unknown = [
            'const cmd = "echo other"; ' + literal,
            'if (true) {' + literal + '}',
            'for (;;) {' + literal + '}',
            literal + 'await tools.exec_command({cmd: variable});',
            literal + 'await tools.exec_command({cmd:"other", workdir: variable});',
            literal + 'await tools.exec_command({...args});',
            literal + 'await tools.exec_command({cmd:`template${variable}`});',
            literal + 'text(variable);',
            literal.replace('await tools', 'awaittools'),
            literal.replace('{cmd:', '{get cmd() {return '),
            literal.replace('{cmd:', '{cmd:"other",cmd:'),
            'Promise.all([' + literal + ']);',
        ]
        for source in unknown:
            with self.subTest(source=source):
                self.trace(payload, [self.wrapper(source)])
                self.assertIsNone(hook._effective_cwd(payload, self.cwd, command))
        self.trace(payload, [self.wrapper(literal), self.wrapper(unknown[0], 'dynamic')])
        self.assertIsNone(hook._effective_cwd(payload, self.cwd, command))

    def test_literal_template_commands_capture_real_before_and_after(self):
        (self.cwd / 'a').write_text('old\n')
        command = "python3 - <<'PY'\nfrom pathlib import Path\nPath('a').write_text('new\\n')\nPY"
        payload = self.payload(command, 'exec-11111111-1111-4111-8111-111111111111')
        source = 'text(await tools.exec_command({cmd:`' + command.replace('\\', '\\\\') + '`}));'
        self.trace(payload, [self.wrapper(source)])
        self.assertEqual(hook._effective_cwd(payload, self.cwd, command), self.cwd)
        hook.handle(payload, self.root)
        self.assertEqual(self.execute(command).returncode, 0)
        self.post(payload['tool_use_id'])
        self.assert_change('a', 1, 1)

    def test_unresolved_relative_write_keeps_collision_protection(self):
        command = self.command("open('a', 'w').write('new\\n')")
        payload = self.payload(command, 'exec-11111111-1111-4111-8111-111111111111')
        self.trace(payload, [self.wrapper('text(await tools.exec_command({cmd: unknown}));')])
        hook.handle(payload, self.root)
        state = json.loads((self.root / 'state.json').read_text())
        entry = state[hashlib.sha256(('parent-session' + payload['tool_use_id']).encode()).hexdigest()]
        self.assertEqual(entry['paths'], [])
        self.assertTrue(entry['wide'])

    def test_pure_result_print_loops_do_not_hide_preceding_commands(self):
        call = 'tools.exec_command({cmd:"echo known",workdir:"/repo"})'
        for suffix in ('results.forEach((r,i)=>text({i,...r}));',
                       'for(let i=0;i<results.length;i++)text({i,...results[i]});'):
            source = 'const results=await Promise.allSettled([' + call + ']);' + suffix
            self.assertEqual(hook.ExecLiterals(source).commands(), [{'cmd':'echo known','workdir':'/repo'}])
        source = 'for(const result of await Promise.allSettled([' + call + ']))text(result);'
        self.assertEqual(hook.ExecLiterals(source).commands(), [{'cmd':'echo known','workdir':'/repo'}])

    def test_literal_poll_loop_does_not_hide_a_write_in_the_same_wrapper(self):
        prefix = 'text(await tools.exec_command({cmd:"echo known"}));'
        for loop in ('for(const session_id of [99265,89972])text(await tools.write_stdin({session_id,chars:"",yield_time_ms:1000}));',
                     'for (const id of [82774,96611]) text(await tools.write_stdin({session_id:id,chars:""}));'):
            self.assertEqual(hook.ExecLiterals(prefix + loop).commands(), [{'cmd':'echo known'}])

    def test_literal_command_maps_keep_every_possible_working_directory(self):
        for source in (
            'await Promise.allSettled(["echo first","echo second"].map(async cmd=>text({cmd,...await tools.exec_command({cmd,workdir:"/repo"})})));',
            'await Promise.allSettled([["one","echo first"],["two","echo second"]].map(async ([label,cmd])=>text({label,...await tools.exec_command({cmd,workdir:"/repo"})})));',
        ):
            self.assertEqual(hook.ExecLiterals(source).commands(), [{'cmd':'echo first','workdir':'/repo'}, {'cmd':'echo second','workdir':'/repo'}])

    def test_loop_capture_grammar_rejects_mutations_shadowing_and_dynamic_inputs(self):
        for source in (
            'for(const tools of [1])text(await tools.write_stdin({session_id:tools,chars:""}));',
            'for(const id of ids)text(await tools.write_stdin({session_id:id,chars:""}));',
            'for(const id of [1])text(await tools.write_stdin({session_id:id,chars:"run"}));',
            'const r=await Promise.allSettled([tools.exec_command({cmd:"known"})]);r.forEach((x,i)=>tools.exec_command({cmd:"hidden"}));',
            'await Promise.allSettled(["echo"].map(async tools=>text({tools,...await tools.exec_command({cmd:tools})})));',
            'await Promise.allSettled([dynamic].map(async cmd=>text({cmd,...await tools.exec_command({cmd})})));',
        ):
            with self.subTest(source=source), self.assertRaises(ValueError):
                hook.ExecLiterals(source).commands()

    def test_read_only_inspection_commands_do_not_claim_unknown_writes(self):
        for command in ["rg -n 'needle' src", "rg --files -g '*.ts'", "head -40 a", "tail -n 30 a",
                        "wc -l a", "sed -n '2,40p' a", "sed -n '40,$p' a", "rg -n needle src | head -20"]:
            with self.subTest(command=command):
                paths, wide = hook._capture_command_paths(command, self.cwd, [])
                self.assertEqual(paths, set())
                self.assertFalse(wide)
        for command in ["rg --pre tool needle a", "rg --pre=tool needle a", "rg --hostname-bin tool needle a",
                        "rg -z needle a", "sed -n '1w output' a", "sed -n 'e command' a", "head a | sh"]:
            with self.subTest(command=command):
                _, wide = hook._capture_command_paths(command, self.cwd, [])
                self.assertTrue(wide)
        paths, wide = hook._capture_command_paths('head -n 10 a > b', self.cwd, [])
        self.assertEqual(paths, {'b'})
        self.assertFalse(wide)

    def test_template_literal_decoding_matches_javascript_cooked_text(self):
        for literal, expected in [
            ('`line1\r\nline2\rline3`', 'line1\nline2\nline3'),
            (r'`quote\` dollar\${name} slash\\`', 'quote` dollar${name} slash\\'),
            (r'`\x41\u0042\u{1f600}\ud83d\ude00\v\0`', 'AB😀😀\v\0'),
            ('`joined\\\nline`', 'joinedline'),
            ('`joined\\\r\nline`', 'joinedline'),
        ]:
            with self.subTest(literal=literal):
                self.assertEqual(hook.ExecLiterals('text(await tools.exec_command({cmd:' + literal + '}));').commands(), [{'cmd':expected}])
        for literal in ['`dynamic${value}`', r'`bad\xZ1`', r'`bad\uXYZW`', r'`bad\u{110000}`', r'`bad\1`', r'`bad\08`', r'`bad\ud800`', '`unfinished']:
            with self.subTest(literal=literal), self.assertRaises(ValueError):
                hook.ExecLiterals('text(await tools.exec_command({cmd:' + literal + '}));').commands()

    def test_literal_parallel_validation_preserves_edit_scope(self):
        command = self.command("open('a', 'w').write('new\\n')")
        tool = 'exec-11111111-1111-1111-1111-111111111111'
        payload = self.payload(command, tool)
        call = 'text(await tools.exec_command(' + json.dumps({'cmd': command}) + '))'
        source = call + ';\nawait Promise.allSettled([\n' + ',\n'.join(
            '(async()=>text(await tools.exec_command(' + json.dumps({'cmd': cmd}) + ')))()'
            for cmd in ('npm run typecheck', 'npm run lint')) + '\n]);'
        self.trace(payload, [self.wrapper(source)])
        hook.handle(payload, self.root)
        self.assertEqual(self.execute(command).returncode, 0)
        self.post(tool)
        self.assert_change('a', 1, 0)

    def test_parallel_literals_require_unambiguous_scope_and_literal_calls(self):
        (self.cwd / 'sub').mkdir()
        command = self.command("open('a', 'w')")
        payload = self.payload(command, 'exec-11111111-1111-1111-1111-111111111111')
        call = 'tools.exec_command(' + json.dumps({'cmd': command}) + ')'
        override = 'tools.exec_command(' + json.dumps({'cmd': command, 'workdir': 'sub'}) + ')'
        for source, expected in (
                ('await Promise.all([' + call + ']);', self.cwd),
                ('await Promise.allSettled([' + call + ',' + override + ']);', None),
                ('await Promise.allSettled([(async()=>text(await ' + call + '))()]);', self.cwd),
                ('await Promise.allSettled([' + call + ',...unknown]);', None),
                ('await Promise.allSettled([' + call + ',tools.exec_command(args)]);', None),
                ('await Promise.allSettled([(async()=>{if (false) {text(await ' + call + ');}})()]);', None),
                ('text(' + json.dumps('await Promise.all([' + call + ']);') + ');', None)):
            with self.subTest(source=source):
                self.trace(payload, [self.wrapper(source)])
                self.assertEqual(hook._effective_cwd(payload, self.cwd, command), expected)

    def test_tool_discovery_metadata_does_not_hide_edit_scope(self):
        command = self.command("open('a', 'w').write('new\\n')")
        tool = 'exec-11111111-1111-1111-1111-111111111111'
        payload = self.payload(command, tool)
        source = 'text(await tools.exec_command(' + json.dumps({'cmd': command}) + '));\n'
        source += 'text(ALL_TOOLS.filter(x=>/session_upsert|memory_list/.test(x.name)));'
        self.trace(payload, [self.wrapper(source)])
        hook.handle(payload, self.root)
        self.assertEqual(self.execute(command).returncode, 0)
        self.post(tool)
        self.assert_change('a', 1, 0)
        for unsafe in [
                'ALL_TOOLS.filter(x=>tools.exec_command({cmd:"other"}))',
                'ALL_TOOLS.filter(x=>/name/.test(y.name))',
                'ALL_TOOLS.filter(x=>/name/.test(x.name) && tools.exec_command({cmd:"other"}))']:
            self.trace(payload, [self.wrapper(source + 'text(' + unsafe + ');')])
            self.assertIsNone(hook._effective_cwd(payload, self.cwd, command))

    def test_trace_complete_lines_bounded_tail_and_finished_turn(self):
        command = self.command("open('a', 'w')")
        payload = self.payload(command)
        path = self.trace(payload, [self.direct(command)])
        request = path.read_bytes()
        path.write_bytes(b'x' * hook.MAX_TRANSCRIPT_BYTES + b'\n' + request + b'{"type":')
        self.assertEqual(hook._effective_cwd(payload, self.cwd, command), self.cwd)
        path.write_bytes(request.rstrip(b'\n'))
        self.assertIsNone(hook._effective_cwd(payload, self.cwd, command))
        path.write_bytes(request + b' ' * hook.MAX_TRANSCRIPT_BYTES + b'\n')
        self.assertIsNone(hook._effective_cwd(payload, self.cwd, command))
        path.write_bytes(request + json.dumps({'type': 'event_msg', 'payload': {'type': 'task_complete'}}).encode() + b'\n')
        self.assertIsNone(hook._effective_cwd(payload, self.cwd, command))

    def test_yielded_code_cell_keeps_source_for_later_nested_calls(self):
        command = self.command("open('a', 'w')")
        payload = self.payload(command, tool='exec-11111111-1111-1111-1111-111111111111')
        source = 'text(await tools.exec_command({cmd:' + json.dumps(command) + '}));'
        output = {'type': 'custom_tool_call_output', 'call_id': 'outer',
                  'output': [{'type': 'input_text', 'text': 'Script running with cell ID 7'}]}
        self.trace(payload, [self.wrapper(source), output])
        self.assertEqual(hook._effective_cwd(payload, self.cwd, command), self.cwd)
        output['output'][0]['text'] = 'Script completed\nWall time 1s\nOutput:\n'
        self.trace(payload, [self.wrapper(source), output])
        self.assertIsNone(hook._effective_cwd(payload, self.cwd, command))

    def test_command_equivalence_preserves_shell_semantics(self):
        code = "open('a', 'w').write('x')"
        command = self.command(code)
        for canonical in (["python3", "-c", code], json.dumps(["python3", "-c", code]),
                          'python3 -c "' + code + '"',
                          json.dumps(['/bin/zsh', '-lc', command]),
                          shlex.join(['/bin/zsh', '-lc', command])):
            with self.subTest(canonical=canonical):
                self.assertTrue(hook._same_command(command, canonical))
        heredoc = "python3 - <<'PY'\nopen('a', 'w')\nPY\necho done"
        self.assertTrue(hook._same_command(heredoc, json.dumps(['/bin/zsh', '-lc', heredoc])))
        for left, right in (('echo a; echo b', 'echo a echo b'),
                            ('echo a\necho b', 'echo a echo b'),
                            ('echo a # comment', 'echo a'),
                            ('echo "a;b"', 'echo a;b'),
                            ('echo "$X"', "echo '$X'"),
                            ('echo *', "echo '*'"),
                            ('echo a && echo b', "echo a '&&' echo b")):
            self.assertFalse(hook._same_command(left, right), (left, right))

    def test_reported_local_task_sources_resolve_default_cwd_without_execution(self):
        paths = list(Path.home().glob('.codex/sessions/2026/09/08/*01a082d0-504e*.jsonl'))
        if not paths:
            self.skipTest('local reported Codex session not installed')
        wanted = {'call_Bt6yjb66yi8Uz73MoctuZZIz', 'call_5CpfR06nCgCuSgBkQ3JwVSnN',
                  'call_960jZFCeftvuaQE8jD3hH3DP', 'call_TMto2SXVCpsi6tZtzNUv4dFs'}
        seen = set()
        for path in paths:
            for line in path.read_text().splitlines():
                row = json.loads(line)
                item = row.get('payload', {})
                if row.get('type') != 'response_item' or item.get('call_id') not in wanted or item.get('type') != 'custom_tool_call':
                    continue
                commands = hook.ExecLiterals(item['input']).commands()
                command = commands[0]['cmd']
                self.assertTrue(hook._command_paths(command))
                payload = self.payload(command, 'exec-11111111-1111-1111-1111-111111111111')
                self.trace(payload, [item])  # Exact raw PRE source, before its output.
                self.assertEqual(hook._effective_cwd(payload, self.cwd, command), self.cwd)
                seen.add(item['call_id'])
        self.assertEqual(seen, wanted)

    def test_cat_heredoc_literal_target(self):
        command = "cat <<'EOF' > 'notes file'\nopen('fake', 'w')\nEOF\n"
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.assert_change('notes file', 1, 0)

    def test_shell_redirects_tee_and_sequences_measure_actual_changes(self):
        command = "printf 'one\\ntwo\\n' > 'a b'; echo first > log; echo second >> log; echo x | tee -a one two"
        self.assertEqual(self.run_edit(command).returncode, 0)
        self.assertEqual({c['path']: (c['added'], c['removed']) for c in self.changes()}, {
            str(self.cwd / 'a b'): (2, 0), str(self.cwd / 'log'): (2, 0),
            str(self.cwd / 'one'): (1, 0), str(self.cwd / 'two'): (1, 0)})

    def test_sed_inplace_rust_target_forms_and_redirects(self):
        cases = {
            "sed -i '' 's/a/b/' three": {'three'},
            "sed -i.bak -e 's/a/b/' file; sed -i 's/c/d/' file": {'file'},
            "sed -i 's/a/b/' file 2> errors": {'file', 'errors'},
            "echo hi 2> errors": {'errors'},
            "echo hi 2>> errors": {'errors'},
            "echo x | tee --append --ignore-interrupts -- 'one two'": {'one two'},
            "cat input > output": {'output'},
        }
        for command, expected in cases.items():
            with self.subTest(command=command):
                self.assertEqual(hook._command_paths(command), expected)
        (self.cwd / 'file').write_text('old\n')
        # BSD/macOS needs an empty backup suffix; GNU accepts a bare -i.
        inplace = "-i ''" if sys.platform == 'darwin' else '-i'
        self.assertEqual(self.run_edit("sed " + inplace + " 's/old/new/' file").returncode, 0)
        self.assert_change('file', 1, 1)

    def test_shell_data_and_quoted_operators_never_become_targets(self):
        for index, command in enumerate((
                "echo '>' file", 'echo ">>" file', r'echo \> file',
                "echo 'echo hi > fake'", "# echo hi > fake\ncat real",
                "printf '%s' \"Path('fake').write_text('x')\"",
                "cat '>' fake <<'EOF'\ndata\nEOF",
                "cat <<'EOF'\necho hi > fake\nEOF")):
            with self.subTest(command=command):
                self.pre(command, str(index))
                (self.cwd / 'file').write_text(str(index) + '\n')
                (self.cwd / 'fake').write_text(str(index) + '\n')
                self.post(str(index))
                self.assertEqual(self.changes(), [])

    def test_shell_dynamic_and_cwd_changes_fail_closed(self):
        commands = ["echo hi > $TARGET", "echo hi > *.txt", "echo hi > foo$(date)",
                    "echo hi > 'unterminated", "echo hi > file &", "echo hi && tee file",
                    "cd elsewhere; echo hi > file", "eval 'cd sub'; echo x > file",
                    "echo x | tee file --unsupported", "sed -i .bak 's/a/b/' file",
                    "sed -i -f script file", "sed -i 's/a/b/e' file",
                    "echo x > file; unknown_command"]
        for index, command in enumerate(commands):
            with self.subTest(command=command):
                self.pre(command, str(index))
                (self.cwd / 'file').write_text(str(index) + '\n')
                self.post(str(index))
                self.assertEqual(self.changes(), [])

    def test_noop_and_read_command(self):
        (self.cwd / 'a').write_text('same\n')
        self.run_edit(self.command("open('a', 'w').write('same\\n')"))
        self.run_edit(self.command("print(open('a').read())"), 'read')
        self.assertEqual(self.changes(), [])

    def test_failed_command_partial_changes_count(self):
        result = self.run_edit(self.command("open('a', 'w').write('partial\\n'); raise RuntimeError('failed')"))
        self.assertNotEqual(result.returncode, 0)
        self.assert_change('a', 1, 0)

    def test_missing_pre_and_post_before_pre_are_tombstoned(self):
        self.post()
        self.pre(self.command("open('a', 'w')"))
        (self.cwd / 'a').write_text('unattributed\n')
        self.post()
        self.assertEqual(self.changes(), [])

    def test_duplicates_never_replace_before_or_recreate_imported_record(self):
        command = self.command("open('a', 'w').write('new\\n')")
        (self.cwd / 'a').write_text('old\n')
        self.pre(command)
        self.execute(command)
        self.pre(command)
        self.post()
        self.assert_change('a', 1, 1)
        for journal in (self.root / 'completed').glob('*.json'):
            journal.unlink()  # Importer consumed the record.
        self.pre(command)
        self.post()
        self.assertEqual(self.records(), [])

    def test_same_file_concurrent_captures_both_conflicted(self):
        self.pre(self.command("open('a', 'w')"), 'one')
        (self.cwd / 'a').write_text('one\n')
        self.pre(self.command("open('a', 'a')"), 'two')
        (self.cwd / 'a').write_text('two\n')
        self.post('one')
        self.post('two')
        self.assertEqual(self.changes(), [])

    def test_unsupported_writer_blocks_overlapping_capture_in_both_orders(self):
        for index, dynamic_first in enumerate((False, True)):
            with self.subTest(dynamic_first=dynamic_first):
                (self.cwd / 'a').write_text('old\n')
                tracked = "printf 'own\\n' >> a"
                dynamic = self.command("import os; open(os.environ['TARGET'], 'a').write('other\\n')")
                tracked_id, dynamic_id = f'tracked-{index}', f'dynamic-{index}'
                starts = [(tracked, tracked_id), (dynamic, dynamic_id)]
                for command, tool in reversed(starts) if dynamic_first else starts:
                    self.pre(command, tool)
                result = subprocess.run(dynamic, cwd=self.cwd, shell=True,
                                        env=dict(os.environ, TARGET='a'), capture_output=True)
                self.assertEqual(result.returncode, 0)
                self.post(dynamic_id)
                self.assertEqual(self.execute(tracked).returncode, 0)
                self.post(tracked_id)
                self.assertEqual(self.changes(), [])
        # Completion removes the blocker; future independent edits still count.
        self.assertEqual(self.run_edit("printf 'next\\n' >> a", 'next').returncode, 0)
        self.assert_change('a', 1, 0)

    def test_different_files_coexist_and_conflict_is_per_file(self):
        self.pre(self.command("open('a', 'w'); open('b', 'w')"), 'one')
        self.pre(self.command("open('a', 'w')"), 'two')
        self.pre(self.command("open('c', 'w')"), 'three')
        for name in ('a', 'b', 'c'):
            (self.cwd / name).write_text('line\n')
        for tool in ('two', 'three', 'one'):
            self.post(tool)
        self.assertEqual({c['path'] for c in self.changes()}, {str(self.cwd / 'b'), str(self.cwd / 'c')})

    def test_native_overlap_in_both_orders_never_counts_native(self):
        native = '*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** Move to: moved\n*** End Patch'
        for index, native_first in enumerate((True, False)):
            shell_id, native_id = 's' + str(index), 'n' + str(index)
            starts = [(native, native_id, True), (self.command("open('a', 'w')"), shell_id, False)]
            for command, tool, is_native in starts if native_first else reversed(starts):
                self.pre(command, tool, is_native)
            (self.cwd / 'a').write_text(str(index) + '\n')
            self.post(native_id)
            self.post(shell_id)
        self.assertEqual(self.changes(), [])

    def test_examples_comments_strings_and_unresolved_writes_skip(self):
        commands = [
            "echo \"python3 -c 'open(\"a\", \"w\")'\"",
            "# python3 -c \"open('a', 'w')\"",
            self.command("s = \"open('a', 'w')\"; print(s)"),
            self.command("# open('a', 'w')\nprint('example')"),
            self.command("def example():\n open('a', 'w')"),
            self.command("open('a', 'w'); open(input(), 'w')"),
            self.command("example = lambda: open('a', 'w'); print('not called')"),
            self.command("if False:\n open('a', 'w')"),
            self.command("from pathlib import Path; p = Path(input()); p.write_text('x')"),
            self.command("from pathlib import Path; p = Path('a'); p = input(); p.write_text('x')"),
            "python3 - <<EOF\nopen('$TARGET', 'w')\nEOF",
            "cat <<'EOF' > $TARGET\nhello\nEOF",
            self.command("open('a', 'w')") + ' &',
        ]
        for index, command in enumerate(commands):
            with self.subTest(command=command):
                self.pre(command, str(index))
                (self.cwd / 'a').write_text(str(index) + '\n')
                self.post(str(index))
                self.assertEqual(self.changes(), [])

    def test_ignored_binary_unreadable_oversize_symlink_outside(self):
        subprocess.run(['git', 'init', '-q', str(self.cwd)], check=True)
        (self.cwd / '.gitignore').write_text('ignored\n')
        (self.cwd / 'binary').write_bytes(b'\x00abc')
        (self.cwd / 'large').write_bytes(b'x' * (2 * 1024 * 1024 + 1))
        (self.cwd / 'unreadable').write_text('private')
        (self.cwd / 'unreadable').chmod(0)
        self.addCleanup(lambda: (self.cwd / 'unreadable').chmod(0o600))
        (self.cwd / 'symlink').symlink_to(self.cwd / 'real')
        for name in ('ignored', 'binary', 'large', 'unreadable', 'symlink', '../outside'):
            with self.subTest(name=name):
                self.pre(self.command('open(%r, "w")' % name), name)
                target = self.cwd / name
                if name != 'unreadable':
                    target.write_text('new\n')
                self.post(name)
        self.assertEqual(self.changes(), [])

    def test_after_binary_oversize_or_symlink_skips(self):
        for index, content in enumerate((b'\x00', b'x' * (2 * 1024 * 1024 + 1), None)):
            name = 'file' + str(index)
            self.pre(self.command('open(%r, "w")' % name), name)
            if content is None:
                (self.cwd / name).symlink_to(self.base / 'outside')
            else:
                (self.cwd / name).write_bytes(content)
            self.post(name)
        self.assertEqual(self.changes(), [])

    def test_snapshot_budget_fails_closed(self):
        with patch.object(hook, 'MAX_SNAPSHOT_BYTES', 8):
            (self.cwd / 'a').write_text('123456\n')
            (self.cwd / 'b').write_text('123456\n')
            self.pre(self.command("open('a', 'w'); open('b', 'w')"))
            (self.cwd / 'a').write_text('new\n')
            (self.cwd / 'b').write_text('new\n')
            self.post()
        self.assertEqual(self.changes(), [])

    def test_expired_pending_and_duplicate_skip(self):
        self.pre(self.command("open('a', 'w')"))
        (self.cwd / 'a').write_text('new\n')
        with patch.object(hook.time, 'time', return_value=time.time() + hook.PENDING_TTL + 1):
            self.post()
            self.pre(self.command("open('a', 'w')"))
            self.post()
        self.assertEqual(self.changes(), [])

    def test_late_post_releases_expired_guard_without_counting_old_edits(self):
        (self.cwd / 'a').write_text('old\n')
        self.pre("printf 'expired\\n' > a", 'old')
        (self.cwd / 'a').write_text('expired\n')
        future = time.time() + hook.PENDING_TTL + 1
        with patch.object(hook.time, 'time', return_value=future):
            self.post('old')
            self.assertEqual(self.changes(), [])
        self.assertEqual(self.run_edit("printf 'new\\n' > a", 'new').returncode, 0)
        self.assert_change('a', 1, 1)

    def test_capture_instance_and_start_survive_expiry_and_guard_reconciliation(self):
        instance = '11111111-1111-4111-8111-111111111111'
        key = hashlib.sha256(b'parent-sessionold').hexdigest()
        with patch.dict(os.environ, {'AGMUX_CODEX_CAPTURE_INSTANCE': instance}):
            self.pre("printf 'new\\n' > a", 'old')
        entry = json.loads((self.root / 'state.json').read_text())[key]
        self.assertEqual(entry['serverInstance'], instance)
        self.assertTrue(Path(entry['transcriptPath']).is_absolute())
        started = entry['startedAt']
        self.assertEqual(started, entry['time'])
        with patch.object(hook.time, 'time', return_value=started + hook.PENDING_TTL + 1):
            self.pre('cat a', 'read')
            self.post('read')
        with patch.dict(os.environ, {'AGMUX_CODEX_CAPTURE_INSTANCE': '22222222-2222-4222-8222-222222222222'}):
            self.post('old')
        entry = json.loads((self.root / 'state.json').read_text())[key]
        self.assertEqual(entry['status'], 'expired')
        self.assertEqual(entry['startedAt'], started)
        with patch.dict(os.environ, {'AGMUX_CODEX_CAPTURE_INSTANCE': instance}):
            self.post('old')
        self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'done')
        self.assertEqual(self.changes(), [])

    def test_dead_capture_owner_releases_guard_without_recovering_old_counts(self):
        instance = '11111111-1111-4111-8111-111111111111'
        (self.cwd / 'a').write_text('before\n')
        with patch.dict(os.environ, {'AGMUX_CODEX_CAPTURE_INSTANCE': instance}):
            self.pre("printf 'old\\n' > a", 'old')
        (self.cwd / 'a').write_text('old\n')
        (self.root / 'instances').mkdir(exist_ok=True)
        hook._atomic(self.root / 'instances' / (instance + '.json'), json.dumps({'serverInstance': instance, 'pid': 12345}).encode())
        with patch.object(hook.os, 'kill', side_effect=ProcessLookupError):
            self.assertEqual(self.run_edit("printf 'new\\n' > a", 'new').returncode, 0)
        self.assert_change('a', 1, 1)
        self.assertEqual(json.loads((self.root / 'state.json').read_text())[hashlib.sha256(b'parent-sessionold').hexdigest()]['status'], 'done')

    def test_live_unknown_or_reused_owner_remains_a_collision_guard(self):
        instance = '11111111-1111-4111-8111-111111111111'
        with patch.dict(os.environ, {'AGMUX_CODEX_CAPTURE_INSTANCE': instance}):
            self.pre("printf 'old\\n' > a", 'old')
        (self.root / 'instances').mkdir(exist_ok=True)
        marker = self.root / 'instances' / (instance + '.json')
        for index, (owner, error) in enumerate([
            ({'serverInstance': instance, 'pid': 12345}, None),
            ({'serverInstance': instance, 'pid': 12345}, PermissionError),
            ({'serverInstance': 'other', 'pid': 12345}, ProcessLookupError),
            ({'serverInstance': instance, 'pid': -1}, ProcessLookupError),
            ({'serverInstance': instance, 'pid': True}, ProcessLookupError),
            ({}, ProcessLookupError),
        ]):
            hook._atomic(marker, json.dumps(owner).encode())
            with patch.object(hook.os, 'kill', side_effect=error):
                self.pre("printf 'new\\n' > a", str(index))
                state = json.loads((self.root / 'state.json').read_text())
                self.assertEqual(state[hashlib.sha256(('parent-session' + str(index)).encode()).hexdigest()]['conflicts'], [str(self.cwd / 'a')])
                self.post(str(index))
        self.assertEqual(self.changes(), [])

    def test_legacy_guard_requires_observed_boot_boundary_not_wall_time(self):
        self.pre('unknown-writer', 'old')
        key = hashlib.sha256(b'parent-sessionold').hexdigest()
        state = json.loads((self.root / 'state.json').read_text())
        state[key].pop('bootId', None)
        state[key].update(status='expired', startedAt=1000, time=2000)
        (self.root / 'state.json').write_text(json.dumps(state))
        first_boot = '11111111-1111-4111-8111-111111111111'
        next_boot = '22222222-2222-4222-8222-222222222222'
        with patch.object(hook, '_current_boot', return_value=(first_boot, 3000)):
            hook.handle({'hook_event_name':'CaptureReconcile'}, self.root)
        entry = json.loads((self.root / 'state.json').read_text())[key]
        self.assertEqual(entry['status'], 'expired')
        self.assertEqual(entry['bootId'], first_boot)
        with patch.object(hook, '_current_boot', return_value=(next_boot, 500)):
            self.assertEqual(self.run_edit("printf 'new\\n' > a", 'new').returncode, 0)
        self.assert_change('a', 1, 0)
        self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'done')

    def test_boot_identity_retires_guard_without_old_counts_despite_clock_change(self):
        with patch.object(hook, '_current_boot', return_value=('11111111-1111-4111-8111-111111111111', 1000)):
            self.pre("printf 'old\\n' > a", 'old')
        (self.cwd / 'a').write_text('old\n')
        with patch.object(hook, '_current_boot', return_value=('22222222-2222-4222-8222-222222222222', 500)):
            self.assertEqual(self.run_edit("printf 'new\\n' > a", 'new').returncode, 0)
        self.assert_change('a', 1, 1)

    def test_same_boot_unknown_boot_and_ambiguous_legacy_remain_blockers(self):
        for index, (boot, entry_boot, started) in enumerate((
            (('11111111-1111-4111-8111-111111111111', 3000), '11111111-1111-4111-8111-111111111111', 1000),
            (('new', 3000), 'malformed', 1000),
            (None, 'old', 1000),
            (('new', 3000), None, 3001),
            (('new', 3000), None, None),
            (('new', 3000), None, float('nan')),
        )):
            with self.subTest(index=index):
                entry = {'status': 'expired', 'time': time.time(), 'paths': [], 'wide': True}
                if entry_boot is not None:
                    entry['bootId'] = entry_boot
                if started is not None:
                    entry['startedAt'] = started
                state = {'old': entry}
                for name in ('pending', 'completed'):
                    (self.root / name).mkdir(parents=True, exist_ok=True)
                with patch.object(hook, '_current_boot', return_value=boot):
                    hook._cleanup(self.root, state, time.time())
                self.assertEqual(state['old']['status'], 'expired')

    def test_expired_guard_needs_completion_even_after_retention_period(self):
        self.pre("printf 'live\\n' > a", 'old')
        future = time.time() + hook.PENDING_TTL + 1
        with patch.object(hook.time, 'time', return_value=future):
            self.pre('cat a', 'read')
            self.post('read')
        with patch.object(hook.time, 'time', return_value=future + hook.HANDLED_TTL + 1):
            self.pre("printf 'new\\n' > a", 'new')
        state = json.loads((self.root / 'state.json').read_text())
        self.assertEqual(state[hashlib.sha256(b'parent-sessionnew').hexdigest()]['conflicts'], [str(self.cwd / 'a')])

    def test_line_counts_newline_and_repeated_lines(self):
        for index, (before, after, added, removed) in enumerate((
                ('a\n', 'a', 1, 1), ('a', 'a\n', 1, 1),
                ('a\nb\nc\n', 'a\nx\nc\ny\n', 2, 1),
                ('x\n' * 300, 'x\n' * 299, 0, 1))):
            name = str(index)
            (self.cwd / name).write_text(before)
            self.pre(self.command('open(%r, "w")' % name), name)
            (self.cwd / name).write_text(after)
            self.post(name)
            change = next(c for c in self.changes() if c['path'] == str(self.cwd / name))
            self.assertEqual((change['added'], change['removed']), (added, removed))

    def test_app_owned_files_are_private(self):
        self.run_edit(self.command("open('a', 'w').write('new\\n')"))
        for path in self.root.rglob('*'):
            if path.is_file():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, str(path))

    def test_session_marker_for_native_and_no_change_pre_is_permanent(self):
        for index, (command, native) in enumerate((
                (self.command("print('no writes')"), False),
                ('*** Begin Patch\n*** Add File: a\n+new\n*** End Patch', True))):
            payload = self.payload(command, str(index), native=native)
            payload['session_id'] = 'parent-\u2603-' + str(index)
            hook.handle(payload, self.root)
            name = hashlib.sha256(payload['session_id'].encode('utf-8')).hexdigest() + '.json'
            marker = self.root / 'sessions' / name
            self.assertEqual(json.loads(marker.read_text()), {'sessionId': payload['session_id']})
            self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o600)
            with patch.object(hook.time, 'time', return_value=time.time() + hook.COMPLETED_TTL * 2):
                self.post(str(index))
            self.assertTrue(marker.exists())
        self.assertEqual(self.changes(), [])

    def test_invalid_pre_and_post_do_not_mark_session_active(self):
        for field, value in (('session_id', ''), ('tool_use_id', None),
                             ('tool_name', 'Read'), ('hook_event_name', 'PostToolUse')):
            payload = self.payload()
            payload[field] = value
            hook.handle(payload, self.root)
        self.assertEqual(list((self.root / 'sessions').glob('*.json')), [])

    def test_completed_payload_limit_fails_closed_and_tombstones(self):
        with patch.object(hook, 'MAX_COMPLETED_BYTES', 10):
            self.run_edit(self.command("open('a', 'w').write('new\\n')"))
        self.pre(self.command("open('a', 'w')"))
        self.post()
        self.assertEqual(self.records(), [])

    def test_done_capacity_eviction_keeps_read_heavy_session_capturing(self):
        with patch.object(hook, 'MAX_TOOLS', 3):
            for index in range(6):
                self.pre(self.command("print('no writes')"), str(index))
                self.post(str(index))
            self.assertFalse((self.root / 'unsafe').exists())
            self.run_edit(self.command("open('a', 'w').write('new\\n')"), 'write')
            self.assert_change('a', 1, 0)
            self.assertLessEqual(len(json.loads((self.root / 'state.json').read_text())), 3)
            self.assertFalse((self.root / 'unsafe').exists())

    def test_live_capacity_is_not_evicted(self):
        with patch.object(hook, 'MAX_TOOLS', 3):
            for index in range(3):
                self.pre(self.command('open(%r, "w")' % str(index)), str(index))
            self.pre(self.command("open('four', 'w')"), 'four')
            state = json.loads((self.root / 'state.json').read_text())
            self.assertEqual(len(state), 3)
            self.assertTrue(all(entry['status'] == 'pending' for entry in state.values()))
            self.assertTrue((self.root / 'unsafe').exists())

    def test_lock_contention_is_silent_and_invalidates_pending(self):
        import fcntl
        self.pre(self.command("open('a', 'w')"))
        with (self.root / 'lock').open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            started = time.monotonic()
            with patch.object(hook, 'LOCK_WAIT_SECONDS', 0.01):
                self.pre(self.command("open('a', 'w')"), 'two')
            self.assertLess(time.monotonic() - started, 1)
        (self.cwd / 'a').write_text('ambiguous\n')
        self.post()
        self.assertEqual(self.changes(), [])

    def test_real_parallel_pre_hooks_different_files_both_count(self):
        import fcntl
        installed = self.base / 'hooks/codex_diff_hook.py'
        installed.parent.mkdir()
        shutil.copyfile(SCRIPT, installed)
        self.pre(self.command("print('initialize')"), 'initialize')
        processes = []
        with (self.root / 'lock').open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            for name in ('a', 'b'):
                process = subprocess.Popen([sys.executable, '-B', str(installed)],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, text=True,
                                           env=dict(os.environ, AGMUX_SHELL_DIFF_HOOK='1'))
                process.stdin.write(json.dumps(self.payload(self.command('open(%r, "w")' % name), name)))
                process.stdin.close()
                process.stdin = None
                processes.append(process)
            time.sleep(0.2)  # Both real hooks encounter a busy lock before release.
            self.assertTrue(all(process.poll() is None for process in processes))
        for process in processes:
            self.assertEqual(process.communicate(timeout=5), ('', ''))
            self.assertEqual(process.returncode, 0)
        self.assertFalse((self.root / 'unsafe').exists())
        for name in ('a', 'b'):
            command = [sys.executable, '-c', 'open(%r, "w").write("new\\n")' % name]
            self.assertEqual(self.execute(command).returncode, 0)
            self.post(name)
        self.assertEqual({c['path'] for c in self.changes()}, {str(self.cwd / 'a'), str(self.cwd / 'b')})
        self.assertTrue(all((c['added'], c['removed']) == (1, 0) for c in self.changes()))

    def test_symlink_parent_and_replaced_after_parent_skip(self):
        real = self.cwd / 'real'
        real.mkdir()
        link = self.cwd / 'link'
        link.symlink_to(real, target_is_directory=True)
        self.pre(self.command("open('link/a', 'w')"))
        (real / 'a').write_text('new\n')
        self.post()
        self.pre(self.command("open('real/a', 'w')"), 'two')
        moved = self.cwd / 'moved'
        real.rename(moved)
        real.symlink_to(moved, target_is_directory=True)
        (moved / 'a').write_text('changed\n')
        self.post('two')
        self.assertEqual(self.changes(), [])

    def test_cli_gate_root_and_capture_errors_are_silent(self):
        installed = self.base / '.agmux/hooks/codex_diff_hook.py'
        installed.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, installed)
        env = dict(os.environ, AGMUX_SHELL_DIFF_HOOK='0')
        payload = self.payload(self.command("open('a', 'w')"))
        def invoke(data):
            result = subprocess.run([sys.executable, str(installed)], input=data,
                                    text=True, capture_output=True, env=env, timeout=5)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
        invoke(json.dumps(payload))
        root = installed.parent.parent / 'shell-diff-hooks'
        self.assertFalse(root.exists())
        env['AGMUX_SHELL_DIFF_HOOK'] = '1'
        invoke(json.dumps(payload))
        (self.cwd / 'a').write_text('new\n')
        payload['hook_event_name'] = 'PostToolUse'
        invoke(json.dumps(payload))
        self.assertEqual(len(list((root / 'completed').glob('*.json'))), 1)
        invoke('{invalid')
        invoke('[]')


    def checkpoint_receipt_fixture(self, child=True, tool='checkpoint-tool', before_receipt=False,
                                   header_change=None):
        payload = self.payload("printf 'new\\n' > a", tool)
        trace = Path(payload['transcript_path'])
        execution = 'child-session' if child else 'parent-session'
        meta = {'id': execution, 'session_id': 'parent-session', 'cwd': str(self.cwd)}
        if child:
            meta['source'] = {'subagent': {'thread_spawn': {'parent_thread_id': 'parent-session'}}}
        if header_change:
            header_change(meta)
        receipt = {'type': 'event_msg', 'payload': {
            'type': 'item_completed', 'thread_id': execution, 'completed_at_ms': 1,
            'item': {'type': 'CommandExecution', 'id': tool, 'status': 'completed', 'exit_code': 0},
        }}
        body = json.dumps({'type': 'session_meta', 'payload': meta}) + '\n' + trace.read_text()
        if before_receipt:
            old = json.loads(json.dumps(receipt))
            old['payload']['completed_at_ms'] = int(time.time() * 1000) + 60000
            body += json.dumps(old) + '\n'
        trace.write_text(body)
        (self.cwd / 'a').write_text('old\n')
        hook.handle(payload, self.root)
        key = hashlib.sha256(('parent-session' + tool).encode()).hexdigest()
        return trace, key, receipt

    def append_checkpoint_receipt(self, trace, receipt):
        with trace.open('a') as file:
            file.write(json.dumps(receipt) + '\n')

    def test_checkpoint_parent_and_child_receipts_keep_accounting_owner(self):
        for child in (False, True):
            with self.subTest(child=child):
                trace, key, receipt = self.checkpoint_receipt_fixture(child, str(child))
                entry = json.loads((self.root / 'state.json').read_text())[key]
                self.assertEqual(entry['executionSessionId'], receipt['payload']['thread_id'])
                self.assertEqual(entry['sessionId'], 'parent-session')
                self.assertEqual(entry['receiptCheckpoint']['offset'], trace.stat().st_size)
                (self.cwd / 'a').write_text('new\n')
                self.append_checkpoint_receipt(trace, receipt)
                result = hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)
                self.assertEqual(result['recovered'], 1)
                record = next(row for row in self.records() if row['toolId'] == str(child))
                self.assertEqual(record['sessionId'], 'parent-session')
                self.assertEqual(record['changes'], [{'path': str(self.cwd / 'a'), 'added': 1, 'removed': 1}])

    def test_checkpoint_child_requires_exact_parent_cwd_and_header(self):
        changes = [lambda m: m.update(session_id='other-parent'),
                   lambda m: m['source']['subagent']['thread_spawn'].update(parent_thread_id='other-parent'),
                   lambda m: m.pop('source'), lambda m: m.update(cwd=str(self.base)),
                   lambda m: m.update(id=''), lambda m: m.update(source='cli')]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                trace, key, receipt = self.checkpoint_receipt_fixture(tool=str(index), header_change=change)
                self.append_checkpoint_receipt(trace, receipt)
                self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
                entry = json.loads((self.root / 'state.json').read_text())[key]
                self.assertIsNone(entry['receiptCheckpoint'])
                self.assertEqual(entry['status'], 'pending')
        self.assertEqual(self.changes(), [])

    def test_checkpoint_child_rejects_wrong_receipt_thread_and_tool(self):
        trace, key, receipt = self.checkpoint_receipt_fixture()
        for thread, tool in [('parent-session', 'checkpoint-tool'), ('other-child', 'checkpoint-tool'),
                             ('child-session', 'other-tool')]:
            wrong = json.loads(json.dumps(receipt))
            wrong['payload']['thread_id'] = thread
            wrong['payload']['item']['id'] = tool
            self.append_checkpoint_receipt(trace, wrong)
            self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
        self.append_checkpoint_receipt(trace, receipt)
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)

    def test_checkpoint_ignores_receipts_before_start_even_with_future_time(self):
        for child in (False, True):
            with self.subTest(child=child):
                trace, key, receipt = self.checkpoint_receipt_fixture(child, str(child), before_receipt=True)
                self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
                self.append_checkpoint_receipt(trace, receipt)
                self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)

    def test_checkpoint_rejects_replaced_file_changed_header_and_boundary(self):
        for index, kind in enumerate(('inode', 'header', 'boundary', 'truncated')):
            with self.subTest(kind=kind):
                trace, key, receipt = self.checkpoint_receipt_fixture(tool=str(index))
                body = trace.read_bytes()
                if kind == 'inode':
                    replacement = trace.with_suffix('.replacement')
                    replacement.write_bytes(body)
                    replacement.replace(trace)
                elif kind == 'header':
                    trace.write_bytes(body.replace(b'parent-session', b'wrong--session'))
                elif kind == 'boundary':
                    trace.write_bytes(body.replace(b'printf', b'pr_ntf'))
                else:
                    trace.write_bytes(body.split(b'\n')[0] + b'\n')
                self.append_checkpoint_receipt(trace, receipt)
                self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
                self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'pending')

    def test_checkpoint_rejects_transcript_and_parent_symlinks(self):
        trace, key, receipt = self.checkpoint_receipt_fixture()
        original = trace.with_suffix('.original')
        trace.rename(original)
        trace.symlink_to(original)
        self.append_checkpoint_receipt(original, receipt)
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
        directory = self.base / 'linked'
        directory.symlink_to(self.base, target_is_directory=True)
        with self.assertRaises((OSError, ValueError)):
            hook._recorded_completions(str(directory / original.name), 'parent-session', str(self.cwd))

    def test_checkpoint_clock_jump_does_not_reject_exact_child_completion(self):
        trace, key, receipt = self.checkpoint_receipt_fixture()
        (self.cwd / 'a').write_text('new\n')
        self.append_checkpoint_receipt(trace, receipt)
        with patch.object(hook.time, 'time', return_value=time.time() - 3600):
            self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)
        self.assert_change('a', 1, 1)

    def test_checkpoint_expired_child_retires_without_counts(self):
        trace, key, receipt = self.checkpoint_receipt_fixture()
        state = json.loads((self.root / 'state.json').read_text())
        hook._discard(self.root, key, state[key])
        state[key]['status'] = 'expired'
        (self.root / 'state.json').write_text(json.dumps(state))
        (self.cwd / 'a').write_text('new\n')
        self.append_checkpoint_receipt(trace, receipt)
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)
        self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'done')
        self.assertEqual(self.changes(), [])

    def test_checkpoint_child_receipt_uses_bounded_forward_chunks(self):
        trace, key, receipt = self.checkpoint_receipt_fixture()
        with trace.open('a') as file:
            file.write((json.dumps({'type': 'event_msg', 'payload': {'text': 'x' * 512}}) + '\n') * 20)
        partial = json.dumps(receipt)
        with trace.open('a') as file:
            file.write(partial[:80])
        with patch.object(hook, 'MAX_TRANSCRIPT_BYTES', 1024):
            for _ in range(24):
                self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
            entry = json.loads((self.root / 'state.json').read_text())[key]
            self.assertGreater(entry['receiptCursor'][2], entry['receiptCheckpoint']['offset'])
            with trace.open('a') as file:
                file.write(partial[80:] + '\n')
            self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)

    def test_checkpoint_legacy_guards_keep_time_and_explicit_parent_requirements(self):
        for child in (False, True):
            trace, key, receipt = self.checkpoint_receipt_fixture(child, str(child))
            state = json.loads((self.root / 'state.json').read_text())
            entry = state[key]
            entry.pop('executionSessionId', None)
            entry.pop('receiptCheckpoint', None)
            entry.pop('receiptCursor', None)
            self.append_checkpoint_receipt(trace, receipt)
            (self.root / 'state.json').write_text(json.dumps(state))
            self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
            receipt['payload']['completed_at_ms'] = int(time.time() * 1000) + 1000
            self.append_checkpoint_receipt(trace, receipt)
            self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)

    def test_checkpoint_shared_transcript_keeps_each_tools_start_boundary(self):
        trace, first_key, first = self.checkpoint_receipt_fixture(tool='first')
        second = json.loads(json.dumps(first))
        second['payload']['item']['id'] = 'second'
        self.append_checkpoint_receipt(trace, second)  # Predates only the second PRE.
        payload = self.payload('unknown-writer', 'second')
        payload['transcript_path'] = str(trace)
        hook.handle(payload, self.root)
        second_key = hashlib.sha256(b'parent-sessionsecond').hexdigest()
        state = json.loads((self.root / 'state.json').read_text())
        # Force a shared scan from the earlier checkpoint, as when the first
        # capture still has a backlog. The second must not accept its old receipt.
        state[first_key].pop('receiptScan', None)
        state[first_key]['receiptCursor'][2] = state[first_key]['receiptCheckpoint']['offset']
        (self.root / 'state.json').write_text(json.dumps(state))
        self.append_checkpoint_receipt(trace, first)
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)
        state = json.loads((self.root / 'state.json').read_text())
        self.assertEqual(state[first_key]['status'], 'done')
        self.assertEqual(state[second_key]['status'], 'pending')
        self.append_checkpoint_receipt(trace, second)
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)

    def test_checkpoint_missing_pre_proof_never_downgrades_to_legacy(self):
        trace, key, receipt = self.checkpoint_receipt_fixture(False, header_change=lambda m: m.update(cwd=str(self.base)))
        trace.write_text(trace.read_text().replace(json.dumps(str(self.base)), json.dumps(str(self.cwd))))
        receipt['payload']['completed_at_ms'] = int(time.time() * 1000) + 60000
        self.append_checkpoint_receipt(trace, receipt)
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
        self.assertIsNone(json.loads((self.root / 'state.json').read_text())[key]['receiptCheckpoint'])

    def test_checkpoint_skips_receipt_that_started_before_pre(self):
        payload = self.payload('unknown-writer', 'partial')
        trace = Path(payload['transcript_path'])
        receipt = {'type': 'event_msg', 'payload': {
            'type': 'item_completed', 'thread_id': 'parent-session', 'completed_at_ms': 9999999999999,
            'item': {'type': 'CommandExecution', 'id': 'partial', 'status': 'completed', 'exit_code': 0}}}
        raw = json.dumps(receipt)
        trace.write_text(json.dumps({'type': 'session_meta', 'payload': {
            'id': 'parent-session', 'cwd': str(self.cwd)}}) + '\n' + raw[:80])
        hook.handle(payload, self.root)
        with trace.open('a') as file:
            file.write(raw[80:] + '\n')
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
        self.append_checkpoint_receipt(trace, receipt)
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)

    def test_checkpoint_header_read_is_bounded_and_new_failed_receipts_settle(self):
        trace, key, receipt = self.checkpoint_receipt_fixture()
        receipt['payload']['item'].update(status='failed', exit_code=1)
        receipt['payload'].pop('completed_at_ms')
        self.append_checkpoint_receipt(trace, receipt)
        self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)
        trace.write_bytes(b' ' * (64 * 1024 + 1) + trace.read_bytes())
        with self.assertRaises(ValueError):
            hook._receipt_start(trace, 'parent-session', str(self.cwd))

    def legacy_receipt_entry(self, key, expired=False):
        state = json.loads((self.root / 'state.json').read_text())
        for field in ('executionSessionId', 'receiptCheckpoint', 'receiptCursor', 'receiptSource', 'receiptScan'):
            state[key].pop(field, None)
        if expired:
            hook._discard(self.root, key, state[key])
            state[key]['status'] = 'expired'
        (self.root / 'state.json').write_text(json.dumps(state))

    def test_legacy_child_receipts_need_header_link_cwd_and_exact_tool(self):
        changes = [lambda m: m.pop('source'), lambda m: m.pop('session_id'),
                   lambda m: m.update(session_id='other-parent'),
                   lambda m: m['source']['subagent']['thread_spawn'].update(parent_thread_id='other-parent'),
                   lambda m: m.update(cwd=str(self.base)), None]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                trace, key, receipt = self.checkpoint_receipt_fixture(tool=str(index), header_change=change)
                self.legacy_receipt_entry(key, expired=True)
                receipt['payload']['completed_at_ms'] = int(time.time() * 1000) + 1000
                if change is None:
                    receipt['payload']['item']['id'] = 'other-tool'
                self.append_checkpoint_receipt(trace, receipt)
                self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
                self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'expired')
        self.assertEqual(self.changes(), [])

    def test_child_raw_patch_receipt_defaults_only_to_validated_execution(self):
        import datetime
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                tool = str(legacy)
                trace, key, _ = self.checkpoint_receipt_fixture(tool=tool)
                if legacy:
                    self.legacy_receipt_entry(key, expired=True)
                receipt = {'type': 'event_msg',
                           'timestamp': datetime.datetime.fromtimestamp(time.time() + 1, datetime.timezone.utc).isoformat(),
                           'payload': {'type': 'patch_apply_end', 'call_id': tool, 'success': True}}
                for thread in ('parent-session', 'foreign-child'):
                    wrong = json.loads(json.dumps(receipt))
                    wrong['payload']['thread_id'] = thread
                    self.append_checkpoint_receipt(trace, wrong)
                    self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 0)
                self.append_checkpoint_receipt(trace, receipt)
                self.assertEqual(hook.handle({'hook_event_name': 'CaptureReconcile'}, self.root)['recovered'], 1)
                self.assertEqual(json.loads((self.root / 'state.json').read_text())[key]['status'], 'done')
                self.assertEqual(self.changes(), [])


if __name__ == '__main__':
    unittest.main()
