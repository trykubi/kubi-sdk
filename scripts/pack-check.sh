#!/usr/bin/env bash
# Builds the package as npm will publish it, installs the tarball into an empty project and checks that it
# imports in Node and type-checks for a TypeScript user, so a release can't ship with broken exports.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
pnpm -s build >/dev/null
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pnpm pack --pack-destination "$tmp" >/dev/null
tgz="$(ls "$tmp"/*.tgz)"
tar -tzf "$tgz" | sort > "$tmp/files"
grep -qx 'package/dist/index.js' "$tmp/files" && grep -qx 'package/dist/index.d.ts' "$tmp/files"
! grep -E '^package/(src|test|scripts|spec)/' "$tmp/files" >/dev/null
mkdir "$tmp/app" && cd "$tmp/app"
printf '{"name":"app","private":true,"type":"module"}\n' > package.json
npm install --silent --no-audit --no-fund --ignore-scripts "$tgz" "typescript@$(node -p "require('$OLDPWD/node_modules/typescript/package.json').version")" >/dev/null
node -e "import('@trykubi/sdk').then(m => { if (typeof m.Kubi !== 'function' || !m.VERSION) process.exit(1) })"
cat > use.ts <<'TS'
import { Kubi, type Screen } from '@trykubi/sdk'
const kubi = new Kubi({ apiKey: 'kubi_x' })
export async function first(): Promise<Screen | undefined> {
  for await (const s of kubi.screens.all()) return s
}
TS
node_modules/.bin/tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --lib es2022,dom use.ts
echo "sdk: the packed package imports and type-checks"
