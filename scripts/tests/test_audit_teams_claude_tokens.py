import datetime as dt
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("claude_audit", Path(__file__).parents[1] / "audit-teams-claude-tokens.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class ClaudeAuditTests(unittest.TestCase):
    def test_registry_history_and_external_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / ".agmux").mkdir()
            db = sqlite3.connect(home / ".agmux/agmux.db")
            db.executescript("""
                CREATE TABLE session_origins(provider,owner_id,created_in_agmux);
                CREATE TABLE session_origin_bindings(provider,owner_id,session_id);
                CREATE TABLE session_legacy_thread_claims(provider,owner_id);
                CREATE TABLE threads(provider,id,sdk_session_id,work_dir);
                CREATE TABLE teams_created_claude_sessions(session_id);
                INSERT INTO session_origins VALUES('ClaudeCode','created',1),('ClaudeCode','imported',0);
                INSERT INTO session_origin_bindings VALUES('ClaudeCode','created','native'),('ClaudeCode','imported','external');
                INSERT INTO session_legacy_thread_claims VALUES('ClaudeCode','legacy'),('ClaudeCode','imported');
                INSERT INTO threads VALUES('ClaudeCode','legacy','old-native','/unused'),('ClaudeCode','imported','external','/unused');
                INSERT INTO teams_created_claude_sessions VALUES('historic'),('external'),('imported');
            """)
            db.close()
            snapshot = home / "creation.json"
            snapshot.write_text(json.dumps(["explicit", "external"]))
            owned, external, _ = audit.ownership(home, snapshot)
            self.assertEqual(owned, {"created", "native", "legacy", "old-native", "historic", "explicit"})
            self.assertEqual(external, {"imported", "external"})

    def test_utc_window_streams_parent_children_and_global_copies(self):
        until = dt.datetime(2026, 9, 8, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            root = home / ".claude"
            project = root / "projects/repo"
            child = project / "parent/subagents"
            child.mkdir(parents=True)

            def line(mid, output, timestamp="2026-09-07T17:00:00-07:00", request="req"):
                return json.dumps({"type": "assistant", "timestamp": timestamp, "requestId": request,
                                   "message": {"id": mid, "model": "claude-sonnet-4", "usage": {
                                       "input_tokens": 10, "output_tokens": output,
                                       "cache_read_input_tokens": 20, "cache_creation_input_tokens": 30}}})

            (project / "parent.jsonl").write_text("\n".join([
                line("m", 1), line("m", 5), line("future", 99, "2026-09-08T00:00:01Z"),
                line("old", 99, (until - dt.timedelta(days=90, seconds=1)).isoformat())]))
            (child / "agent-a.jsonl").write_text(line("m", 5) + "\n" + line("child", 2))
            (project / "external.jsonl").write_text(line("outside", 999))
            # An externally classified parent cannot admit its children.
            outside = project / "external/subagents"
            outside.mkdir(parents=True)
            (outside / "agent-b.jsonl").write_text(line("outside-child", 999))
            result = audit.audit({root}, {"parent"}, {"external"}, until)
            self.assertEqual(result["summary"]["files"], 2)
            self.assertEqual(result["summary"]["cross_file_copies"], 1)
            self.assertEqual(result["summary"]["per_file_tokens"], 192)
            self.assertEqual(result["global"]["expected"], 127)
            self.assertEqual(result["global"]["hours"], {"2026-09-08T00": [20, 7, 40, 60]})
            self.assertIn("parent:agent-a", {f["session"] for f in result["files"]})


if __name__ == "__main__":
    unittest.main()
