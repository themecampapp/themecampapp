#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
# Restore drill: proves a backup can actually be restored, for any Postgres.
#   DATABASE_URL=<owner URL> scripts/restore-drill.sh <private-key-file> [encrypted-dump]
# Downloads the newest successful Backup artifact (unless a dump file is given), decrypts it
# with the age private key, restores it into a throwaway PostgreSQL container (PG_MAJOR, default
# 18; at least the dump's server version), and compares every table's row count with the
# database at DATABASE_URL (the one that was backed up). Everything is deleted afterwards.
# For the hosted service:
#   DATABASE_URL=$(neonctl connection-string --project-id "$NEON_PROJECT_ID" \
#     --role-name neondb_owner --database-name neondb) scripts/restore-drill.sh tca-backup.key
# Needs: docker, age, and gh (logged in) when no dump file is given. The counts are read with
# psql from PG_BIN or PATH when there is one (so DATABASE_URL may be on this machine), and from
# the container otherwise.
set -euo pipefail

key="${1:?usage: scripts/restore-drill.sh <private-key-file> [encrypted-dump]}"
dump_age="${2:-}"
[ -r "$key" ] || { echo "Can't read the key file: $key"; exit 1; }
: "${DATABASE_URL:?set DATABASE_URL to the owner connection of the database that was backed up}"

work=$(mktemp -d)
container="tca-restore-drill-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

if [ -z "$dump_age" ]; then
  run=$(gh run list --workflow backup.yml --status success --limit 1 --json databaseId -q '.[0].databaseId')
  [ -n "$run" ] || { echo "No successful backup run yet."; exit 1; }
  gh run download "$run" -D "$work" >/dev/null
  dump_age=$(find "$work" -name 'tca-*.dump.age' | head -1)
fi
echo "Backup: $(basename "$dump_age")"
age -d -i "$key" "$dump_age" > "$work/tca.dump"

docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=drill "postgres:${PG_MAJOR:-18}-alpine" >/dev/null
# Over TCP: on first boot the image runs a temporary server on the socket only, which answers
# pg_isready and then shuts down mid-restore.
ready=""
for _ in $(seq 1 30); do
  docker exec "$container" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "The throwaway Postgres didn't start"; exit 1; }
docker cp "$work/tca.dump" "$container:/tmp/tca.dump"
# --no-owner/--no-privileges: the drill database has none of the source's roles.
docker exec "$container" pg_restore --no-owner --no-privileges -U postgres -d postgres /tmp/tca.dump

restored() { docker exec "$container" psql -U postgres -d postgres -Atc "$1"; }
bin="${PG_BIN:+${PG_BIN%/}/}"
if command -v "${bin}psql" >/dev/null 2>&1; then
  source_db() { "${bin}psql" "$DATABASE_URL" -Atc "$1"; }
else
  source_db() { docker exec -e URL="$DATABASE_URL" "$container" sh -c 'psql "$URL" -Atc "$0"' "$1"; }
fi

# Every table in public, from the restored copy, counted in both. A table dropped from the source
# since the backup shows as missing there; one the backup lacks fails the drill below.
tables=$(restored "select tablename from pg_tables where schemaname = 'public' order by 1")
[ -n "$tables" ] || { echo "The backup restored no tables."; exit 1; }
n=$(echo "$tables" | wc -l | tr -d ' ')
expected=$(source_db "select count(*) from pg_tables where schemaname = 'public'")

echo
printf "%-24s %10s %10s\n" "table" "restored" "source"
for t in $tables; do
  r=$(restored "select count(*) from \"$t\"")
  s=$(source_db "select count(*) from \"$t\"" 2>/dev/null || echo "missing")
  printf "%-24s %10s %10s%s\n" "$t" "$r" "$s" "$([ "$r" = "$s" ] || echo "  (changed since the backup)")"
done
echo
if [ "$n" -lt "$expected" ]; then
  echo "The source has ${expected} tables but the backup restored only ${n}. If a migration added"
  echo "tables since the backup, take a new one and drill that; otherwise the dump is incomplete."
  exit 1
fi
echo "Restore drill passed: the backup decrypted and restored cleanly (${n} tables)."
