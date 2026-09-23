#!/usr/bin/env bash
# Sign nested Mach-O binaries under the Cursor SDK runtime so Apple notarization
# accepts them inside agmux.app/Contents/Resources.
#
# Required env (CI secrets or load-apple-creds.sh):
#   APPLE_CERTIFICATE            base64 of Developer ID Certificate.p12
#   APPLE_CERTIFICATE_PASSWORD   p12 unlock password
#   APPLE_SIGNING_IDENTITY       e.g. "Developer ID Application: … (TEAM)"
#
# Optional:
#   CURSOR_RUNTIME_ROOT          default: sidecar/dist/cursor-sdk-runtime
#   APPLE_CODESIGN_ENTITLEMENTS  default: src-tauri/entitlements.plist
#
# Exit 0 if no Mach-O files are present (dev builds without Cursor native deps).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_ROOT="${CURSOR_RUNTIME_ROOT:-$ROOT/sidecar/dist/cursor-sdk-runtime}"
ENTITLEMENTS="${APPLE_CODESIGN_ENTITLEMENTS:-$ROOT/src-tauri/entitlements.plist}"
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Ramakrishna Satyavolu (VTQW687WBQ)}"

if [[ ! -d "$RUNTIME_ROOT" ]]; then
  echo "sign-cursor-runtime-bins: no runtime dir at $RUNTIME_ROOT — skip"
  exit 0
fi

# Collect Mach-O executables / dylibs (bash 3.2-compatible; no mapfile).
BINS=()
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  ft=$(file -b "$f" 2>/dev/null || true)
  case "$ft" in
    *Mach-O*) BINS+=("$f") ;;
  esac
done < <(
  find "$RUNTIME_ROOT" -type f \( -perm -111 -o -name '*.dylib' -o -name '*.so' -o -name '*.node' \) 2>/dev/null || true
)

if [[ ${#BINS[@]} -eq 0 ]]; then
  echo "sign-cursor-runtime-bins: no Mach-O binaries under $RUNTIME_ROOT — skip"
  exit 0
fi

echo "sign-cursor-runtime-bins: found ${#BINS[@]} Mach-O file(s) to sign"

if [[ -z "${APPLE_CERTIFICATE:-}" || -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
  echo "error: APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD are required to sign nested Cursor bins" >&2
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/agmux-cursor-sign.XXXXXX")"
KC="$TMP/signing.keychain-db"
KCPASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
P12="$TMP/cert.p12"
CAS="$TMP/apple-cas"
LOGIN="$HOME/Library/Keychains/login.keychain-db"

cleanup() {
  security list-keychains -d user -s "$LOGIN" 2>/dev/null || true
  security delete-keychain "$KC" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo -n "$APPLE_CERTIFICATE" | base64 --decode > "$P12"
if [[ ! -s "$P12" ]]; then
  echo "error: APPLE_CERTIFICATE decoded to empty p12" >&2
  exit 1
fi

security delete-keychain "$KC" 2>/dev/null || true
security create-keychain -p "$KCPASS" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KCPASS" "$KC"

mkdir -p "$CAS"
for f in DeveloperIDG2CA.cer DeveloperIDCA.cer AppleRootCA-G2.cer AppleRootCA-G3.cer; do
  curl -fsSL -o "$CAS/$f" "https://www.apple.com/certificateauthority/$f"
done
curl -fsSL -o "$CAS/AppleIncRootCertificate.cer" \
  "https://www.apple.com/appleca/AppleIncRootCertificate.cer"

for cer in "$CAS"/*.cer; do
  security import "$cer" -k "$KC" -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1 || true
done
# G2 intermediate on login helps chain building on some self-hosted runners.
for cer in "$CAS"/DeveloperIDG2CA.cer "$CAS"/DeveloperIDCA.cer; do
  security import "$cer" -k "$LOGIN" -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1 || true
done

security import "$P12" -k "$KC" -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild >/dev/null

security set-key-partition-list \
  -S apple-tool:,apple:,codesign: -s -k "$KCPASS" "$KC" >/dev/null

security list-keychains -d user -s "$KC" "$LOGIN"
security unlock-keychain -p "$KCPASS" "$KC"

if ! security find-identity -v -p codesigning "$KC" | grep -F "$IDENTITY" >/dev/null; then
  echo "error: signing identity not found after import: $IDENTITY" >&2
  security find-identity -v -p codesigning "$KC" || true
  exit 1
fi

SIGN_ARGS=(
  --force
  --sign "$IDENTITY"
  --keychain "$KC"
  --timestamp
  --options runtime
)
if [[ -f "$ENTITLEMENTS" ]]; then
  SIGN_ARGS+=(--entitlements "$ENTITLEMENTS")
fi

for bin in "${BINS[@]}"; do
  echo "  codesign: $bin"
  codesign "${SIGN_ARGS[@]}" "$bin"
  # Verify without matching the leaf identity string (GitHub Actions masks
  # APPLE_SIGNING_IDENTITY in logs, and the leaf Authority line is that secret).
  INFO="$(codesign -dv --verbose=2 "$bin" 2>&1 || true)"
  if echo "$INFO" | grep -qE 'Signature=adhoc|flags=0x20002'; then
    echo "error: $bin still ad-hoc / linker-signed after codesign" >&2
    echo "$INFO" | head -20
    exit 1
  fi
  if ! echo "$INFO" | grep -q 'Authority=Developer ID Certification Authority'; then
    echo "error: $bin missing Developer ID chain after codesign" >&2
    echo "$INFO" | head -20
    exit 1
  fi
  if ! echo "$INFO" | grep -q 'Timestamp='; then
    echo "error: $bin missing secure timestamp after codesign" >&2
    echo "$INFO" | head -20
    exit 1
  fi
  if ! echo "$INFO" | grep -qE 'flags=0x[0-9a-fA-F]*\(runtime\)|flags=0x10000'; then
    echo "error: $bin missing hardened runtime after codesign" >&2
    echo "$INFO" | head -20
    exit 1
  fi
done

echo "sign-cursor-runtime-bins: signed ${#BINS[@]} binary(ies) as $IDENTITY"
