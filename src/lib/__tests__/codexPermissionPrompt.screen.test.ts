/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { codexPermissionPrompt } from "../codexPermissionPrompt";

it("reads a real xterm screen across split ANSI paints, dismissal, and scrollback", async () => {
  const term = new Terminal({ cols: 120, rows: 24, allowProposedApi: true });
  const write = (s: string) => new Promise<void>((resolve) => term.write(s, resolve));
  const read = () => {
    const b = term.buffer.active;
    return codexPermissionPrompt(Array.from({ length: term.rows }, (_, i) =>
      b.getLine(b.baseY + i)?.translateToString(true) ?? "").join("\n"));
  };
  try {
    await write('\x1b[2J\x1b[HField 1/1\r\nAllow Computer Use to use "Canary Mail"?\r\n');
    await write('\x1b[36m1. Allow\r\n2. Allow for this session\r\n3. Always allow\r\n4. Cancel\r\n');
    expect(read()).toBeNull();
    await write('enter to submit | esc to cancel\x1b[0m');
    expect(read()).toBe('Allow Computer Use to use "Canary Mail"?');
    // Move the full prompt into scrollback: a user's scroll position must
    // never re-open attention for that historical prompt.
    await write('\r\n'.repeat(30) + 'Working');
    expect(read()).toBeNull();
    await write('\x1b[2J\x1b[HComputer Use was not approved to use Canary Mail');
    expect(read()).toBeNull();
  } finally {
    term.dispose();
  }
});
