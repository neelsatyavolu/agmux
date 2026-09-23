#!/usr/bin/env bash
# Load Apple code-signing (+ optional notarization) credentials from 1Password
# into the environment variables Tauri's bundler expects.
#
# Usage (source, do not execute):
#   source scripts/load-apple-creds.sh
#
# Two-item layout (defaults):
#   Signing:  "Apple Developer ID Certificate"
#             - password field (or "certificate password")
#             - attachment: Developer ID Certificate.p12
#   Notary:   "Xanom Apple Dev Creds"  (optional; for notarization)
#             - Team ID, Key ID, issuer id, AuthKey_*.p8
#
# Exports:
#   APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD / APPLE_SIGNING_IDENTITY
#   APPLE_TEAM_ID (if present)
#   APPLE_API_KEY / APPLE_API_ISSUER / APPLE_API_KEY_PATH (if notary item complete)
#   AGMUX_APPLE_CREDS_DIR, AGMUX_APPLE_CERT_KIND, AGMUX_APPLE_CERT_EXPIRED
#
# Override:
#   AGMUX_APPLE_SIGNING_ITEM / AGMUX_APPLE_SIGNING_VAULT
#   AGMUX_APPLE_NOTARY_ITEM  / AGMUX_APPLE_NOTARY_VAULT
#   AGMUX_APPLE_1P_ITEM      (legacy: sets both to same item)

set -euo pipefail

# Legacy single-item override
if [ -n "${AGMUX_APPLE_1P_ITEM:-}" ]; then
  AGMUX_APPLE_SIGNING_ITEM="${AGMUX_APPLE_SIGNING_ITEM:-$AGMUX_APPLE_1P_ITEM}"
  AGMUX_APPLE_NOTARY_ITEM="${AGMUX_APPLE_NOTARY_ITEM:-$AGMUX_APPLE_1P_ITEM}"
fi

AGMUX_APPLE_SIGNING_ITEM="${AGMUX_APPLE_SIGNING_ITEM:-Apple Developer ID Certificate}"
AGMUX_APPLE_SIGNING_VAULT="${AGMUX_APPLE_SIGNING_VAULT:-Personal}"
AGMUX_APPLE_NOTARY_ITEM="${AGMUX_APPLE_NOTARY_ITEM:-Xanom Apple Dev Creds}"
AGMUX_APPLE_NOTARY_VAULT="${AGMUX_APPLE_NOTARY_VAULT:-Personal}"

# Back-compat for help messages that reference the "signing" item.
AGMUX_APPLE_1P_ITEM="$AGMUX_APPLE_SIGNING_ITEM"
AGMUX_APPLE_1P_VAULT="$AGMUX_APPLE_SIGNING_VAULT"

if ! command -v op >/dev/null 2>&1; then
  echo "error: 1Password CLI (op) not found on PATH" >&2
  return 1 2>/dev/null || exit 1
fi

if ! op account list >/dev/null 2>&1; then
  echo "error: 1Password CLI is not signed in (run: op signin)" >&2
  return 1 2>/dev/null || exit 1
fi

_op_field() {
  local item="$1" vault="$2" label="$3"
  op item get "$item" --vault "$vault" --fields "label=$label" --reveal 2>/dev/null || true
}

_op_file() {
  local item="$1" vault="$2" name="$3" dest="$4"
  op read "op://${vault}/${item}/${name}" --out-file "$dest" >/dev/null
}

_op_list_file_names() {
  local item="$1" vault="$2"
  op item get "$item" --vault "$vault" --format=json 2>/dev/null \
    | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(f.get("name","") for f in (d.get("files") or [])))' 2>/dev/null \
    || true
}

echo "Loading Apple signing cert from 1Password item '$AGMUX_APPLE_SIGNING_ITEM'..."

# Password: prefer dedicated label, then standard login password field.
CERT_PASS="$(_op_field "$AGMUX_APPLE_SIGNING_ITEM" "$AGMUX_APPLE_SIGNING_VAULT" "certificate password")"
if [ -z "$CERT_PASS" ]; then
  CERT_PASS="$(_op_field "$AGMUX_APPLE_SIGNING_ITEM" "$AGMUX_APPLE_SIGNING_VAULT" "password")"
fi
if [ -z "$CERT_PASS" ]; then
  echo "error: item '$AGMUX_APPLE_SIGNING_ITEM' is missing password / certificate password" >&2
  return 1 2>/dev/null || exit 1
fi

AGMUX_APPLE_CREDS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agmux-apple-creds.XXXXXX")"
chmod 700 "$AGMUX_APPLE_CREDS_DIR"
# Caller must delete AGMUX_APPLE_CREDS_DIR on EXIT (see dmg.sh cleanup).

P12_PATH="$AGMUX_APPLE_CREDS_DIR/certificate.p12"
P12_NAME=""
# Prefer known filenames, then first .p12 attachment on the item.
for candidate in \
  "Developer ID Certificate.p12" \
  "Apple Certificate.p12" \
  "certificate.p12" \
  "Certificates.p12"
do
  if _op_file "$AGMUX_APPLE_SIGNING_ITEM" "$AGMUX_APPLE_SIGNING_VAULT" "$candidate" "$P12_PATH" 2>/dev/null; then
    P12_NAME="$candidate"
    break
  fi
done
if [ -z "$P12_NAME" ]; then
  while IFS= read -r fname; do
    case "$fname" in
      *.p12|*.P12)
        if _op_file "$AGMUX_APPLE_SIGNING_ITEM" "$AGMUX_APPLE_SIGNING_VAULT" "$fname" "$P12_PATH" 2>/dev/null; then
          P12_NAME="$fname"
          break
        fi
        ;;
    esac
  done < <(_op_list_file_names "$AGMUX_APPLE_SIGNING_ITEM" "$AGMUX_APPLE_SIGNING_VAULT")
fi
if [ -z "$P12_NAME" ] || [ ! -s "$P12_PATH" ]; then
  echo "error: no .p12 attachment found on 1Password item '$AGMUX_APPLE_SIGNING_ITEM'" >&2
  return 1 2>/dev/null || exit 1
fi
chmod 600 "$P12_PATH"
echo "  p12:         $P12_NAME"

# --- optional notarization material from separate item ---
echo "Loading notarization creds from 1Password item '$AGMUX_APPLE_NOTARY_ITEM'..."
TEAM_ID="$(_op_field "$AGMUX_APPLE_NOTARY_ITEM" "$AGMUX_APPLE_NOTARY_VAULT" "Team ID")"
KEY_ID="$(_op_field "$AGMUX_APPLE_NOTARY_ITEM" "$AGMUX_APPLE_NOTARY_VAULT" "Key ID")"
ISSUER_ID="$(_op_field "$AGMUX_APPLE_NOTARY_ITEM" "$AGMUX_APPLE_NOTARY_VAULT" "issuer id")"

P8_PATH=""
if [ -n "$KEY_ID" ]; then
  P8_PATH="$AGMUX_APPLE_CREDS_DIR/AuthKey_${KEY_ID}.p8"
  if ! _op_file "$AGMUX_APPLE_NOTARY_ITEM" "$AGMUX_APPLE_NOTARY_VAULT" "AuthKey_${KEY_ID}.p8" "$P8_PATH" 2>/dev/null; then
    # Fall back to any AuthKey_*.p8 on the notary item.
    P8_PATH=""
    while IFS= read -r fname; do
      case "$fname" in
        AuthKey_*.p8|AuthKey_*.P8)
          P8_PATH="$AGMUX_APPLE_CREDS_DIR/$fname"
          if _op_file "$AGMUX_APPLE_NOTARY_ITEM" "$AGMUX_APPLE_NOTARY_VAULT" "$fname" "$P8_PATH" 2>/dev/null; then
            break
          fi
          P8_PATH=""
          ;;
      esac
    done < <(_op_list_file_names "$AGMUX_APPLE_NOTARY_ITEM" "$AGMUX_APPLE_NOTARY_VAULT")
  fi
  [ -n "$P8_PATH" ] && [ -f "$P8_PATH" ] && chmod 600 "$P8_PATH"
fi

# Extract leaf cert PEM for subject / dates / expiry checks.
_CERT_PEM="$AGMUX_APPLE_CREDS_DIR/leaf.pem"
if ! openssl pkcs12 -in "$P12_PATH" -passin "pass:${CERT_PASS}" -nokeys -clcerts -legacy 2>/dev/null \
  | openssl x509 -out "$_CERT_PEM" 2>/dev/null; then
  _KC="$AGMUX_APPLE_CREDS_DIR/inspect.keychain-db"
  security create-keychain -p "agmux-inspect" "$_KC" >/dev/null
  security set-keychain-settings -lut 300 "$_KC" >/dev/null
  security unlock-keychain -p "agmux-inspect" "$_KC" >/dev/null
  security import "$P12_PATH" -k "$_KC" -P "$CERT_PASS" -T /usr/bin/security >/dev/null 2>&1 || true
  security find-certificate -a -p "$_KC" 2>/dev/null | openssl x509 -out "$_CERT_PEM" 2>/dev/null || true
  security delete-keychain "$_KC" >/dev/null 2>&1 || true
fi

_CERT_SUBJECT=""
_CERT_NOT_BEFORE=""
_CERT_NOT_AFTER=""
AGMUX_APPLE_CERT_EXPIRED=0
if [ -s "$_CERT_PEM" ]; then
  _CERT_SUBJECT=$(openssl x509 -in "$_CERT_PEM" -noout -subject -nameopt RFC2253 2>/dev/null || true)
  _CERT_NOT_BEFORE=$(openssl x509 -in "$_CERT_PEM" -noout -startdate 2>/dev/null | sed 's/^notBefore=//')
  _CERT_NOT_AFTER=$(openssl x509 -in "$_CERT_PEM" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
  if ! openssl x509 -in "$_CERT_PEM" -checkend 0 -noout >/dev/null 2>&1; then
    AGMUX_APPLE_CERT_EXPIRED=1
  fi
  # Prefer OU= team id from cert when notary item has no Team ID.
  if [ -z "$TEAM_ID" ]; then
    TEAM_ID=$(printf '%s\n' "$_CERT_SUBJECT" | sed -n 's/.*OU=\([^,]*\).*/\1/p' | head -1)
  fi
fi

_CERT_CN=$(printf '%s\n' "$_CERT_SUBJECT" | sed -n 's/.*CN=\([^,]*\).*/\1/p' | head -1)

AGMUX_APPLE_CERT_KIND="unknown"
case "$_CERT_CN" in
  "Developer ID Application:"*) AGMUX_APPLE_CERT_KIND="developer-id" ;;
  "Developer ID Installer:"*)   AGMUX_APPLE_CERT_KIND="developer-id-installer" ;;
  "Apple Development:"*)        AGMUX_APPLE_CERT_KIND="apple-development" ;;
  "Apple Distribution:"*)       AGMUX_APPLE_CERT_KIND="apple-distribution" ;;
  "3rd Party Mac Developer"*)   AGMUX_APPLE_CERT_KIND="mac-app-store" ;;
  "Mac Developer:"*)            AGMUX_APPLE_CERT_KIND="mac-development" ;;
esac

export APPLE_CERTIFICATE
APPLE_CERTIFICATE=$(base64 < "$P12_PATH" | tr -d '\n')
export APPLE_CERTIFICATE_PASSWORD="$CERT_PASS"
export AGMUX_APPLE_CREDS_DIR
export AGMUX_APPLE_CERT_KIND
export AGMUX_APPLE_CERT_EXPIRED
export AGMUX_APPLE_CERT_NOT_AFTER="${_CERT_NOT_AFTER:-}"

if [ -n "$TEAM_ID" ]; then
  export APPLE_TEAM_ID="$TEAM_ID"
else
  unset APPLE_TEAM_ID 2>/dev/null || true
fi

if [ -n "$KEY_ID" ] && [ -n "$ISSUER_ID" ] && [ -n "$P8_PATH" ] && [ -f "$P8_PATH" ]; then
  export APPLE_API_KEY="$KEY_ID"
  export APPLE_API_ISSUER="$ISSUER_ID"
  export APPLE_API_KEY_PATH="$P8_PATH"
else
  unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH 2>/dev/null || true
fi

if [ -n "$_CERT_CN" ]; then
  export APPLE_SIGNING_IDENTITY="$_CERT_CN"
else
  unset APPLE_SIGNING_IDENTITY 2>/dev/null || true
fi

echo "  Team ID:     ${APPLE_TEAM_ID:-"(none)"}"
echo "  Cert CN:     ${_CERT_CN:-"(unknown — Tauri will infer)"}"
echo "  Cert kind:   $AGMUX_APPLE_CERT_KIND"
echo "  Valid:       ${_CERT_NOT_BEFORE:-?} → ${_CERT_NOT_AFTER:-?}"
if [ "$AGMUX_APPLE_CERT_EXPIRED" = "1" ]; then
  echo "  Status:      EXPIRED (codesign will report 'no identity found')"
else
  echo "  Status:      valid"
fi
if [ -n "${APPLE_API_KEY:-}" ]; then
  echo "  Notary:      API Key $APPLE_API_KEY from '$AGMUX_APPLE_NOTARY_ITEM'"
else
  echo "  Notary:      (not available — sign-only; need Key ID + issuer + p8 on '$AGMUX_APPLE_NOTARY_ITEM')"
fi

agmux_disable_notarization_env() {
  unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH 2>/dev/null || true
}

agmux_cert_is_usable() {
  [ "${AGMUX_APPLE_CERT_EXPIRED:-1}" = "0" ] && [ -n "${APPLE_CERTIFICATE:-}" ]
}

agmux_print_expired_cert_help() {
  cat >&2 <<EOF
error: Apple signing certificate in 1Password is expired (or not yet valid).

  Item:   $AGMUX_APPLE_SIGNING_ITEM
  CN:     ${_CERT_CN:-unknown}
  kind:   ${AGMUX_APPLE_CERT_KIND:-unknown}
  valid:  ${_CERT_NOT_BEFORE:-?} → ${_CERT_NOT_AFTER:-?}

codesign then fails with: "no identity found" (CSSMERR_TP_CERT_EXPIRED).

Fix: replace the .p12 (+ password) on "$AGMUX_APPLE_SIGNING_ITEM", then re-run ./dmg.sh
Until then: ./dmg.sh --local
EOF
}

agmux_require_developer_id() {
  if [ "${AGMUX_APPLE_CERT_EXPIRED:-1}" = "1" ]; then
    agmux_print_expired_cert_help
    return 1
  fi
  if [ "${AGMUX_APPLE_CERT_KIND:-}" != "developer-id" ]; then
    cat >&2 <<EOF
error: notarized macOS distribution requires a "Developer ID Application" certificate.

1Password item "$AGMUX_APPLE_SIGNING_ITEM" currently has:
  CN:   ${_CERT_CN:-unknown}
  kind: ${AGMUX_APPLE_CERT_KIND:-unknown}

Expected: Developer ID Application .p12 on "$AGMUX_APPLE_SIGNING_ITEM"
Notary API: Key ID + issuer + AuthKey_*.p8 on "$AGMUX_APPLE_NOTARY_ITEM"
EOF
    return 1
  fi
  return 0
}
