#!/bin/bash
# scripts/db_migrate_leader.sh
# Apply Prisma migrations directly on PostgreSQL leader (bypass HAProxy read replicas)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$BACKEND_DIR/logs"
LOG_FILE="$LOG_DIR/db-migrations.log"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $*" | tee -a "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARN:${NC} $*" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR:${NC} $*" | tee -a "$LOG_FILE"
}

# Create logs directory
mkdir -p "$LOG_DIR"

log "=== Prisma Migration on PostgreSQL Leader ==="

# 1. Load current DATABASE_URL
if [ -f "$BACKEND_DIR/.env" ]; then
    export $(grep -v '^#' "$BACKEND_DIR/.env" | xargs)
    log "Loaded .env file"
else
    error ".env file not found in $BACKEND_DIR"
    exit 1
fi

# 2. Detect leader PostgreSQL
log "Detecting PostgreSQL leader..."

# Method 1: Check if DB_LEADER_IP is set in env
if [ -n "${DB_LEADER_IP:-}" ]; then
    LEADER_IP="$DB_LEADER_IP"
    log "Using DB_LEADER_IP from env: $LEADER_IP"
else
    # Method 2: Try common Patroni/PostgreSQL IPs
    CANDIDATE_IPS=("10.0.0.122" "10.0.0.123" "10.0.0.124" "10.0.0.125")
    LEADER_IP=""
    
    for ip in "${CANDIDATE_IPS[@]}"; do
        log "Testing PostgreSQL at $ip:5432..."
        
        # Try to connect and check if writable (not read-only)
        if timeout 2 bash -c "cat < /dev/null > /dev/tcp/$ip/5432" 2>/dev/null; then
            log "  → Port 5432 open on $ip"
            
            # Extract credentials from DATABASE_URL
            DB_USER=$(echo "$DATABASE_URL" | sed -n 's/.*\/\/\([^:]*\):.*/\1/p')
            DB_PASS=$(echo "$DATABASE_URL" | sed -n 's/.*:\([^@]*\)@.*/\1/p')
            DB_NAME=$(echo "$DATABASE_URL" | sed -n 's/.*\/\([^?]*\).*/\1/p')
            
            # Test if writable
            TEST_QUERY="SELECT pg_is_in_recovery();"
            RESULT=$(PGPASSWORD="$DB_PASS" psql -h "$ip" -U "$DB_USER" -d "$DB_NAME" -tAc "$TEST_QUERY" 2>/dev/null || echo "error")
            
            if [ "$RESULT" = "f" ]; then
                log "  ✓ $ip is LEADER (writable)"
                LEADER_IP="$ip"
                break
            elif [ "$RESULT" = "t" ]; then
                log "  → $ip is REPLICA (read-only)"
            else
                warn "  → Could not determine role of $ip"
            fi
        fi
    done
    
    if [ -z "$LEADER_IP" ]; then
        # Method 3: Fallback to HAProxy write port (if configured)
        warn "Could not auto-detect leader, trying HAProxy write endpoint..."
        LEADER_IP="10.0.0.10"  # HAProxy, hope it routes to leader for migrations
    fi
fi

log "Using PostgreSQL leader: $LEADER_IP"

# 3. Build leader DATABASE_URL
DB_USER=$(echo "$DATABASE_URL" | sed -n 's/.*\/\/\([^:]*\):.*/\1/p')
DB_PASS=$(echo "$DATABASE_URL" | sed -n 's/.*:\([^@]*\)@.*/\1/p')
DB_NAME=$(echo "$DATABASE_URL" | sed -n 's/.*\/\([^?]*\).*/\1/p')

LEADER_DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${LEADER_IP}:5432/${DB_NAME}"

log "Leader DATABASE_URL: postgresql://${DB_USER}:***@${LEADER_IP}:5432/${DB_NAME}"

# 4. Export for Prisma
export DATABASE_URL="$LEADER_DATABASE_URL"

# 5. Run Prisma migrate deploy
log "Running: npx prisma migrate deploy"

cd "$BACKEND_DIR"

if npx prisma migrate deploy 2>&1 | tee -a "$LOG_FILE"; then
    log "✓ Migrations applied successfully"
else
    error "✗ Migration failed"
    exit 1
fi

# 6. Generate Prisma Client
log "Running: npx prisma generate"

if npx prisma generate 2>&1 | tee -a "$LOG_FILE"; then
    log "✓ Prisma Client generated successfully"
else
    error "✗ Prisma generate failed"
    exit 1
fi

log "=== Migration Complete ==="
log "Log saved to: $LOG_FILE"

