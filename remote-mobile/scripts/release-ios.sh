#!/usr/bin/env bash
# Build agmux for iPhone, sign it for the App Store and upload it to TestFlight.
#
#   scripts/release-ios.sh              # archive + upload to App Store Connect
#   scripts/release-ios.sh --no-upload  # archive + export build/agmux.ipa only
#
# Needs: the release Xcode (App Store Connect rejects beta-Xcode builds), Node,
# and the 1Password CLI signed in. Credentials come from 1Password only:
#   AGMUX_IOS_CERT_ITEM      "Apple Distribution Certificate"  AppleDistribution_VTQW687WBQ.p12 + password
#   AGMUX_APPLE_NOTARY_ITEM  "Xanom Apple Dev Creds"           team API key (profile + upload)
#   AGMUX_APPLE_VAULT        "Personal"
set -euo pipefail

UPLOAD=1
[ "${1:-}" = "--no-upload" ] && UPLOAD=0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
case "$DEVELOPER_DIR" in
  *beta*) echo "error: $DEVELOPER_DIR is a beta Xcode; App Store Connect rejects its builds" >&2; exit 1 ;;
esac

VAULT="${AGMUX_APPLE_VAULT:-Personal}"
CERT_ITEM="${AGMUX_IOS_CERT_ITEM:-Apple Distribution Certificate}"
KEY_ITEM="${AGMUX_APPLE_NOTARY_ITEM:-Xanom Apple Dev Creds}"
TEAM_ID="VTQW687WBQ"
BUNDLE_ID="dev.agmux.remote"
PROFILE_NAME="agmux Remote App Store"

op account list >/dev/null 2>&1 || { echo "error: 1Password CLI is not signed in (run: op signin)" >&2; exit 1; }

WORK="$(mktemp -d)"
KEYCHAIN="$WORK/signing.keychain-db"
ORIGINAL_KEYCHAINS="$(security list-keychains -d user | tr -d '"' | xargs)"
cleanup() {
  # shellcheck disable=SC2086
  security list-keychains -d user -s $ORIGINAL_KEYCHAINS
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "› Bundling the phone web app"
npm run cap:sync >/dev/null

echo "› Loading the distribution certificate into a temporary keychain"
op read "op://$VAULT/$CERT_ITEM/AppleDistribution_${TEAM_ID}.p12" --out-file "$WORK/dist.p12" >/dev/null
P12_PASSWORD="$(op read "op://$VAULT/$CERT_ITEM/password")"
KEYCHAIN_PASSWORD="$(openssl rand -hex 16)"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 3600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$WORK/dist.p12" -k "$KEYCHAIN" -P "$P12_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
unset P12_PASSWORD
# The .p12 carries Apple's intermediate; codesign only finds it on the search list.
# shellcheck disable=SC2086
security list-keychains -d user -s "$KEYCHAIN" $ORIGINAL_KEYCHAINS

echo "› Checking the App Store profile"
PROFILE_UUID="$(node scripts/asc-profile.mjs "$WORK/profile.mobileprovision")"
PROFILES_DIR="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$PROFILES_DIR"
cp "$WORK/profile.mobileprovision" "$PROFILES_DIR/$PROFILE_UUID.mobileprovision"

BUILD_NUMBER="$(date -u +%Y%m%d%H%M)"
echo "› Archiving build $BUILD_NUMBER"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$WORK/App.xcarchive" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" OTHER_CODE_SIGN_FLAGS="--keychain $KEYCHAIN" \
  archive -quiet

DESTINATION=export
[ "$UPLOAD" = 1 ] && DESTINATION=upload
cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$DESTINATION</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>$BUNDLE_ID</key><string>$PROFILE_NAME</string></dict>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

KEY_ID="$(op item get "$KEY_ITEM" --vault "$VAULT" --fields 'label=Key ID' --reveal)"
ISSUER_ID="$(op item get "$KEY_ITEM" --vault "$VAULT" --fields 'label=issuer id' --reveal)"
op read "op://$VAULT/$KEY_ITEM/AuthKey_${KEY_ID}.p8" --out-file "$WORK/AuthKey.p8" >/dev/null

mkdir -p build
if [ "$UPLOAD" = 1 ]; then echo "› Uploading to App Store Connect"; else echo "› Exporting build/agmux.ipa"; fi
xcodebuild -exportArchive -archivePath "$WORK/App.xcarchive" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" -exportPath "$WORK/export" \
  -authenticationKeyPath "$WORK/AuthKey.p8" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER_ID" \
  -quiet

if [ "$UPLOAD" = 1 ]; then
  echo "✓ Build $BUILD_NUMBER uploaded. It appears in TestFlight once Apple finishes processing (usually 5–15 minutes)."
else
  cp "$WORK/export/"*.ipa build/agmux.ipa
  echo "✓ build/agmux.ipa (build $BUILD_NUMBER)"
fi
