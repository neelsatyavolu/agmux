/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerTerminalLayoutRefresh,
  requestTerminalLayoutRefresh,
  TERMINAL_LAYOUT_REFRESH_EVENT,
} from "../terminalRefresh";

beforeEach(() => {
  // Clear any leftover handlers between tests by re-registering over them.
});

describe("terminalRefresh registry", () => {
  it("invokes the registered handler and dispatches CustomEvent", () => {
    const handler = vi.fn();
    const unreg = registerTerminalLayoutRefresh("t1", handler);

    const seen: string[] = [];
    const listener = (e: Event) => {
      seen.push((e as CustomEvent<{ threadId?: string }>).detail?.threadId ?? "");
    };
    window.addEventListener(TERMINAL_LAYOUT_REFRESH_EVENT, listener);
    try {
      const ran = requestTerminalLayoutRefresh("t1");
      expect(ran).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(["t1"]);
    } finally {
      window.removeEventListener(TERMINAL_LAYOUT_REFRESH_EVENT, listener);
      unreg();
    }
  });

  it("still dispatches CustomEvent when no handler is registered", () => {
    const seen: string[] = [];
    const listener = (e: Event) => {
      seen.push((e as CustomEvent<{ threadId?: string }>).detail?.threadId ?? "");
    };
    window.addEventListener(TERMINAL_LAYOUT_REFRESH_EVENT, listener);
    try {
      const ran = requestTerminalLayoutRefresh("missing");
      expect(ran).toBe(false);
      expect(seen).toEqual(["missing"]);
    } finally {
      window.removeEventListener(TERMINAL_LAYOUT_REFRESH_EVENT, listener);
    }
  });

  it("unregister stops the handler from running", () => {
    const handler = vi.fn();
    const unreg = registerTerminalLayoutRefresh("t2", handler);
    unreg();
    requestTerminalLayoutRefresh("t2");
    expect(handler).not.toHaveBeenCalled();
  });
});
