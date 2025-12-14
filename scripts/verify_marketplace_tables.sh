#!/bin/bash
# Verify marketplace tables exist

cd /opt/keybuzz/keybuzz-backend
source .env

export PGPASSWORD=$(echo $DATABASE_URL | sed -n 's/.*:\([^@]*\)@.*/\1/p')
DBHOST=$(echo $DATABASE_URL | sed -n 's/.*@\([^:]*\):.*/\1/p')
DBUSER=$(echo $DATABASE_URL | sed -n 's/.*\/\/\([^:]*\):.*/\1/p')
DBNAME=$(echo $DATABASE_URL | sed -n 's/.*\/\([^?]*\).*/\1/p')

echo "=== Verifying Marketplace Tables ==="
echo "Host: $DBHOST"
echo ""

psql -h 10.0.0.122 -U $DBUSER -d $DBNAME << 'EOF'
\dt "Marketplace*"
\dt "External*"
\dT "MarketplaceType"
\dT "MarketplaceConnectionStatus"
EOF

