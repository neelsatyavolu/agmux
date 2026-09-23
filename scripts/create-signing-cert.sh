#!/bin/bash
# One-time setup: create a self-signed code-signing cert for agmux so TCC
# (Documents/Desktop/Downloads access) grants persist across rebuilds.
# Cert CN stays "Xanom Dev Signing" to match existing keychains / CI secrets.
#
# Without a stable signing identity, every rebuild produces a new cdhash and
# macOS treats it as a different app — re-prompting for every protected-folder
# access. With this cert, the designated requirement is stable across rebuilds,
# so TCC grants stick after the first install.
#
# Safe to re-run; it's a no-op if the cert already exists.

set -e

CERT_NAME="Xanom Dev Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# Count matching certs directly in the keychain — NOT via `find-identity -v -p
# codesigning`, which filters out self-signed certs (they fail Apple policy
# validation). That filter was the bug: the check always said "not installed"
# even when the cert existed, so every rerun stacked another duplicate until
# codesign gave up with "ambiguous — matches X and X".
COUNT=$(security find-certificate -a -c "$CERT_NAME" -Z "$KEYCHAIN" 2>/dev/null \
        | grep -c "SHA-1 hash" || true)

if [ "$COUNT" = "1" ]; then
  echo "Cert '$CERT_NAME' already installed (1 match)."
  exit 0
fi

if [ "$COUNT" != "0" ]; then
  echo "ERROR: $COUNT duplicate '$CERT_NAME' certs in keychain."
  echo "Delete them first so codesign isn't ambiguous:"
  security find-certificate -a -c "$CERT_NAME" -Z "$KEYCHAIN" 2>/dev/null \
    | grep "SHA-1 hash" | awk '{print "  security delete-certificate -Z " $NF " \"" "'"$KEYCHAIN"'" "\""}'
  exit 1
fi

echo "Creating self-signed code-signing cert '$CERT_NAME'..."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

openssl genrsa -out "$TMP/key.pem" 2048 >/dev/null 2>&1

openssl req -x509 -new -key "$TMP/key.pem" \
  -out "$TMP/cert.pem" \
  -days 3650 \
  -subj "/CN=$CERT_NAME/O=Xanom/C=US" \
  -addext "extendedKeyUsage=codeSigning" \
  -addext "keyUsage=digitalSignature" \
  -addext "basicConstraints=CA:false" \
  >/dev/null 2>&1

# Convert to DER — unambiguous binary format that macOS's `security import`
# auto-detects reliably. Skipping PKCS12 avoids the LibreSSL ↔ Keychain MAC
# mismatch we hit earlier.
openssl x509 -in "$TMP/cert.pem" -out "$TMP/cert.der" -outform DER
openssl rsa  -in "$TMP/key.pem"  -out "$TMP/key.der"  -outform DER >/dev/null 2>&1

security import "$TMP/cert.der" \
  -k "$KEYCHAIN" \
  -T /usr/bin/codesign \
  -T /usr/bin/security \
  >/dev/null

security import "$TMP/key.der" \
  -k "$KEYCHAIN" \
  -T /usr/bin/codesign \
  -T /usr/bin/security \
  >/dev/null

# Persist the PEMs so they can be uploaded to GitHub Actions secrets for
# CI builds. Without these, the CI runner would either need a different
# signing identity (breaking TCC grants across local↔CI) or we'd have to
# extract them from the keychain (which requires interactive auth).
SIGN_DIR="$HOME/.xanom/signing"
mkdir -p "$SIGN_DIR"
chmod 700 "$SIGN_DIR"
cp "$TMP/cert.pem" "$SIGN_DIR/cert.pem"
cp "$TMP/key.pem"  "$SIGN_DIR/key.pem"
chmod 600 "$SIGN_DIR/cert.pem" "$SIGN_DIR/key.pem"

echo ""
echo "Cert installed. PEM material saved to $SIGN_DIR/ (600 perms)."
echo ""
echo "IMPORTANT: the first time codesign uses this key, macOS will show an"
echo "'allow' dialog — click 'Always Allow'. After that, builds are silent."
echo ""
echo "Local next steps:"
echo "  1) Run ./dmg.sh"
echo "  2) Reinstall agmux.app from the resulting DMG"
echo "  3) Grant permissions ONCE — they will persist across future rebuilds."
echo ""
echo "CI setup (one-time): upload the cert to GitHub Actions secrets:"
echo "  base64 -i $SIGN_DIR/cert.pem | pbcopy   # → secret XANOM_CERT_PEM"
echo "  base64 -i $SIGN_DIR/key.pem  | pbcopy   # → secret XANOM_KEY_PEM"
echo "  # also set XANOM_KEYCHAIN_PASSWORD to any random string (e.g. \$(openssl rand -hex 32))"
echo ""
echo "Optional: reset stale TCC grants from the old ad-hoc build so macOS"
echo "shows fresh prompts tied to the new stable identity:"
echo "  tccutil reset All com.xanom.app"
