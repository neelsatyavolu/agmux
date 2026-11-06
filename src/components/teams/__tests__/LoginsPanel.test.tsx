/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginsPanel } from "../LoginsPanel";

it("renders nothing for a server without the login split", () => {
  expect(renderToStaticMarkup(<LoginsPanel logins={undefined} />)).toBe("");
});

it("says logins are not reported yet instead of showing zeros", () => {
  const markup = renderToStaticMarkup(<LoginsPanel logins={{ reported: false, rows: [] }} />);
  expect(markup).toContain("Not reported yet");
  expect(markup).not.toContain("0%");
});

it("lists each login with its share, including the unattributed part", () => {
  const row = { provider: "claude", costUsd: 0, costIncomplete: false, activeHours: 1 };
  const markup = renderToStaticMarkup(
    <LoginsPanel
      logins={{
        reported: true,
        rows: [
          { ...row, identityHash: "a".repeat(64), name: "name@example.com", tokens: 1_500_000, share: 0.75 },
          { ...row, identityHash: null, name: "Not attributed", tokens: 500_000, share: 0.25 },
        ],
      }}
    />,
  );
  expect(markup).toContain("name@example.com");
  expect(markup).toContain("Not attributed");
  expect(markup).toContain("1.5M");
  expect(markup).toContain("75%");
});
