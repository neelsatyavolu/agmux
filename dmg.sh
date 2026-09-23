#!/usr/bin/env bash
# Build a signed agmux DMG, copy it to ~/Downloads, and (by default) install
# the .app into /Applications.
#
# Modes:
#   ./dmg.sh              Developer ID sign from 1Password (default; no notarize).
#   ./dmg.sh --apple      Developer ID + notarize + staple.
#   ./dmg.sh --apple --no-notarize
#                         Developer ID sign only (same as default signing).
#   ./dmg.sh --local      Self-signed "Xanom Dev Signing" (no 1Password).
#   ./dmg.sh --no-install Skip the /Applications replace step.
#
# 1Password:
#   Signing:  "Apple Developer ID Certificate"  (.p12 + password)
#   Notary:   "Xanom Apple Dev Creds"            (Team ID, Key ID, issuer, AuthKey_*.p8)
#   See scripts/load-apple-creds.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

APP_NAME="agmux"
VERSION=$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*"version": *"\(.*\)".*/\1/')
DOWNLOADS="${HOME}/Downloads"
# Self-signed fallback / --local. Matches tauri.conf.json signingIdentity.
LOCAL_CERT_NAME="Xanom Dev Signing"

# Default: Developer ID p12 from 1Password (sign only).
MODE="dev"            # dev | local | apple
NOTARIZE="auto"       # auto | yes | no
DO_INSTALL=1

usage() {
  cat <<'EOF'
Build a signed agmux DMG → ~/Downloads, optionally install to /Applications.

  ./dmg.sh                         Developer ID sign via 1Password (default).
  ./dmg.sh --apple                 Developer ID + notarize + staple.
  ./dmg.sh --apple --no-notarize   Developer ID sign only.
  ./dmg.sh --local                 Self-signed "Xanom Dev Signing" (no op).
  ./dmg.sh --no-install            Skip /Applications replace.

1Password signing: "Apple Developer ID Certificate" (p12 + password)
1Password notary:  "Xanom Apple Dev Creds" (API key + issuer + p8)
Requires `op` signed in for default / --apple.
EOF
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apple|--release|--notarize)
      MODE="apple"
      shift
      ;;
    --local)
      MODE="local"
      shift
      ;;
    --dev)
      MODE="dev"
      shift
      ;;
    --no-notarize)
      NOTARIZE="no"
      shift
      ;;
    --with-notarize)
      NOTARIZE="yes"
      MODE="apple"
      shift
      ;;
    --no-install)
      DO_INSTALL=0
      shift
      ;;
    -h|--help)
      usage 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage 1
      ;;
  esac
done

if [ "$NOTARIZE" = "auto" ]; then
  if [ "$MODE" = "apple" ]; then
    NOTARIZE="yes"
  else
    NOTARIZE="no"
  fi
fi

cleanup() {
  if [ -n "${AGMUX_APPLE_CREDS_DIR:-}" ] && [ -d "${AGMUX_APPLE_CREDS_DIR}" ]; then
    rm -rf "${AGMUX_APPLE_CREDS_DIR}"
  fi
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY \
        APPLE_API_ISSUER APPLE_API_KEY_PATH APPLE_SIGNING_IDENTITY \
        APPLE_TEAM_ID 2>/dev/null || true
}
trap cleanup EXIT

setup_local_self_signed() {
  if ! security find-certificate -a -c "$LOCAL_CERT_NAME" "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null \
       | grep -q "SHA-1 hash"; then
    echo "Signing cert '$LOCAL_CERT_NAME' not found in Keychain."
    echo "Running one-time setup..."
    bash "$ROOT/scripts/create-signing-cert.sh"
  fi
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY \
        APPLE_API_ISSUER APPLE_API_KEY_PATH APPLE_TEAM_ID 2>/dev/null || true
  export APPLE_SIGNING_IDENTITY="$LOCAL_CERT_NAME"
  echo "Local mode: signing with '$LOCAL_CERT_NAME' (not notarized)."
}

setup_developer_id_from_1p() {
  local want_notary="$1" # yes | no
  # shellcheck disable=SC1091
  if ! source "$ROOT/scripts/load-apple-creds.sh"; then
    return 1
  fi
  if ! agmux_cert_is_usable; then
    agmux_print_expired_cert_help
    return 1
  fi
  if ! agmux_require_developer_id; then
    return 1
  fi
  if [ "$want_notary" = "yes" ]; then
    if [ -z "${APPLE_API_KEY:-}" ] || [ -z "${APPLE_API_ISSUER:-}" ] || [ -z "${APPLE_API_KEY_PATH:-}" ]; then
      echo "error: notarization needs Key ID + issuer id + AuthKey_*.p8 on 'Xanom Apple Dev Creds'" >&2
      return 1
    fi
    echo "Apple mode: Developer ID sign + notarize."
  else
    agmux_disable_notarization_env
    echo "Dev mode: Developer ID sign only (not notarized)."
  fi
  return 0
}

if [ "$MODE" = "apple" ]; then
  if ! setup_developer_id_from_1p "$NOTARIZE"; then
    exit 1
  fi

elif [ "$MODE" = "dev" ]; then
  # Developer ID from 1Password — never notarize on default path.
  if ! setup_developer_id_from_1p "no"; then
    echo "warning: could not load Developer ID from 1Password; falling back to self-signed." >&2
    # Drop any partial Apple env so Tauri does not import a bad p12.
    unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY \
          APPLE_API_ISSUER APPLE_API_KEY_PATH APPLE_TEAM_ID 2>/dev/null || true
    if [ -n "${AGMUX_APPLE_CREDS_DIR:-}" ] && [ -d "${AGMUX_APPLE_CREDS_DIR}" ]; then
      rm -rf "${AGMUX_APPLE_CREDS_DIR}"
      unset AGMUX_APPLE_CREDS_DIR
    fi
    setup_local_self_signed
  fi

else
  # --local: stable self-signed identity for TCC across rebuilds.
  setup_local_self_signed
fi

echo "Building sidecar..."
# Install sidecar deps first — a fresh checkout has no node_modules and
# `npm run build` (which invokes esbuild) fails to resolve
# @anthropic-ai/claude-agent-sdk without them. `npm ci` is the
# reproducible-build flavor; falls back to `npm install` if the lockfile
# is out of sync (e.g., after a dep bump on this branch).
(
  cd sidecar
  (npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund)
  npm run build
)

# Purge stale build caches so the DMG always ships the current source.
# Without this, Vite's chunk cache and a pre-existing dist/ can cause
# Tauri to embed a frontend bundle from a prior build, producing a DMG
# whose UI lags the Rust binary (silent — no error, just missing code).
echo "Purging stale build caches (dist, node_modules/.vite)..."
rm -rf dist node_modules/.vite

echo "Building $APP_NAME DMG (mode=$MODE, notarize=$NOTARIZE)..."
npx tauri build --bundles dmg

APP="src-tauri/target/release/bundle/macos/${APP_NAME}.app"
if [ -d "$APP" ]; then
  SIG=$(codesign -dv "$APP" 2>&1 | grep -E '^Authority=|^TeamIdentifier=|^Signature=' | head -5 || true)
  if echo "$SIG" | grep -qi 'adhoc\|Signature=adhoc'; then
    echo "WARNING: app bundle is still ad-hoc signed. TCC grants will not persist."
    echo "$SIG"
  else
    echo "Signed bundle verified:"
    codesign -dv --verbose=2 "$APP" 2>&1 | grep -E '^Authority=|^Identifier=|^TeamIdentifier=|^Signature=' || true
  fi
  if [ "$MODE" = "apple" ] && [ "$NOTARIZE" = "yes" ]; then
    echo "Checking Gatekeeper assessment (post-notarize)..."
    spctl --assess --type execute --verbose "$APP" 2>&1 || true
  fi
fi

DMG=$(find src-tauri/target/release/bundle/dmg -name "*.dmg" 2>/dev/null | head -1)

if [ -z "$DMG" ]; then
  echo "Error: DMG not found after build."
  exit 1
fi

DEST="$DOWNLOADS/${APP_NAME}_${VERSION}.dmg"
mv "$DMG" "$DEST"

echo "Done: $DEST"

if [ "$DO_INSTALL" -eq 0 ]; then
  echo "Skipping /Applications install (--no-install)."
  exit 0
fi

# Auto-install the freshly-built .app into /Applications so iterative
# rebuilds don't leave the user running a stale installed bundle. Tauri
# cleans `$APP` after bundling, so we mount the DMG we just produced and
# copy from there. Kills any running instance first (launchd holds the
# old binary open and would reject the overwrite otherwise).
INSTALLED="/Applications/${APP_NAME}.app"
echo "Replacing $INSTALLED with fresh build..."
pkill -f "${APP_NAME}.app/Contents/MacOS" 2>/dev/null || true
sleep 0.5
MOUNT=$(hdiutil attach -nobrowse -noverify -noautoopen "$DEST" | tail -1 | awk '{for (i=3; i<=NF; i++) printf "%s ", $i; print ""}' | sed 's/ *$//')
if [ -n "$MOUNT" ] && [ -d "$MOUNT/${APP_NAME}.app" ]; then
  rm -rf "$INSTALLED"
  cp -R "$MOUNT/${APP_NAME}.app" "$INSTALLED"
  hdiutil detach "$MOUNT" -quiet || true
  # Local installs: drop quarantine so the fresh build opens without Gatekeeper nags.
  xattr -dr com.apple.quarantine "$INSTALLED" 2>/dev/null || true
  echo "Installed: $INSTALLED"
  echo "Launch with: open '$INSTALLED'"
else
  echo "Warning: could not mount DMG for auto-install (MOUNT='$MOUNT')"
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
fi
