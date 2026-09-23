#!/usr/bin/env bash
# Updates the Homebrew cask formula after a new release.
# Called from the release CI workflow with: ./scripts/update-homebrew-cask.sh v1.0.1
#
# Requires:
#   - GH_TOKEN with push access to neel-xanom/homebrew-agmux
#   - The release DMGs must already be published to neel-xanom/agmux-releases

set -euo pipefail

TAG="${1:?Usage: update-homebrew-cask.sh <tag>}"
VERSION="${TAG#v}"
REPO="neel-xanom/agmux-releases"
TAP_REPO="neel-xanom/homebrew-agmux"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "==> Updating Homebrew cask for agmux ${VERSION}"

# Download both DMGs
echo "==> Downloading DMGs..."
gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "agmux_${VERSION}_aarch64.dmg" \
  --pattern "agmux_${VERSION}_x64.dmg" \
  --dir "${WORK_DIR}"

# Compute SHA256 hashes
SHA_ARM=$(shasum -a 256 "${WORK_DIR}/agmux_${VERSION}_aarch64.dmg" | awk '{print $1}')
SHA_INTEL=$(shasum -a 256 "${WORK_DIR}/agmux_${VERSION}_x64.dmg" | awk '{print $1}')

echo "  aarch64: ${SHA_ARM}"
echo "  x64:     ${SHA_INTEL}"

# Generate the cask formula
CASK_CONTENT=$(cat <<RUBY
cask "agmux" do
  version "${VERSION}"

  on_arm do
    sha256 "${SHA_ARM}"
    url "https://github.com/${REPO}/releases/download/v#{version}/agmux_#{version}_aarch64.dmg"
  end

  on_intel do
    sha256 "${SHA_INTEL}"
    url "https://github.com/${REPO}/releases/download/v#{version}/agmux_#{version}_x64.dmg"
  end

  name "agmux"
  desc "Desktop app for managing AI coding agents (Claude Code, Codex)"
  homepage "https://github.com/${REPO}"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :ventura

  app "agmux.app"

  zap trash: [
    "~/.agmux",
    "~/.xanom",
    "~/Library/Application Support/com.xanom.app",
    "~/Library/Caches/com.xanom.app",
    "~/Library/Logs/com.xanom.app",
    "~/Library/Preferences/com.xanom.app.plist",
    "~/Library/Saved Application State/com.xanom.app.savedState",
    "~/Library/WebKit/com.xanom.app",
  ]
end
RUBY
)

# Clone tap, update, push
# Note: we embed GH_TOKEN in the remote URL so that `git push` authenticates
# with the same token as `gh`. Without this, on self-hosted runners git falls
# back to the runner's local credential helper (which may be a different user).
: "${GH_TOKEN:?GH_TOKEN must be set with push access to ${TAP_REPO}}"

echo "==> Updating tap repo..."
git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/${TAP_REPO}.git" "${WORK_DIR}/tap"
echo "${CASK_CONTENT}" > "${WORK_DIR}/tap/Casks/agmux.rb"
# Remove legacy cask token if present (renamed xanom → agmux)
rm -f "${WORK_DIR}/tap/Casks/xanom.rb"

cd "${WORK_DIR}/tap"
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add Casks/agmux.rb
git add -u Casks/xanom.rb 2>/dev/null || true
git commit -m "agmux ${VERSION}"
git push origin main

echo "==> Done! Cask updated to ${VERSION}"
