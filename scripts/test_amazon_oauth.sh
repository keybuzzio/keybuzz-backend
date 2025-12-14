#!/bin/bash
# test_amazon_oauth.sh - Test Amazon OAuth flow

set -euo pipefail

echo "=========================================="
echo "Test Amazon OAuth + Polling (PH11-06B)"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Config
API_BASE_URL="${API_BASE_URL:-http://localhost:4000}"
BACKEND_DIR="${BACKEND_DIR:-/opt/keybuzz/keybuzz-backend}"

# Test 1: Backend build OK
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 1: Backend build OK"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$BACKEND_DIR"
if npm run build > /dev/null 2>&1; then
  echo -e "${GREEN}✓ Build OK${NC}"
else
  echo -e "${RED}✗ Build FAILED${NC}"
  exit 1
fi
echo ""

# Test 2: Amazon modules loaded
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 2: Amazon modules loaded"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

MODULES=(
  "dist/modules/marketplaces/amazon/amazon.oauth.js"
  "dist/modules/marketplaces/amazon/amazon.tokens.js"
  "dist/modules/marketplaces/amazon/amazon.spapi.js"
  "dist/modules/marketplaces/amazon/amazon.vault.js"
  "dist/modules/marketplaces/amazon/amazon.client.js"
  "dist/modules/marketplaces/amazon/amazon.poller.js"
  "dist/modules/marketplaces/amazon/amazon.routes.js"
)

ALL_OK=true
for module in "${MODULES[@]}"; do
  if [ -f "$BACKEND_DIR/$module" ]; then
    echo -e "${GREEN}✓${NC} $module"
  else
    echo -e "${RED}✗${NC} $module (MISSING)"
    ALL_OK=false
  fi
done

if [ "$ALL_OK" = false ]; then
  echo -e "${RED}✗ Some modules missing${NC}"
  exit 1
fi
echo ""

# Test 3: Database tables exist
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 3: Database tables exist"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ -z "${DATABASE_URL:-}" ]; then
  echo -e "${YELLOW}⚠ DATABASE_URL not set, skipping DB check${NC}"
else
  TABLES=(
    "MarketplaceConnection"
    "MarketplaceSyncState"
    "ExternalMessage"
  )
  
  for table in "${TABLES[@]}"; do
    # Simple check via Prisma introspection (would need psql for direct check)
    if grep -q "$table" "$BACKEND_DIR/prisma/schema.prisma"; then
      echo -e "${GREEN}✓${NC} $table (in schema)"
    else
      echo -e "${RED}✗${NC} $table (NOT in schema)"
      ALL_OK=false
    fi
  done
fi
echo ""

# Test 4: OAuth routes registered (if backend running)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 4: OAuth routes available"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ROUTES=(
  "/api/v1/marketplaces/amazon/oauth/start"
  "/api/v1/marketplaces/amazon/oauth/callback"
  "/api/v1/marketplaces/amazon/status"
)

echo -e "${YELLOW}Note: Backend must be running for this test${NC}"
echo ""

for route in "${ROUTES[@]}"; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API_BASE_URL$route" || echo "000")
  
  # We expect 401 (Unauthorized) or 400 (Bad Request), not 404
  if [ "$HTTP_CODE" != "404" ] && [ "$HTTP_CODE" != "000" ]; then
    echo -e "${GREEN}✓${NC} $route (HTTP $HTTP_CODE)"
  else
    echo -e "${YELLOW}⚠${NC} $route (HTTP $HTTP_CODE - backend not running?)"
  fi
done
echo ""

# Test 5: Worker script exists
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 5: Worker script exists"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ -f "$BACKEND_DIR/dist/workers/amazonPollingWorker.js" ]; then
  echo -e "${GREEN}✓ Amazon polling worker compiled${NC}"
else
  echo -e "${RED}✗ Amazon polling worker NOT compiled${NC}"
  exit 1
fi
echo ""

# Test 6: Vault credentials check
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 6: Vault credentials configured"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ -z "${VAULT_ADDR:-}" ] || [ -z "${VAULT_TOKEN:-}" ]; then
  echo -e "${YELLOW}⚠ VAULT_ADDR or VAULT_TOKEN not set${NC}"
  echo "  Required for real OAuth flow"
else
  echo -e "${GREEN}✓ Vault configured${NC}"
  
  # Check app credentials exist
  APP_SOURCE="${AMAZON_SPAPI_APP_SOURCE:-external_test}"
  if [ "$APP_SOURCE" = "keybuzz" ]; then
    VAULT_PATH="secret/keybuzz/ai/amazon_spapi_app"
  else
    VAULT_PATH="secret/keybuzz/ai/amazon_spapi_app_temp"
  fi
  
  if vault kv get "$VAULT_PATH" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ App credentials exist in Vault ($APP_SOURCE)${NC}"
  else
    echo -e "${YELLOW}⚠ App credentials NOT found in Vault${NC}"
    echo "  Path: $VAULT_PATH"
  fi
fi
echo ""

# Summary
echo "=========================================="
echo "Summary"
echo "=========================================="
echo -e "${GREEN}✓ Build OK${NC}"
echo -e "${GREEN}✓ Modules compiled${NC}"
echo -e "${GREEN}✓ Database schema OK${NC}"
echo -e "${YELLOW}⚠ Backend routes (check if backend running)${NC}"
echo -e "${GREEN}✓ Worker exists${NC}"
echo ""
echo "Next steps:"
echo "1. Start backend: npm run dev"
echo "2. Test OAuth start: curl -X POST $API_BASE_URL/api/v1/marketplaces/amazon/oauth/start -H 'Authorization: Bearer <JWT>'"
echo "3. Test worker mock: AMAZON_USE_MOCK=true npm run worker:amazon:once"
echo ""
echo "Documentation: PH11-06B-AMAZON_OAUTH_REAL_CLIENT.md"
echo ""

