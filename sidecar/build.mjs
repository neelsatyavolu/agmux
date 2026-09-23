import { build } from "esbuild";

await build({
  entryPoints: ["claude-sdk-bridge.mjs"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/claude-sdk-bridge.bundle.mjs",
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    "@anthropic-ai/claude-agent-sdk-darwin-x64",
    "@anthropic-ai/claude-agent-sdk-linux-x64",
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
    "@anthropic-ai/claude-agent-sdk-linux-arm64",
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
    "@anthropic-ai/claude-agent-sdk-win32-x64",
    "@anthropic-ai/claude-agent-sdk-win32-arm64",
  ],
  minify: false,
  sourcemap: false,
});

console.log("Built sidecar/dist/claude-sdk-bridge.bundle.mjs");

// @opencode-ai/sdk depends on cross-spawn (CJS). Build as CJS to avoid
// dynamic-require issues, then re-export from a thin ESM .mjs wrapper.
await build({
  entryPoints: ["opencode-sdk-bridge.mjs"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/opencode-sdk-bridge.bundle.cjs",
  minify: false,
  sourcemap: false,
});

// Write thin ESM wrapper so Rust can spawn the .mjs file (Node.js ESM entry).
// The wrapper loads the CJS bundle via createRequire to avoid dynamic-require errors.
import { writeFileSync } from "node:fs";
writeFileSync(
  "dist/opencode-sdk-bridge.bundle.mjs",
  `#!/usr/bin/env node\nimport { createRequire } from "node:module";\nimport { fileURLToPath } from "node:url";\nimport { dirname, join } from "node:path";\nconst require = createRequire(import.meta.url);\nrequire(join(dirname(fileURLToPath(import.meta.url)), "opencode-sdk-bridge.bundle.cjs"));\n`,
);
console.log("Built sidecar/dist/opencode-sdk-bridge.bundle.mjs");

await build({
  entryPoints: ["cursor-sdk-bridge.mjs"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/cursor-sdk-bridge.bundle.mjs",
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@cursor/sdk",
    "sqlite3",
    "@cursor/sdk-darwin-arm64",
    "@cursor/sdk-darwin-x64",
    "@cursor/sdk-linux-arm64",
    "@cursor/sdk-linux-x64",
    "@cursor/sdk-win32-x64",
  ],
  minify: false,
  sourcemap: false,
});

console.log("Built sidecar/dist/cursor-sdk-bridge.bundle.mjs");

// Session memory MCP server (stdio) — no external deps; bundle store + server.
// Source must NOT include a shebang; banner is the only one (double shebang
// → SyntaxError when Claude/Codex spawn `node dist/*.bundle.mjs`).
async function buildMemoryEntry(entry, outfile) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "esm",
    outfile,
    banner: { js: "#!/usr/bin/env node" },
    minify: false,
    sourcemap: false,
  });
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(outfile, "utf8");
  const shebangs = body.match(/^#!.*$/gm) || [];
  if (shebangs.length !== 1) {
    throw new Error(
      `${outfile}: expected exactly 1 shebang line, found ${shebangs.length} — would crash under node`,
    );
  }
  const { spawnSync } = await import("node:child_process");
  const chk = spawnSync(process.execPath, ["--check", outfile], { encoding: "utf8" });
  if (chk.status !== 0) {
    throw new Error(`${outfile} failed node --check:\n${chk.stderr || chk.stdout}`);
  }
  console.log(`Built sidecar/${outfile}`);
}

await buildMemoryEntry("agmux-memory-mcp.mjs", "dist/agmux-memory-mcp.bundle.mjs");
// Bash-callable fallback when MCP tools are still pending / not listed.
await buildMemoryEntry("agmux-memory-cli.mjs", "dist/agmux-memory-cli.bundle.mjs");

await import("./copy-cursor-runtime.mjs");
