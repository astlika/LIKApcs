#!/usr/bin/env bash
# Creates the local development role and databases for LIKApcs (PostgreSQL must be running).
# Usage: ./scripts/dev-db.sh [password]   — default password: likapcs_dev_password
set -euo pipefail
PASSWORD="${1:-likapcs_dev_password}"
PSQL=(psql -v ON_ERROR_STOP=1)
if command -v sudo >/dev/null && id postgres >/dev/null 2>&1; then PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1); fi

"${PSQL[@]}" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'likapcs') THEN
    CREATE ROLE likapcs LOGIN PASSWORD '${PASSWORD}' CREATEDB;
  END IF;
END \$\$;
SQL
for db in likapcs likapcs_test; do
  if ! "${PSQL[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1; then
    "${PSQL[@]}" -c "CREATE DATABASE ${db} OWNER likapcs"
  fi
done
echo "Databases ready. Connection string:"
echo "  LIKAPCS_DATABASE_URL=postgres://likapcs:${PASSWORD}@127.0.0.1:5432/likapcs"
