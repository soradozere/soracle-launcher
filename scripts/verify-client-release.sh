#!/usr/bin/env bash
# Checks a client's current release against what's pinned in the manifest,
# and - after you confirm it looks legitimate - updates the pin. This is the
# one thing a maintainer needs to do when Tommyternal/OpenJO/JK2MV ship a new
# version and the in-app checksum warning shows up. See README.md's
# "Verifying a new client release" section for the full explanation.
#
# Usage: scripts/verify-client-release.sh <ClientName>
#   e.g. scripts/verify-client-release.sh TommyternalJK2MV
#        scripts/verify-client-release.sh OpenJO
#        scripts/verify-client-release.sh JK2MV
set -euo pipefail

GIST_ID="a5ac8df67ac85687d20b4901ae1f1af0"
CLIENT_NAME="${1:-}"

if [ -z "$CLIENT_NAME" ]; then
  echo "Usage: $0 <ClientName>   (e.g. TommyternalJK2MV, OpenJO, JK2MV)"
  exit 1
fi

command -v gh >/dev/null || { echo "Needs the GitHub CLI ('gh') installed and logged in."; exit 1; }

TMP_MANIFEST=$(mktemp)
TMP_DOWNLOAD=$(mktemp)
trap 'rm -f "$TMP_DOWNLOAD"' EXIT

echo "Fetching current manifest..."
gh api "gists/$GIST_ID" -q '.files."manifest.json".content' > "$TMP_MANIFEST"

URL=$(python3 -c "
import json, sys
m = json.load(open('$TMP_MANIFEST'))
mod = next((x for x in m['mods'] if x['name'] == '$CLIENT_NAME'), None)
if not mod:
    sys.exit('No client named \'$CLIENT_NAME\' in the manifest.')
print(mod['url'])
")

OLD_HASH=$(python3 -c "
import json
m = json.load(open('$TMP_MANIFEST'))
mod = next(x for x in m['mods'] if x['name'] == '$CLIENT_NAME')
print(mod.get('sha256', '(none pinned yet)'))
")

echo "Client:            $CLIENT_NAME"
echo "Download URL:       $URL"
echo "Currently pinned:  $OLD_HASH"
echo
echo "Downloading the current release..."
curl -sL "$URL" -o "$TMP_DOWNLOAD"
SIZE=$(wc -c < "$TMP_DOWNLOAD" | tr -d ' ')
NEW_HASH=$(shasum -a 256 "$TMP_DOWNLOAD" | awk '{print $1}')

echo "Downloaded:         $SIZE bytes"
echo "Its fingerprint:    $NEW_HASH"
echo

if [ "$OLD_HASH" = "$NEW_HASH" ]; then
  echo "That matches what's already pinned - nothing to do."
  exit 0
fi

cat <<EOF
This is DIFFERENT from what's currently pinned. That's expected if
$CLIENT_NAME shipped a new version - but take a moment to check it's
actually legitimate first (the real GitHub releases page, an announcement
from the maintainer, etc.) before approving it.
EOF
echo
read -r -p "Update the pinned fingerprint to this new value? [y/N] " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Cancelled - nothing changed."
  exit 0
fi

python3 -c "
import json
m = json.load(open('$TMP_MANIFEST'))
for mod in m['mods']:
    if mod['name'] == '$CLIENT_NAME':
        mod['sha256'] = '$NEW_HASH'
with open('$TMP_MANIFEST', 'w') as f:
    json.dump(m, f, indent=2)
    f.write('\n')
"

gh gist edit "$GIST_ID" -f manifest.json "$TMP_MANIFEST"
echo
echo "Done - $CLIENT_NAME is now pinned to the new release."
