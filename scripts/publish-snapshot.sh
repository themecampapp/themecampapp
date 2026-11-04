#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the public repository's first commit (open-source plan 8.1 and 7.2): exactly the tree
# of this repository's HEAD, with no history, scanned before anything leaves this machine. It
# pushes nothing; it prints the push commands at the end.
#   scripts/publish-snapshot.sh <empty directory>
# Stops on the first problem:
#   - a dirty working tree, or package.json's version isn't 1.0.0;
#   - a data, dump, key or env file in the tree;
#   - anything gitleaks or trufflehog finds (trufflehog runs from Docker if it isn't installed);
#   - a source file without its license header.
# Then it lists every email address and URL host in the tree for a last read by eye.
set -euo pipefail

out=${1:?usage: scripts/publish-snapshot.sh <empty directory>}
if [ -e "$out" ] && [ -n "$(ls -A "$out")" ]; then
  echo "$out isn't empty." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit or stash your changes first: the snapshot is HEAD, not the working tree." >&2
  exit 1
fi
version=$(node -p 'require("./package.json").version')
if [ "$version" != 1.0.0 ]; then
  echo "package.json says $version; the first public commit is 1.0.0 (CHANGELOG.md too)." >&2
  exit 1
fi
head=$(git rev-parse --short=12 HEAD)
mkdir -p "$out"
git archive HEAD | tar -x -C "$out"
echo "Exported HEAD ($head) to $out."

# Files that must never be published (.gitignore keeps them out, but check what's there).
bad=$(cd "$out" && find . -type f \( -iname '*.csv' -o -iname '*.xls' -o -iname '*.xlsx' \
  -o -iname '*.dump' -o -iname '*.sql.gz' -o -iname '*.age' -o -iname '*.key' -o -iname '*.pem' \
  -o -name '.env*' -o -name '.dev.vars*' \) ! -name '.env.example' ! -name '.dev.vars.example')
if [ -n "$bad" ]; then
  echo "These files mustn't be published:" >&2
  echo "$bad" >&2
  exit 1
fi
echo "No data, dump, key or env files."

gitleaks detect --no-git --redact --source "$out" --no-banner
# trufflehog flags the made-up connection strings in the setup script and its test, which point
# at db.example (a reserved name that can't resolve). Those are the only results let through.
if command -v trufflehog >/dev/null; then
  found=$(trufflehog filesystem "$out" --json --no-update 2>/dev/null)
else
  found=$(docker run --rm -v "$(cd "$out" && pwd)":/src:ro trufflesecurity/trufflehog:3.88.0 \
    filesystem /src --json --no-update 2>/dev/null)
fi
real=$(echo "$found" | jq -c 'select(.Raw != null) | select(.Raw | test("@db\\.example[:/]") | not)
  | {file: .SourceMetadata.Data.Filesystem.file, detector: .DetectorName, verified: .Verified}')
if [ -n "$real" ]; then
  echo "trufflehog found these (rotate anything real before publishing):" >&2
  echo "$real" >&2
  exit 1
fi
echo "gitleaks and trufflehog found nothing (apart from the db.example placeholders)."

missing=$(cd "$out" && find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.sh' \) \
  -exec sh -c 'head -4 "$1" | grep -q "SPDX-License-Identifier: AGPL-3.0-or-later" || echo "$1"' _ {} \;)
if [ -n "$missing" ]; then
  echo "These files have no license header:" >&2
  echo "$missing" >&2
  exit 1
fi
echo "Every source file has its license header."

echo
echo "For a last read by eye: every email address and URL host in the tree, apart from reserved"
echo "example names (example.com, .test, …) and package-lock.json's registry links."
reserved='(^|[@.])(example\.(com|org|net)|example|test|invalid|localhost)$'
(cd "$out" && grep -rhoE --exclude=package-lock.json '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' . \
  | tr '[:upper:]' '[:lower:]' | grep -vE "$reserved" | sort | uniq -c | sort -rn) || true
(cd "$out" && grep -rhoE --exclude=package-lock.json 'https?://[A-Za-z0-9.-]+' . \
  | tr '[:upper:]' '[:lower:]' | grep -vE "$reserved" | sort | uniq -c | sort -rn) || true

(
  cd "$out"
  git init -q -b main
  git add -A
  git -c user.name="Curtis Kline" commit -q -s -m "Theme Camp App 1.0.0" \
    -m "The first public commit: the tree of the private repository's $head."
)
echo
echo "Committed in $out. Read the lists above, then:"
echo "  cd $out"
echo "  git remote add origin https://github.com/themecampapp/themecampapp"
echo "  git push -u origin main"
echo "  git tag v1.0.0 && git push origin v1.0.0"
