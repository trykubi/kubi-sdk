#!/usr/bin/env bash
# Takes the public spec from kubi-platform (beside this repository, or $KUBI_PLATFORM) into spec/ and generates
# src/types.gen.ts from it. With --check, changes nothing and fails if either is stale. Without kubi-platform
# (a clean clone of this repository alone), --check verifies the types against the committed spec.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
platform="${KUBI_PLATFORM:-../kubi-platform}"
src="$platform/api/spec/api/screens-v1.public.openapi.yaml"
check=0; [ "${1:-}" = "--check" ] && check=1
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if [ -f "$src" ]; then cp "$src" "$tmp/spec.yaml"; else cp spec/screens-v1.public.openapi.yaml "$tmp/spec.yaml"; fi
node_modules/.bin/openapi-typescript "$tmp/spec.yaml" -o "$tmp/types.gen.ts" --root-types --root-types-no-schema-prefix --default-non-nullable false >/dev/null
if [ "$check" = 1 ]; then
  cmp -s "$tmp/spec.yaml" spec/screens-v1.public.openapi.yaml || { echo "sdk: spec/ is stale; run scripts/gen.sh" >&2; exit 1; }
  cmp -s "$tmp/types.gen.ts" src/types.gen.ts || { echo "sdk: src/types.gen.ts is stale; run scripts/gen.sh" >&2; exit 1; }
  echo "sdk: spec and types are current"
else
  cp "$tmp/spec.yaml" spec/screens-v1.public.openapi.yaml
  cp "$tmp/types.gen.ts" src/types.gen.ts
  echo "sdk: spec and types regenerated"
fi
