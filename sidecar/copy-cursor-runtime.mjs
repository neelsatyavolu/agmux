import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sidecarRoot = dirname(fileURLToPath(import.meta.url));
const sourceNodeModules = join(sidecarRoot, "node_modules");
const runtimeRoot = join(sidecarRoot, "dist", "cursor-sdk-runtime");
const runtimeNodeModules = join(runtimeRoot, "node_modules");
const initialPackages = ["@cursor/sdk"];

/**
 * Only ship the host/target Cursor native package into the app bundle.
 * Optional deps install for the npm host arch only; CI can force the
 * matrix arch via CURSOR_SDK_PLATFORM=darwin-arm64|darwin-x64.
 * Shipping the wrong/ad-hoc-signed bins breaks Apple notarization.
 */
function resolveCursorSdkPlatform() {
  const fromEnv = (process.env.CURSOR_SDK_PLATFORM || "").trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
  if (process.platform === "win32") return "win32-x64";
  return null;
}

const cursorSdkPlatform = resolveCursorSdkPlatform();
const allowedCursorNativePackage = cursorSdkPlatform
  ? `@cursor/sdk-${cursorSdkPlatform}`
  : null;

function isCursorNativePackage(packageName) {
  return /^@cursor\/sdk-(darwin|linux|win32)-/.test(packageName);
}

function shouldCopyPackage(packageName) {
  if (!isCursorNativePackage(packageName)) return true;
  if (!allowedCursorNativePackage) return false;
  return packageName === allowedCursorNativePackage;
}

function packagePath(packageName) {
  return join(...packageName.split("/"));
}

function packageJsonPath(packageDir) {
  return join(packageDir, "package.json");
}

function assertRuntimeRootIsSafe() {
  const resolvedRuntimeRoot = resolve(runtimeRoot);
  const resolvedDistRoot = resolve(sidecarRoot, "dist");
  if (
    resolvedRuntimeRoot === resolvedDistRoot ||
    !resolvedRuntimeRoot.startsWith(resolvedDistRoot + sep)
  ) {
    throw new Error(`Refusing to clean unexpected Cursor runtime path: ${runtimeRoot}`);
  }
}

async function readPackageJson(packageDir) {
  const raw = await readFile(packageJsonPath(packageDir), "utf8");
  return JSON.parse(raw);
}

function findInstalledPackage(packageName, fromDir = sourceNodeModules) {
  let cursor = fromDir;
  while (cursor.startsWith(sidecarRoot)) {
    const candidate = join(cursor, "node_modules", packagePath(packageName));
    if (existsSync(packageJsonPath(candidate))) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const rootCandidate = join(sourceNodeModules, packagePath(packageName));
  return existsSync(packageJsonPath(rootCandidate)) ? rootCandidate : null;
}

function dependencyNames(dependencies) {
  return dependencies && typeof dependencies === "object" ? Object.keys(dependencies) : [];
}

async function copyPackage(packageName, srcDir, pending, copied) {
  if (copied.has(packageName)) return;
  if (!shouldCopyPackage(packageName)) {
    console.log(`Skipping Cursor native package (not for this platform): ${packageName}`);
    return;
  }
  copied.add(packageName);

  const destDir = join(runtimeNodeModules, packagePath(packageName));
  await mkdir(dirname(destDir), { recursive: true });
  await cp(srcDir, destDir, { recursive: true, force: true });

  const pkg = await readPackageJson(srcDir);
  for (const dep of dependencyNames(pkg.dependencies)) {
    if (!shouldCopyPackage(dep)) continue;
    const depDir = findInstalledPackage(dep, srcDir);
    if (!depDir) {
      throw new Error(`Dependency ${dep} for ${packageName} is not installed`);
    }
    pending.push({ name: dep, dir: depDir });
  }

  for (const dep of [
    ...dependencyNames(pkg.optionalDependencies),
    ...dependencyNames(pkg.peerDependencies),
  ]) {
    if (!shouldCopyPackage(dep)) continue;
    const depDir = findInstalledPackage(dep, srcDir);
    if (depDir) {
      pending.push({ name: dep, dir: depDir });
    } else if (isCursorNativePackage(dep)) {
      throw new Error(
        `Required Cursor native package ${dep} is not installed. ` +
          `Install it before building (e.g. npm install ${dep} --no-save).`,
      );
    }
  }
}

async function main() {
  assertRuntimeRootIsSafe();
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(runtimeNodeModules, { recursive: true });
  await writeFile(
    join(runtimeRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2) + "\n",
  );

  const pending = initialPackages.map((name) => {
    const dir = findInstalledPackage(name);
    if (!dir) throw new Error(`Package ${name} is not installed in sidecar/node_modules`);
    return { name, dir };
  });
  const copied = new Set();

  while (pending.length > 0) {
    const { name, dir } = pending.shift();
    await copyPackage(name, dir, pending, copied);
  }

  if (allowedCursorNativePackage && !copied.has(allowedCursorNativePackage)) {
    throw new Error(
      `Cursor runtime is missing ${allowedCursorNativePackage}. ` +
        `Install the platform package before building.`,
    );
  }

  console.log(
    `Copied Cursor SDK runtime packages: ${copied.size}` +
      (allowedCursorNativePackage ? ` (native: ${allowedCursorNativePackage})` : ""),
  );
}

await main();
