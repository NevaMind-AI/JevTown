#!/bin/sh
# Workaround for a packaging bug in ghcr.io/get-convex/convex-dashboard:latest.
#
# The image's Next.js 16 / Turbopack production build emits its externalized dependencies under
# hash-suffixed alias names (`clsx-531b805f92b6415e`, `@radix-ui/react-tooltip-21ff86135f35dd27`,
# ...) that don't exist in node_modules -- the packages are only there under their real names in
# the pnpm store. Every route SSRs `_document.js`, so every page 500s.
#
# This links each alias to the real package. It is idempotent, and a no-op once the image is
# fixed upstream (there will be no aliases left to find).
set -e
cd /app/node_modules || exit 0
linked=0
for id in $(grep -rhoE "(@[a-z0-9._-]+/)?[a-z0-9._-]+-[0-9a-f]{16}" /app/.next/server/chunks/ 2>/dev/null | sort -u); do
  base=$(echo "$id" | sed -E 's/-[0-9a-f]{16}$//')
  if [ -e "$base" ]; then
    src="/app/node_modules/$base"
  else
    # pnpm store dir names flatten the scope separator: @scope/name -> @scope+name@version_...
    src=$(ls -d /app/node_modules/.pnpm/"$(echo "$base" | sed 's|/|+|')"@*/node_modules/"$base" 2>/dev/null | head -1)
  fi
  [ -n "$src" ] && [ -e "$src" ] || { echo "fix-dashboard-modules: unresolved $base" >&2; continue; }
  dir=$(dirname "$id"); [ "$dir" != "." ] && mkdir -p "$dir"
  ln -sfn "$src" "$id" && linked=$((linked + 1))
done
echo "fix-dashboard-modules: linked $linked aliased module(s)"
