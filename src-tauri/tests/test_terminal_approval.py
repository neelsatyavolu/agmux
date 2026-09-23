"""Run production approval/preflight/write code with pure Rust fake terminals.

No native PTY or Tauri runtime is started. The extracted code is compiled as-is;
only unchanged post-success app logging/interrupt notifications are omitted.
This tests the remote call site too, so moving consumption before preflight
again fails the missing/dead/waiting-writer regressions.
"""
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class TerminalApprovalTests(unittest.TestCase):
    def test_terminal_approval_write_boundary(self):
        shared = (ROOT / 'src/dispatch/mod.rs').read_text()
        start = shared.index('pub async fn send_pty_raw(')
        end = shared.index("    // Don't log control-only writes", start)
        core = shared[start:end] + '    Ok(())\n}\n'

        remote = (ROOT / 'src/remote/dispatch.rs').read_text()
        start = remote.index('            // Terminal approvals type y/n')
        end = remote.index('\n        }\n    }\n}\n\npub async fn respond_user_input', start)
        arm = remote[start:end]

        client = (ROOT / 'src/remote/client.rs').read_text()
        start = client.index('    pub async fn take_pending_approval(')
        end = client.index('    pub async fn push_approval_resolved(', start)
        claim = client[start:end]
        start = client.index('fn approval_key(')
        end = client.index('\n}', start) + 2
        key = client[start:end]

        fixture = (ROOT / 'tests/fixtures/terminal_approval.rs').read_text()
        source = fixture + '\n' + key + '\nimpl Remote {\n' + claim + '\n}\n'
        source += '\nmod dispatch { use super::*;\n' + core + '\n}\n'
        source += 'use dispatch::send_pty_raw;\n'
        source += 'async fn respond_terminal_approval(state: &AppState, tid: &str, request_id: &str, decision: &str) -> Result<(), DispatchError> {\n' + arm + '\n}\n'
        with tempfile.TemporaryDirectory(prefix='agmux-terminal-approval-') as tmp:
            src = Path(tmp) / 'tests.rs'
            binary = Path(tmp) / 'tests'
            src.write_text(source)
            subprocess.run(['rustc', '--edition=2021', '--test', '-A', 'warnings', str(src), '-o', str(binary)], check=True, timeout=60)
            result = subprocess.run([str(binary), '--test-threads=1'], capture_output=True, text=True, timeout=15)
            print(result.stdout, end='')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
