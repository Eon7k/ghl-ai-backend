#!/usr/bin/env bash
# Verify Meta Ad Library (ads_archive) using the same token logic as competitor scans.
# Usage (from ghl-ai-backend):
#   chmod +x scripts/verify-competitor-meta.sh
#   ./scripts/verify-competitor-meta.sh
#   ./scripts/verify-competitor-meta.sh 123456789012
#
# Expects in .env (or the environment):
#   META_AD_LIBRARY_TOKEN  → used first when non-empty
#   OR  META_APP_ID + META_APP_SECRET  → APP_ID|APP_SECRET
# Optional: META_GRAPH_API_VERSION (e.g. v25.0)
# Note: ad_reached_countries must be a JSON array, e.g. ["US"] — the API rejects a bare "US" string.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PAGE_ID="${1:-20531316728}"
if [ -n "${META_AD_LIBRARY_TOKEN:-}" ] && [ "${META_AD_LIBRARY_TOKEN}" != "" ]; then
  TOKEN="${META_AD_LIBRARY_TOKEN}"
  echo "Using META_AD_LIBRARY_TOKEN (length ${#TOKEN})."
elif [ -n "${META_APP_ID:-}" ] && [ -n "${META_APP_SECRET:-}" ]; then
  TOKEN="${META_APP_ID}|${META_APP_SECRET}"
  echo "Using app access token from META_APP_ID + META_APP_SECRET (not printed)."
else
  echo "ERROR: Set META_AD_LIBRARY_TOKEN or META_APP_ID + META_APP_SECRET in .env"
  echo "  Get app id/secret from: https://developers.facebook.com/apps/ → your app → Settings → Basic"
  exit 1
fi

VRAW="${META_GRAPH_API_VERSION:-v21.0}"
V="v${VRAW#v}"

# Default JSON must match what the Node API uses (array of ISO codes).
COUNTRIES_JSON='["US","GB","CA"]'
if [ -n "${META_AD_REACHED_COUNTRIES_JSON:-}" ]; then
  COUNTRIES_JSON="${META_AD_REACHED_COUNTRIES_JSON}"
fi
echo "Graph version: $V  |  search_page_ids: $PAGE_ID  |  ad_reached_countries: $COUNTRIES_JSON"
echo "Calling Graph ads_archive (first id only)..."
OUT="$(mktemp)"
HTTP="$(curl -sS -o "$OUT" -w "%{http_code}" -G "https://graph.facebook.com/${V}/ads_archive" \
  --data-urlencode "search_page_ids=$PAGE_ID" \
  --data-urlencode "ad_reached_countries=$COUNTRIES_JSON" \
  --data-urlencode "ad_active_status=ALL" \
  --data-urlencode "fields=id,page_name,ad_snapshot_url" \
  --data-urlencode "limit=2" \
  --data-urlencode "access_token=$TOKEN")" || true

echo "HTTP status: $HTTP"
cat "$OUT"
echo
rm -f "$OUT"

if [ "$HTTP" != "200" ]; then
  echo
  echo "If you see an OAuth or permission error, check Meta App Dashboard: Marketing API / permissions for your use case, and that the app is not restricted for ads_archive in your region."
  exit 1
fi
echo "OK: token accepted; ads_archive responded. If data is empty, that Page may have no current ads in the US for this query—the scan will still work for website + OpenAI."
exit 0
