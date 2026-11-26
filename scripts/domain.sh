#!/bin/sh
# Points the hub at a Mood-owned address (default hub.moodstudio.co) once the DNS record exists.
#
#   1. In Cloudflare (moodstudio.co → DNS) add:  CNAME  hub  →  moodfilms.github.io   (Proxy status: DNS only)
#   2. Run:  sh scripts/domain.sh            (or: sh scripts/domain.sh clients.moodstudio.co)
#
# GitHub then issues the HTTPS certificate (usually within 15 minutes) and the github.io link redirects here.
set -e
DOMAIN="${1:-hub.moodstudio.co}"
REPO=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("config/clients.json","utf8")).hub.repo)')
TARGET="$(echo "$REPO" | cut -d/ -f1).github.io"
cd "$(dirname "$0")/.."
echo "Checking DNS for $DOMAIN …"
CNAME=$(dig +short CNAME "$DOMAIN" | sed 's/\.$//')
if [ "$CNAME" != "$TARGET" ]; then
  echo "Not yet: $DOMAIN should be a CNAME to $TARGET (currently: '${CNAME:-nothing}')."
  echo "Add the record in Cloudflare, wait a minute, then run this again."; exit 1
fi
echo "$DOMAIN" > docs/CNAME
gh api -X PUT "repos/$REPO/pages" -f "cname=$DOMAIN" -F https_enforced=false >/dev/null
git add docs/CNAME && git commit -q -m "Serve the hub at $DOMAIN" && git push -q
echo "Done. GitHub is issuing the certificate for https://$DOMAIN (check: gh api repos/$REPO/pages --jq .https_certificate.state)."
echo "Once it says 'approved', enforce HTTPS:  gh api -X PUT repos/$REPO/pages -F https_enforced=true"
