#!/usr/bin/env node
/**
 * Submits the iPhone app for App Store review through the App Store Connect API.
 *
 *   node scripts/asc-submit.mjs                         # submit the version being prepared
 *   node scripts/asc-submit.mjs --whats-new "Fixes"     # set What's New first (needed after 1.0)
 *   node scripts/asc-submit.mjs --dry-run               # show what would be submitted
 *
 * It attaches the newest processed build whose version (CFBundleShortVersionString)
 * matches the App Store version, then submits. Listing text, screenshots, review
 * notes/contact, privacy answers and pricing carry over between versions; change
 * them in App Store Connect when needed. Bump MARKETING_VERSION
 * (scripts/configure-xcode-project.rb) and create the next version in App Store
 * Connect before shipping an update.
 *
 * Credentials: the team API key in 1Password (see asc-profile.mjs).
 */
import { execFileSync } from 'node:child_process';
import { apiToken } from './asc-profile.mjs';

const APP_ID = '6818431146'; // agmux Remote
const VAULT = process.env.AGMUX_APPLE_VAULT || 'Personal';
const KEY_ITEM = process.env.AGMUX_APPLE_NOTARY_ITEM || 'Xanom Apple Dev Creds';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const whatsNewAt = args.indexOf('--whats-new');
const whatsNew = whatsNewAt >= 0 ? args[whatsNewAt + 1] : null;

const op = (...a) => execFileSync('op', a, { encoding: 'utf8' }).trim();
const field = (label) => op('item', 'get', KEY_ITEM, '--vault', VAULT, '--fields', `label=${label}`, '--reveal');

async function main() {
  const keyId = field('Key ID');
  const key = { keyId, issuerId: field('issuer id'), privateKey: op('read', `op://${VAULT}/${KEY_ITEM}/AuthKey_${keyId}.p8`) };
  const api = async (method, path, body) => {
    const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
      method, headers: { Authorization: `Bearer ${apiToken(key)}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(json.errors || []).map((e) => `${e.code}: ${e.detail}`).join('; ')}`);
    return json;
  };

  const version = (await api('GET', `/v1/apps/${APP_ID}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED`)).data[0];
  if (!version) throw new Error('No version is being prepared. Create the next version in App Store Connect first.');
  const versionString = version.attributes.versionString;

  const builds = (await api('GET', `/v1/builds?filter[app]=${APP_ID}&filter[preReleaseVersion.version]=${versionString}&filter[processingState]=VALID&sort=-uploadedDate&limit=1&fields[builds]=version,uploadedDate`)).data;
  if (!builds.length) throw new Error(`No processed build for ${versionString}. Run scripts/release-ios.sh and wait for processing.`);
  const build = builds[0];
  console.log(`Version ${versionString} ← build ${build.attributes.version}`);
  if (dryRun) return;

  await api('PATCH', `/v1/appStoreVersions/${version.id}/relationships/build`, { data: { type: 'builds', id: build.id } });
  if (whatsNew) {
    const loc = (await api('GET', `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data.find((l) => l.attributes.locale === 'en-US');
    await api('PATCH', `/v1/appStoreVersionLocalizations/${loc.id}`, { data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew } } });
  }

  // One open review submission per platform; reuse it if a previous run left one.
  const open = (await api('GET', `/v1/reviewSubmissions?filter[app]=${APP_ID}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW`)).data[0];
  const submission = open ?? (await api('POST', '/v1/reviewSubmissions', {
    data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: APP_ID } } } },
  })).data;
  const items = (await api('GET', `/v1/reviewSubmissions/${submission.id}/items`)).data;
  if (!items.length) {
    await api('POST', '/v1/reviewSubmissionItems', {
      data: { type: 'reviewSubmissionItems', relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
      } },
    });
  }
  const done = (await api('PATCH', `/v1/reviewSubmissions/${submission.id}`, {
    data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
  })).data;
  console.log(`Submitted for review: ${done.attributes.state}. Apple emails the account when the status changes.`);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
