#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
# Dumps the database and encrypts it with age, for any Postgres 16 or newer (the daily backup in
# .github/workflows/backup.yml, and the pre-migration snapshot of an instance whose config says
# "database": { "snapshot": "dump" }).
#   DATABASE_URL=<owner> AGE_PUBLIC_KEY=<age1…> scripts/db-dump.sh <out-file>
# Needs pg_dump and psql at least as new as the server (pg_dump refuses a newer server): PG_BIN
# names their folder (e.g. /usr/lib/postgresql/18/bin), or they're found on PATH. And age.
# Decrypt with: age -d -i <private-key-file> <out-file> > tca.dump
set -euo pipefail

out="${1:?usage: scripts/db-dump.sh <out-file>}"
: "${DATABASE_URL:?set DATABASE_URL to the owner connection}"
if [ -z "${AGE_PUBLIC_KEY:-}" ]; then
  echo "AGE_PUBLIC_KEY isn't set; see 'Snapshots, backups and restores' in docs/operating.md" >&2
  exit 1
fi
bin="${PG_BIN:+${PG_BIN%/}/}"

client=$("${bin}pg_dump" --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)*.*/\1/')
server=$("${bin}psql" "$DATABASE_URL" -Atc "show server_version_num")
if [ "$(( server / 10000 ))" -gt "$client" ]; then
  echo "The server is PostgreSQL $(( server / 10000 )) but pg_dump is ${client}: install a newer client" >&2
  exit 1
fi

# Written to a temporary name first, so a failed dump never leaves a file that looks complete.
"${bin}pg_dump" --format=custom --no-owner "$DATABASE_URL" | age -r "$AGE_PUBLIC_KEY" > "${out}.partial"
test -s "${out}.partial"
mv "${out}.partial" "$out"
echo "Dumped and encrypted to ${out}"
