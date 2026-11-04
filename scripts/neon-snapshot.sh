#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
# Creates a snapshot branch of the production Neon branch, then prunes older snapshots with
# the same prefix so only the newest 3 remain (Neon Free allows 10 branches).
# Needs NEON_API_KEY and NEON_PROJECT_ID. Usage: scripts/neon-snapshot.sh <label>
# SNAPSHOT_PREFIX defaults to "pre-migration" (CI deploys); imports use "pre-import", so the
# two kinds never prune each other.
set -euo pipefail

label="${1:?usage: neon-snapshot.sh <label>}"
neon() { npx --yes neonctl@latest "$@" --project-id "$NEON_PROJECT_ID" --api-key "$NEON_API_KEY"; }

prefix="${SNAPSHOT_PREFIX:-pre-migration}"
name="${prefix}-${label}"
if neon branches get "$name" >/dev/null 2>&1; then
  echo "Snapshot ${name} already exists"
else
  neon branches create --name "$name" --output json >/dev/null
  echo "Created snapshot branch ${name}"
fi

neon branches list --output json \
  | PREFIX="${prefix}-" node -e '
    const branches = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const list = (branches.branches ?? branches)
      .filter((b) => b.name.startsWith(process.env.PREFIX))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const b of list.slice(3)) console.log(b.id);
  ' \
  | while read -r id; do
      neon branches delete "$id" >/dev/null
      echo "Pruned old snapshot ${id}"
    done
