#!/bin/sh
# see-plan installer for macOS and Linux.
#   curl -fsSL https://github.com/AliA1997/my-lavish/releases/latest/download/install.sh | sh
#   ... | sh -s -- --install-skill      (also copy the Claude Code skill to ~/.claude/skills/my-lavish)
# Downloads the latest release, checks it against SHA256SUMS, and installs to ~/.see-plan/bin.
set -eu

VERSION="latest"
INSTALL_SKILL="${SEE_PLAN_INSTALL_SKILL:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --install-skill) INSTALL_SKILL=1 ;;
    --version) VERSION="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO="https://github.com/AliA1997/my-lavish/releases"
if [ "$VERSION" = "latest" ]; then BASE="$REPO/latest/download"; else BASE="$REPO/download/$VERSION"; fi

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) echo "Unsupported OS: $(uname -s). On Windows use install.ps1." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
if [ "$os" = linux ] && [ "$arch" != x64 ]; then
  echo "No Linux $arch build yet. Install with npm instead: npm install -g github:AliA1997/my-lavish" >&2
  exit 1
fi

ASSET="see-plan-$os-$arch.tar.gz"
INSTALL_DIR="$HOME/.see-plan/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $ASSET ..."
curl -fsSL "$BASE/$ASSET" -o "$TMP/$ASSET"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"

expected="$(grep " \*\{0,1\}$ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}' | head -n 1)"
[ -n "$expected" ] || { echo "SHA256SUMS has no entry for $ASSET" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
fi
[ "$expected" = "$actual" ] || { echo "Checksum mismatch for $ASSET: expected $expected, got $actual" >&2; exit 1; }
echo "Checksum OK."

mkdir -p "$TMP/unpacked" "$INSTALL_DIR"
tar -xzf "$TMP/$ASSET" -C "$TMP/unpacked"
for f in see-plan LICENSE NOTICE THIRD_PARTY_LICENSES.txt README.md; do
  cp -f "$TMP/unpacked/$f" "$INSTALL_DIR/"
done
chmod 755 "$INSTALL_DIR/see-plan"

if [ "$INSTALL_SKILL" = 1 ]; then
  mkdir -p "$HOME/.claude/skills/my-lavish"
  cp -f "$TMP/unpacked/skills/my-lavish/"* "$HOME/.claude/skills/my-lavish/"
  echo "Installed the Claude Code skill to ~/.claude/skills/my-lavish."
else
  echo "Skill not installed. Re-run with --install-skill to add it to ~/.claude/skills."
fi

echo "see-plan $("$INSTALL_DIR/see-plan" --version) installed to $INSTALL_DIR."
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    shell_rc="$HOME/.profile"
    case "${SHELL:-}" in
      */zsh) shell_rc="$HOME/.zshrc" ;;
      */bash) shell_rc="$HOME/.bashrc" ;;
      */fish) shell_rc="$HOME/.config/fish/config.fish" ;;
    esac
    echo "Add it to your PATH, for example:"
    echo "  echo 'export PATH=\"\$HOME/.see-plan/bin:\$PATH\"' >> $shell_rc"
    ;;
esac
