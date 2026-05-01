#!/usr/bin/env bash
# =============================================================================
# reset-data.sh
# Wipes ALL incident data from Postgres and MongoDB.
# Run this after docker compose down to start fresh next time.
# =============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}${RED}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${RED}║           IMS DATABASE RESET — DESTRUCTIVE WIPE          ║${RESET}"
echo -e "${BOLD}${RED}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "${YELLOW}  This will PERMANENTLY DELETE:${RESET}"
echo -e "${YELLOW}    • All Work Items (Postgres: work_items)${RESET}"
echo -e "${YELLOW}    • All RCA Records (Postgres: rca_records)${RESET}"
echo -e "${YELLOW}    • All Signal Metrics (Postgres: signal_metrics)${RESET}"
echo -e "${YELLOW}    • All Raw Signals (MongoDB: raw_signals collection)${RESET}"
echo -e "${YELLOW}    • All Redis keys (debounce windows, dashboard cache)${RESET}"
echo ""
echo -e "${YELLOW}  Docker volumes (postgres_data, mongo_data, redis_data)${RESET}"
echo -e "${YELLOW}  will also be removed so no stale data survives a restart.${RESET}"
echo ""

# ── Confirmation prompt ───────────────────────────────────────────────────────
read -p "$(echo -e ${BOLD})  Are you sure? Type YES to continue: $(echo -e ${RESET})" CONFIRM
echo ""

if [ "$CONFIRM" != "YES" ]; then
  echo -e "${CYAN}  Aborted. Nothing was deleted.${RESET}"
  echo ""
  exit 0
fi

# ── Step 1: Shut down running containers if any ───────────────────────────────
echo -e "${CYAN}[1/5] Stopping all IMS containers (if running)...${RESET}"
docker compose down 2>/dev/null || true
echo -e "${GREEN}      ✓ Containers stopped${RESET}"
echo ""

# ── Step 2: Remove Docker named volumes ──────────────────────────────────────
echo -e "${CYAN}[2/5] Removing Docker named volumes...${RESET}"
echo -e "      Removing: mission-critical-ims_postgres_data"
docker volume rm mission-critical-ims_postgres_data 2>/dev/null \
  && echo -e "${GREEN}      ✓ Removed postgres_data${RESET}" \
  || echo -e "${YELLOW}      ⚠ postgres_data not found (already removed or never created)${RESET}"

echo -e "      Removing: mission-critical-ims_mongo_data"
docker volume rm mission-critical-ims_mongo_data 2>/dev/null \
  && echo -e "${GREEN}      ✓ Removed mongo_data${RESET}" \
  || echo -e "${YELLOW}      ⚠ mongo_data not found (already removed or never created)${RESET}"

echo -e "      Removing: mission-critical-ims_redis_data"
docker volume rm mission-critical-ims_redis_data 2>/dev/null \
  && echo -e "${GREEN}      ✓ Removed redis_data${RESET}" \
  || echo -e "${YELLOW}      ⚠ redis_data not found (already removed or never created)${RESET}"
echo ""

# ── Step 3: Start ONLY the databases (no backend/frontend) ───────────────────
echo -e "${CYAN}[3/5] Starting database containers to run SQL/Mongo wipe commands...${RESET}"
docker compose up -d postgres mongo redis
echo -e "      Waiting 15 seconds for databases to be ready..."
sleep 15
echo -e "${GREEN}      ✓ Databases ready${RESET}"
echo ""

# ── Step 4: Wipe Postgres ─────────────────────────────────────────────────────
echo -e "${CYAN}[4/5] Wiping Postgres tables...${RESET}"

docker exec ims_postgres psql -U ims_user -d ims_db -c "
  DO \$\$
  DECLARE
    row_count INTEGER;
  BEGIN
    -- Delete in dependency order (RCA references work_items)
    DELETE FROM rca_records;
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % rows from rca_records', row_count;

    DELETE FROM signal_metrics;
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % rows from signal_metrics', row_count;

    DELETE FROM work_items;
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % rows from work_items', row_count;
  END
  \$\$;
"

# Confirm counts are zero
echo ""
echo -e "      Verifying row counts after wipe:"
docker exec ims_postgres psql -U ims_user -d ims_db -c "
  SELECT
    'work_items'     AS table_name, COUNT(*) AS remaining_rows FROM work_items
  UNION ALL
  SELECT
    'rca_records'    AS table_name, COUNT(*) AS remaining_rows FROM rca_records
  UNION ALL
  SELECT
    'signal_metrics' AS table_name, COUNT(*) AS remaining_rows FROM signal_metrics;
"
echo -e "${GREEN}      ✓ Postgres wiped${RESET}"
echo ""

# ── Step 5: Wipe MongoDB ──────────────────────────────────────────────────────
echo -e "${CYAN}[5/5] Wiping MongoDB raw_signals collection...${RESET}"

docker exec ims_mongo mongosh \
  "mongodb://ims_user:ims_pass@localhost:27017/ims_signals?authSource=admin" \
  --quiet \
  --eval "
    const before = db.raw_signals.countDocuments();
    db.raw_signals.deleteMany({});
    const after = db.raw_signals.countDocuments();
    print('Deleted ' + before + ' raw signal documents. Remaining: ' + after);
  "

echo -e "${GREEN}      ✓ MongoDB wiped${RESET}"
echo ""

# ── Step 6: Flush Redis ───────────────────────────────────────────────────────
echo -e "${CYAN}[+]  Flushing Redis (debounce keys, dashboard cache)...${RESET}"
docker exec ims_redis redis-cli FLUSHALL
echo -e "${GREEN}      ✓ Redis flushed${RESET}"
echo ""

# ── Shut databases back down ──────────────────────────────────────────────────
echo -e "${CYAN}      Stopping database containers...${RESET}"
docker compose down
echo -e "${GREEN}      ✓ All containers stopped${RESET}"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║                  RESET COMPLETE ✓                        ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  All data has been wiped. Next time you run:"
echo -e "${BOLD}      docker compose up --build${RESET}"
echo -e "  you will start with a completely clean slate."
echo ""