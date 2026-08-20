#!/usr/bin/env bash
# Copies the crash-demo app into a fresh temporary git repo and runs it through phantom.
# Usage: npm run demo            (from the claude-phantom repo root)
#        bash examples/crash-demo/setup-demo.sh [--dry-run]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
target="${PHANTOM_DEMO_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/phantom-demo.XXXXXX")}"

rm -rf "$target"
mkdir -p "$target"
cp -R "$here"/. "$target"/
rm -f "$target/setup-demo.sh"

cd "$target"
git init -q
git -c user.name=demo -c user.email=demo@example.com add -A
git -c user.name=demo -c user.email=demo@example.com commit -qm "demo: initial commit (contains a crash bug)"

echo "demo repo: $target"
echo "running: phantom $* npm start"
echo
exec node "$root/bin/phantom.js" "$@" npm start
