#!/usr/bin/env node
/**
 * Copy the production remote PWA into www/ for Capacitor.
 * Uses the canonical remote-relay/public PWA; legacy checkouts are fallbacks.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const www = join(root, 'www');
const monorepo = resolve(root, '..');

const candidates = [
  // Canonical phone UI, shared with the Worker deployment.
  join(monorepo, 'remote-relay/public'),
  // Legacy mirror, only for checkouts without the in-repo PWA.
  resolve(monorepo, '../xanom-website/public/remote'),
  resolve(process.env.HOME || '', 'Documents/GitHub/xanom-website/public/remote'),
];

const src = candidates.find((p) => existsSync(p) && (existsSync(join(p, 'app.html')) || existsSync(join(p, 'index.html'))));
if (!src) {
  console.error('No remote PWA source found. Looked in:\n' + candidates.map((c) => `  ${c}`).join('\n'));
  process.exit(1);
}

mkdirSync(www, { recursive: true });

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === 'design.html') continue; // design preview only
    const a = join(from, name);
    const b = join(to, name);
    const st = statSync(a);
    if (st.isDirectory()) copyTree(a, b);
    else cpSync(a, b);
  }
}

copyTree(src, www);

// Capacitor native bridge (status bar + deep-link pair). Kept in repo; re-copied each sync.
const bridgeSrc = join(root, 'native-bridge.js');
const bridgeWww = join(www, 'native-bridge.js');
if (existsSync(bridgeSrc)) cpSync(bridgeSrc, bridgeWww);

function prepareHtml(html) {
  // Absolute marketing-site favicon → local icon when bundled
  html = html.replace(/href="\/favicon\.png"/g, 'href="icons/agmux.png"');
  // Inject native bridge once (before any app script that may read hash).
  // The canonical web page never ships it — the web build would 404.
  if (!html.includes('<script src="native-bridge.js"')) {
    html = html.replace('</head>', '<script src="native-bridge.js" defer></script>\n</head>');
  }
  // Mark shell so CSS can tweak safe-area if needed later
  if (!html.includes('data-shell=')) {
    html = html.replace('<html', '<html data-shell="capacitor"');
  }
  return html;
}

// Capacitor expects index.html
const appHtml = join(www, 'app.html');
const indexHtml = join(www, 'index.html');
if (existsSync(appHtml)) {
  const html = prepareHtml(readFileSync(appHtml, 'utf8'));
  writeFileSync(indexHtml, html);
  writeFileSync(appHtml, html);
} else if (existsSync(indexHtml)) {
  writeFileSync(indexHtml, prepareHtml(readFileSync(indexHtml, 'utf8')));
}

// Ensure manifest exists
const manifestPath = join(www, 'manifest.webmanifest');
if (!existsSync(manifestPath)) {
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        name: 'agmux Remote',
        short_name: 'agmux',
        description: 'Control the coding agents running in agmux on your Mac from your phone',
        start_url: '.',
        display: 'standalone',
        background_color: '#081410',
        theme_color: '#081410',
        orientation: 'portrait-primary',
      },
      null,
      2,
    ) + '\n',
  );
}

console.log(`Synced remote PWA → www/ (from ${src})`);
for (const name of readdirSync(www)) {
  console.log(`  ${name}`);
}
