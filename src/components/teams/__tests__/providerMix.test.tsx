/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MixBars } from "../charts";

it("renders every app provider in the desktop mix", () => {
  const providers = ["ClaudeCode", "Codex", "Grok", "Cursor", "Droid", "Pi", "Kimi", "Cline", "Gemini", "Hermes", "OpenCode", "MLX"];
  const markup = renderToStaticMarkup(<MixBars slices={providers.map((key) => ({ key, tokens: 100, share: 1 / 12, activeMs: 60000, timeShare: 1 / 12 }))} />);
  for (const provider of providers) expect(markup).toContain(`>${provider === "ClaudeCode" ? "Claude Code" : provider}<`);
});
