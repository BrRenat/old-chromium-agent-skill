#!/usr/bin/env bash
# Parse-level compatibility gate. Runs in ~1s and catches the failure mode that
# actually kills old-Chromium builds: syntax the parser rejects outright, which
# takes down the whole bundle rather than one feature.
#
# Run this on every edit. Reach for the browser only once this is clean.
#
# Arguments:
#   $1  glob of built JS to check (default: dist/**/*.js)
#
# Environment variables read: none.
#
# Exits 0 when clean, 2 when either gate fails.
set -uo pipefail

GLOB="${1:-dist/**/*.js}"
fail=0

# es6 is the example target here, matching the Chromium 53 default. Change it to
# your target's ES level — see "Using a different Chromium version" in SKILL.md.
echo "== es-check (parse level, es6 — your target's ES level) =="
# Flags: optional chaining, nullish coalescing, async/await, object spread,
# exponent operator — anything a parser of that vintage cannot read.
#
# Script mode (es-check's default) is deliberate — do NOT pass --module here.
# Chromium had no native ES module support before Chrome 61, so a bundle
# containing import/export is fatal at runtime on an older engine; --module
# would parse it happily and green-light exactly the thing this gate exists to
# stop.
npx --yes es-check es6 "$GLOB" || fail=1

echo
echo "== eslint-plugin-compat (API level) =="
# Catches what parses fine but is undefined at runtime: Object.values (54),
# Object.entries (54), Promise.prototype.finally (63), Array.flat (69),
# String.matchAll (73), globalThis (71).
if [[ -f .eslintrc.compat.json || -f eslint.compat.config.mjs ]]; then
  npx --yes eslint --no-eslintrc -c "$(ls .eslintrc.compat.json eslint.compat.config.mjs 2>/dev/null | head -1)" "$GLOB" || fail=1
else
  echo "no compat eslint config found — skipping (see SKILL.md to add one)" >&2
fi

echo
if [[ $fail -ne 0 ]]; then
  echo "STATIC CHECK FAILED — fix before launching the browser." >&2
  exit 2
fi
echo "static check clean"
