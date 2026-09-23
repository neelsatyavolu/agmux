/**
 * Pure-ish project settings helpers.
 *
 * These perform file I/O against `.claude/settings.local.json` in a project
 * directory. They are extracted from claude-sdk-bridge.mjs so they can be
 * tested with real temp directories without spinning up the full JSON-RPC
 * sidecar.
 *
 * The bridge uses these to load/persist the `allowedTools` array so Claude's
 * "always allow" decisions survive restarts.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

/**
 * Read `.claude/settings.local.json` from the given project directory.
 * Returns an empty object when the file is missing or malformed so callers
 * never have to branch on ENOENT themselves.
 */
export async function readProjectSettings(cwd) {
  try {
    const settingsPath = join(cwd, ".claude", "settings.local.json");
    const raw = await readFile(settingsPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Write `settings` to `.claude/settings.local.json`, creating `.claude/`
 * when needed. Writes pretty-printed JSON with a trailing newline so diffs
 * stay clean.
 */
export async function writeProjectSettings(cwd, settings) {
  const claudeDir = join(cwd, ".claude");
  await mkdir(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.local.json");
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

/**
 * Merge `toolName` into the project's `allowedTools` array, preserving any
 * other keys. No-op when the tool is already present so we don't rewrite
 * the file on every approval.
 */
export async function addToolToProjectSettings(cwd, toolName) {
  const settings = await readProjectSettings(cwd);
  const allowedTools = Array.isArray(settings.allowedTools)
    ? settings.allowedTools
    : [];
  if (allowedTools.includes(toolName)) {
    return { changed: false, settings };
  }
  const next = { ...settings, allowedTools: [...allowedTools, toolName] };
  await writeProjectSettings(cwd, next);
  return { changed: true, settings: next };
}

/**
 * Load the allowed-tools list from settings into an in-memory Set. Tolerates
 * a missing file, a non-array `allowedTools`, or non-string entries.
 */
export async function loadProjectAllowedTools(cwd) {
  const settings = await readProjectSettings(cwd);
  const result = new Set();
  if (Array.isArray(settings.allowedTools)) {
    for (const tool of settings.allowedTools) {
      if (typeof tool === "string" && tool.length > 0) {
        result.add(tool);
      }
    }
  }
  return result;
}
