// App-private subprocess. stdin: { clineBin, cwd, provider?, model? }.
// stdout is creation evidence only after native artifacts have been verified.
// Never accept a caller-supplied session ID or execute a prompt.
import { readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const allowed = new Set(['clineBin', 'cwd', 'provider', 'model']);
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) {
    throw Error('Invalid fresh Cline creation request');
  }
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || !statSync(input.cwd).isDirectory()) {
    throw Error('Cline working directory must exist');
  }
  const binary = realpathSync(input.clineBin);
  const packageRoot = dirname(dirname(binary));
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.name !== 'cline') {
    throw Error('Unsupported Cline package');
  }
  const require = createRequire(join(packageRoot, 'package.json'));
  // SDK exports only an ESM import condition, which require.resolve cannot select.
  const sdkRoot = require.resolve.paths('@cline/sdk').map(root => join(root, '@cline/sdk'))
    .find(root => existsSync(join(root, 'package.json')));
  if (!sdkRoot) throw Error('Cline SDK is unavailable');
  const sdkMetadata = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
  const entryExport = sdkMetadata.exports?.['.'];
  const entry = typeof entryExport === 'string' ? entryExport : entryExport?.import ?? entryExport?.default;
  if (sdkMetadata.name !== '@cline/sdk' || typeof entry !== 'string' || !entry.startsWith('./')) {
    throw Error('Unsupported Cline SDK export');
  }
  const sdkEntry = resolve(sdkRoot, entry);
  if (relative(sdkRoot, sdkEntry).startsWith('..')) throw Error('Invalid Cline SDK export path');
  // Persistence requires no HTTP, provider auth, agent runtime, hooks or tools.
  globalThis.fetch = async () => { throw Error('Network disabled during Cline precreation'); };
  const { resolveSessionBackend, ProviderSettingsManager, getProviderConfig } = await import(pathToFileURL(sdkEntry).href);
  if (typeof resolveSessionBackend !== 'function' || typeof ProviderSettingsManager !== 'function') {
    throw Error('Cline persistence capabilities are unavailable');
  }
  const settings = new ProviderSettingsManager();
  const saved = input.provider ? settings.getProviderSettings(input.provider) : settings.getLastUsedProviderSettings();
  // Match the CLI's built-in provider default; obtain its model from the SDK.
  const provider = input.provider ?? saved?.providerId ?? 'cline';
  const model = input.model ?? saved?.modelId ??
    (typeof getProviderConfig === 'function' ? getProviderConfig(provider)?.modelId : undefined);
  if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()) {
    throw Error('Configure a Cline provider and model before creating a session');
  }
  const backend = await resolveSessionBackend({ backendMode: 'local' });
  for (const method of ['ensureSessionsDir', 'readSessionManifest', 'createRootSessionWithArtifacts',
    'updateSessionStatus', 'writeSessionManifest']) {
    if (typeof backend?.[method] !== 'function') throw Error('Cline persistence capability missing');
  }
  const sessionId = randomUUID();
  const base = join(backend.ensureSessionsDir(), sessionId, sessionId);
  if (existsSync(dirname(base)) || backend.readSessionManifest(sessionId)) {
    throw Error('Fresh Cline session ID already exists');
  }
  const artifacts = await backend.createRootSessionWithArtifacts({
    sessionId, source: 'cli', pid: process.ppid, interactive: true,
    provider, model, cwd: input.cwd, workspaceRoot: input.cwd,
    enableTools: true, enableSpawn: true, enableTeams: true,
  });
  // Keep the prelaunch record idle and owned by the invoking app process.
  const updated = await backend.updateSessionStatus(sessionId, 'idle');
  if (!updated.updated) throw Error('Unable to persist idle Cline session');
  backend.writeSessionManifest(artifacts.manifestPath, { ...artifacts.manifest, status: 'idle' });
  const manifest = backend.readSessionManifest(sessionId);
  const messages = JSON.parse(readFileSync(artifacts.messagesPath, 'utf8'));
  if (manifest?.session_id !== sessionId || manifest.status !== 'idle' || manifest.prompt ||
      manifest.provider !== provider || manifest.model !== model || manifest.cwd !== input.cwd ||
      manifest.workspace_root !== input.cwd || manifest.interactive !== true ||
      resolve(artifacts.manifestPath) !== resolve(`${base}.json`) ||
      resolve(artifacts.messagesPath) !== resolve(`${base}.messages.json`) ||
      messages.sessionId !== sessionId || !Array.isArray(messages.messages) || messages.messages.length !== 0) {
    throw Error('Cline empty session verification failed');
  }
  process.stdout.write(JSON.stringify({ sessionId, provider, model }) + '\n');
}
main().then(() => process.exit(0), () => {
  // Never expose provider settings or third-party exception contents.
  process.stderr.write('Cline native precreation failed; no creation binding may be recorded.\n');
  process.exit(1);
});
