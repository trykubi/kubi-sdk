#!/usr/bin/env bash
# The one check for kubi-sdk: toolchain, spec and generated types current, types, lint, unit tests.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
. scripts/env.sh
echo "== toolchain"
kubi_need node "v26." node --version
kubi_need pnpm "12." pnpm --version
pnpm install --frozen-lockfile --silent
echo "== spec and generated types current"
scripts/gen.sh --check
echo "== types, lint, unit tests"
pnpm -s typecheck
node_modules/.bin/biome check . >/dev/null
node_modules/.bin/vitest run --silent
echo "== the package as published"
[ "$(node -p "require('./package.json').version")" = "$(sed -n "s/^export const VERSION = '\(.*\)'$/\1/p" src/index.ts)" ] || { echo "sdk: VERSION in src/index.ts differs from package.json" >&2; exit 1; }
scripts/pack-check.sh
echo "== kubi-sdk: check passed"
