#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
# The superuser-free setup on plain Postgres, end to end, then a backup and restore round trip
# (open-source plan 3.2; CI runs it on PostgreSQL 16, 17 and 18). It does what "Database roles
# and grants" in docs/operating.md describes:
#   1. once, as an admin: an owner role (LOGIN CREATEROLE BYPASSRLS, not a superuser) and a
#      database it owns;
#   2. as that owner: db:roles, the migrations, db:grants, and the demo camp as data;
#   3. scripts/db-dump.sh, then scripts/restore-drill.sh on that dump.
#   ADMIN_URL=postgres://<superuser>@<host>/<db> scripts/plain-postgres-check.sh
# Needs psql and pg_dump (PG_BIN or PATH), age, docker, and npm dependencies installed. It
# creates the database tca_check and the role tca_check_owner, and drops both at the end. Run it
# on a fresh cluster: the app's roles are cluster-wide, and the owner must be the one creating them.
set -euo pipefail

: "${ADMIN_URL:?set ADMIN_URL to a superuser connection}"
bin="${PG_BIN:+${PG_BIN%/}/}"
admin() { "${bin}psql" "$ADMIN_URL" -v ON_ERROR_STOP=1 -qAtc "$1"; }
work=$(mktemp -d)
cleanup() {
  admin "drop database if exists tca_check with (force)" || true
  admin "drop owned by tca_check_owner cascade" 2>/dev/null || true
  admin "drop role if exists tca_check_owner" || true
  rm -rf "$work"
}
trap cleanup EXIT

if [ -n "$(admin "select 1 from pg_roles where rolname = 'app_runtime'")" ]; then
  echo "app_runtime already exists in this cluster: run this on a fresh one."
  exit 1
fi
owner_password=$(openssl rand -hex 16)
admin "create role tca_check_owner login createrole bypassrls password '${owner_password}'"
admin "create database tca_check owner tca_check_owner"
owner_url=$(node -e '
  const u = new URL(process.argv[1]);
  u.username = "tca_check_owner"; u.password = process.argv[2]; u.pathname = "/tca_check";
  console.log(u.toString());' "$ADMIN_URL" "$owner_password")
[ "$("${bin}psql" "$owner_url" -Atc "select rolsuper from pg_roles where rolname = current_user")" = f ]

export DATABASE_URL="$owner_url"
APP_RUNTIME_PASSWORD=$(openssl rand -hex 16) APP_PLATFORM_PASSWORD=$(openssl rand -hex 16) \
  APP_PROBE_PASSWORD=$(openssl rand -hex 16) npm run --silent db:roles
npx drizzle-kit migrate
npm run --silent db:grants
npm run --silent demo:seed

age-keygen -o "$work/key" 2>/dev/null
AGE_PUBLIC_KEY=$(age-keygen -y "$work/key") scripts/db-dump.sh "$work/tca.dump.age"
scripts/restore-drill.sh "$work/key" "$work/tca.dump.age" | tee "$work/drill.txt"
if grep -q "changed since the backup" "$work/drill.txt"; then
  echo "A restored table's row count differs from the source."
  exit 1
fi
