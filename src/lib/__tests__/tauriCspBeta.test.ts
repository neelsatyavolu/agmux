import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("tauri updater / CSP for beta", () => {
  const raw = readFileSync(resolve(__dirname, "../../../src-tauri/tauri.conf.json"), "utf8");
  const conf = JSON.parse(raw) as {
    app: { security: { csp: string } };
    plugins: { updater: { endpoints: string[] } };
  };

  it("checks the website first, GitHub second", () => {
    expect(conf.plugins.updater.endpoints).toEqual([
      "https://agmux.dev/api/updates/latest.json",
      "https://github.com/neelsatyavolu/agmux/releases/latest/download/latest.json",
    ]);
  });

  it("allows webview fetch to agmux.dev for token verify", () => {
    expect(conf.app.security.csp).toContain("https://agmux.dev");
  });
});
