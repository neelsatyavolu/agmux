import { describe, expect, it } from "vitest";
import { codexPermissionPrompt } from "../codexPermissionPrompt";

const menu = `Field 1/1
Allow Computer Use to use "Canary Mail"?
App: Canary Mail
› 1. Allow                 Run the tool and continue.
2. Allow for this session  Run the tool and remember this choice for this session.
3. Always allow            Run the tool and remember this choice for future tool calls.
4. Cancel                  Cancel this tool call.
enter to submit | esc to cancel`;

describe("Codex permission screen", () => {
  it("recognizes the Canary Mail MCP permission form", () => {
    expect(codexPermissionPrompt(menu)).toBe('Allow Computer Use to use "Canary Mail"?');
  });
  it("requires the live form footer and options", () => {
    expect(codexPermissionPrompt(menu.replace('enter to submit | esc to cancel', ''))).toBeNull();
    expect(codexPermissionPrompt('Calling Access Canary Mail')).toBeNull();
    expect(codexPermissionPrompt('Field 1/1\nWhich app?\n1. Canary Mail\nenter to submit | esc to cancel')).toBeNull();
  });
});
