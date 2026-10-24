#!/usr/bin/env bash
# Fetches the shared libraries Tommyternal's macOS build expects to find in
# Homebrew, so the launcher can ship them itself (see play_tommyternal in
# src-tauri/src/lib.rs). Tommyternal's binary hard-links
#   /opt/homebrew/opt/sdl2-compat/lib/libSDL2-2.0.0.dylib
#   /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib  (+ libcrypto.3.dylib)
# and on a Mac without Homebrew dyld kills it before a window ever opens.
#
# Source is Homebrew's own published bottles, pinned by digest - the same
# bytes `brew install` would pour - using the arm64_sonoma builds, since
# Tommyternal itself targets macOS 14.0 and a newer bottle would quietly
# raise that floor. Bottles are stored "unrelocated" (their internal paths
# rewritten to @@HOMEBREW_PREFIX@@ placeholders), which invalidates the
# signature they were built with, so each dylib is re-signed ad-hoc here;
# Apple Silicon refuses to load an unsigned or mis-signed dylib at all.
#
# To bump a version: pick the new tag's arm64_sonoma digest from
#   curl -s -H "Authorization: Bearer QQ==" \
#     -H "Accept: application/vnd.oci.image.index.v1+json" \
#     https://ghcr.io/v2/homebrew/core/<repo>/manifests/<tag>
# (the sh.brew.bottle.digest annotation) and update the table below.
set -euo pipefail

cd "$(dirname "$0")/../src-tauri/resources"

# name  ghcr-repo  version  arm64_sonoma sha256
BOTTLES=(
  "sdl2-compat sdl2-compat 2.32.72 0be6cd6dc97e29bf12d30baf103f813f34b3fbd9c7a1027c29edb0df2d85f239"
  "openssl@3   openssl/3   3.6.4   01887accd1964e9940ba516509e948eed9850d58d55cc02ca52c503435750685"
)
# The dylibs this script produces (also listed in .gitignore and tauri.conf.json).
DYLIBS=(libSDL2-2.0.0.dylib libssl.3.dylib libcrypto.3.dylib)

sha256() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d' ' -f1
}

# Cleared first so the "did we get everything" check below can't be
# satisfied by a leftover copy from an earlier run.
rm -f "${DYLIBS[@]}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

for entry in "${BOTTLES[@]}"; do
  read -r name repo version digest <<<"$entry"
  archive="$work/$name.tar.gz"
  echo "Fetching $name $version (arm64_sonoma)"
  curl -fsSL -H "Authorization: Bearer QQ==" \
    "https://ghcr.io/v2/homebrew/core/$repo/blobs/sha256:$digest" -o "$archive"
  actual=$(sha256 "$archive")
  if [ "$actual" != "$digest" ]; then
    echo "Checksum mismatch for $name: expected $digest, got $actual" >&2
    exit 1
  fi
  tar -xzf "$archive" -C "$work"
  keg="$work/$name/$version"
  # License text travels with the binary, same as libSDL3-LICENSE.txt.
  license=$(find "$keg" -maxdepth 1 -iname 'LICENSE*' | head -1)
  if [ -z "$license" ]; then
    echo "No license file found in the $name bottle" >&2
    exit 1
  fi
  cp "$license" "${name%@*}-LICENSE.txt"
  for lib in "${DYLIBS[@]}"; do
    if [ -e "$keg/lib/$lib" ]; then cp -L "$keg/lib/$lib" .; fi
  done
done

for lib in "${DYLIBS[@]}"; do
  if [ ! -f "$lib" ]; then
    echo "$lib wasn't in any bottle - has upstream renamed it?" >&2
    exit 1
  fi
done
chmod 644 "${DYLIBS[@]}"

if command -v codesign >/dev/null; then
  codesign --force --sign - "${DYLIBS[@]}"
elif [ "$(uname)" = "Darwin" ]; then
  echo "codesign not found - these dylibs won't load unsigned" >&2
  exit 1
else
  echo "Not on macOS: skipped ad-hoc signing (only a macOS build ships these)"
fi

echo "Done: ${DYLIBS[*]}"
