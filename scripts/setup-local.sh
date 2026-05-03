#!/usr/bin/env bash
# Bootstrap local dev environment: DB + user + .env files + deps + migrations + seed.
# Re-runnable: skips work that's already done.
#
# Usage:
#   ./scripts/setup-local.sh
#
# Override defaults via env vars, e.g.:
#   DB_NAME=other PGPASSWORD=secret ./scripts/setup-local.sh

set -euo pipefail

DB_NAME="${DB_NAME:-my_money}"
DB_USER="${DB_USER:-mymoney}"
DB_PASSWORD="${DB_PASSWORD:-mymoney}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"

# Locate psql: PATH first, then default Windows install dirs.
if command -v psql >/dev/null 2>&1; then
  PSQL="psql"
else
  PSQL=""
  for candidate in "/c/Program Files/PostgreSQL"/*/bin/psql.exe; do
    if [[ -x "$candidate" ]]; then
      PSQL="$candidate"
      break
    fi
  done
  if [[ -z "$PSQL" ]]; then
    echo "ERROR: psql not found. Either add it to PATH or install Command Line Tools." >&2
    exit 1
  fi
fi
echo "Using psql: $PSQL"

# Get superuser password if not already in env.
if [[ -z "${PGPASSWORD:-}" ]]; then
  read -rsp "Postgres superuser ($PG_SUPERUSER) password: " PGPASSWORD
  echo
fi
export PGPASSWORD

run_super() {
  "$PSQL" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" -d "$1" -v ON_ERROR_STOP=1 "${@:2}"
}

echo "==> Verifying superuser credentials"
if ! run_super postgres -c "SELECT 1" >/dev/null 2>&1; then
  echo "ERROR: Cannot connect to Postgres as '$PG_SUPERUSER'. Wrong password?" >&2
  echo "       Try again, or set PGPASSWORD in the environment before running." >&2
  exit 1
fi

echo "==> Creating role '$DB_USER' (if missing)"
ROLE_EXISTS=$(run_super postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'")
if [[ "$ROLE_EXISTS" != "1" ]]; then
  run_super postgres -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD'"
else
  echo "    role already exists, skipping"
fi

echo "==> Creating database '$DB_NAME' (if missing)"
DB_EXISTS=$(run_super postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")
if [[ "$DB_EXISTS" != "1" ]]; then
  run_super postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER"
else
  echo "    database already exists, skipping"
fi

echo "==> Granting privileges"
run_super "$DB_NAME" -c "
  GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
  GRANT ALL ON SCHEMA public TO $DB_USER;
  ALTER SCHEMA public OWNER TO $DB_USER;
" >/dev/null

unset PGPASSWORD

# Generate JWT secret using node (already required by the project).
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

if [[ ! -f backend/.env ]]; then
  echo "==> Writing backend/.env"
  cat > backend/.env <<EOF
PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@$PG_HOST:$PG_PORT/$DB_NAME
JWT_SECRET=$JWT_SECRET
INITIAL_PASSWORD=changeme123
CMC_PRO_API_KEY=
CG_API_KEY=
TZ=America/Mexico_City
EOF
else
  echo "==> backend/.env already exists, skipping"
fi

if [[ ! -f frontend/.env ]]; then
  echo "==> Writing frontend/.env"
  echo "VITE_API_URL=http://localhost:3000" > frontend/.env
else
  echo "==> frontend/.env already exists, skipping"
fi

echo "==> Installing backend deps"
(cd backend && npm install --silent)

echo "==> Installing frontend deps"
(cd frontend && npm install --silent)

echo "==> Running migrations"
(cd backend && npm run migrate)

echo "==> Seeding initial user"
(cd backend && npm run seed)

cat <<EOF

Setup complete. To start the app:

  Terminal 1:  cd backend  && npm run dev
  Terminal 2:  cd frontend && npm run dev

Then open http://localhost:5173 and log in:
  username: zachery
  password: changeme123
EOF
