import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const mockDir = fileURLToPath(new URL("./src/__mocks__", import.meta.url));

const tauriAlias = {
  "@tauri-apps/api/core": `${mockDir}/@tauri-apps/api/core.ts`,
  "@tauri-apps/api/event": `${mockDir}/@tauri-apps/api/event.ts`,
  "@tauri-apps/plugin-dialog": `${mockDir}/@tauri-apps/plugin-dialog/index.ts`,
  "@tauri-apps/plugin-opener": `${mockDir}/@tauri-apps/plugin-opener/index.ts`,
  "@tauri-apps/plugin-process": `${mockDir}/@tauri-apps/plugin-process/index.ts`,
};

export default defineConfig({
  test: {
    // Vitest v4 "projects" — split node-only logic from React-hook DOM tests.
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
          // Hook tests live under src/hooks/__tests__ and need jsdom +
          // React; they are run by the dom project below.
          exclude: [
            "src/**/__tests__/setup.ts",
            "src/hooks/__tests__/**/*.test.{ts,tsx}",
            "src/**/*.dom.test.{ts,tsx}",
            // Component tests (.test.tsx) run under the dom project
            "src/**/__tests__/**/*.test.tsx",
            "**/node_modules/**",
          ],
          globals: false,
          setupFiles: ["src/stores/__tests__/setup.ts"],
          alias: tauriAlias,
        },
      },
      {
        test: {
          name: "dom",
          environment: "jsdom",
          include: [
            "src/hooks/__tests__/**/*.test.{ts,tsx}",
            "src/**/*.dom.test.{ts,tsx}",
            // All component tests (.tsx) run under jsdom
            "src/**/__tests__/**/*.test.tsx",
          ],
          exclude: ["**/node_modules/**"],
          globals: false,
          setupFiles: ["src/stores/__tests__/setup.ts"],
          alias: tauriAlias,
        },
      },
    ],
    reporters: "default",
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.dom.test.{ts,tsx}",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/components/thread/TerminalView.tsx",
        "src/components/thread/ClaudeTerminalView.tsx",
        "src/components/thread/StandaloneTerminalView.tsx",
        "src/components/thread/TerminalPanel.tsx",
        "src/lib/xterm-loader.ts",
        "src/components/editor/CodeEditor.tsx",
        "src/lib/codemirrorTheme.ts",
        "src/main.tsx",
        "src/App.tsx",
      ],
    },
  },
});
