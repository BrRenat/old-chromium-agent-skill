#!/usr/bin/env bash
# Launch an old Chromium inside a CrossOver bottle with the DevTools Protocol
# open, then block until CDP actually answers.
# Idempotent: kills any prior instance first, so a run never validates a stale
# browser that is still holding the profile.
#
# Environment variables read:
#   CX_BOTTLE   CrossOver bottle name          (default: old-chromium)
#   CX_EXE      Windows path to chrome.exe     (default: C:\chrome-win32 2\chrome.exe)
#   CDP_PORT    DevTools Protocol port         (default: 9222)
#   CX_PROFILE  Windows path for --user-data-dir (default: C:\cxprofile)
#   CX_BIN      path to CrossOver's cxstart    (default: the CrossOver.app bundle path)
#   CX_UA       --user-agent string            (default: a plain desktop Chrome 53 UA)
#   CX_LOG      browser stdout/stderr log      (default: ./cx-artifacts/chrome.log)
#
# Exits 0 once CDP responds on CDP_PORT, 1 if cxstart is missing or the browser
# never came up.
set -euo pipefail

BOTTLE="${CX_BOTTLE:-old-chromium}"
EXE="${CX_EXE:-C:\\chrome-win32 2\\chrome.exe}"
PORT="${CDP_PORT:-9222}"
PROFILE="${CX_PROFILE:-C:\\cxprofile}"
CX="${CX_BIN:-/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/cxstart}"
UA="${CX_UA:-Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.143 Safari/537.36}"
LOG="${CX_LOG:-./cx-artifacts/chrome.log}"

if [[ ! -x "$CX" ]]; then
  echo "cxstart not found at $CX" >&2
  echo "Locate it with: find /Applications/CrossOver.app -name cxstart" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG")"

# A second launch against a live --user-data-dir hands the URL to the existing
# process and exits 0. The harness would then validate the *previous* build
# while reporting success, so always clear the field first.
pkill -f 'chrome-win32 2' 2>/dev/null || true
pkill -f 'chrome\.exe' 2>/dev/null || true

# Wait for the port to actually free up — pkill returns before the socket closes.
for _ in $(seq 1 20); do
  curl -sf -o /dev/null "http://localhost:$PORT/json/version" || break
  sleep 0.5
done

echo "launching $EXE in bottle '$BOTTLE' (CDP :$PORT)" >&2

"$CX" --bottle "$BOTTLE" -- \
  "$EXE" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  --no-sandbox \
  --disable-translate \
  --disable-background-networking \
  --window-size=1920,1080 \
  --user-agent="$UA" \
  about:blank \
  >"$LOG" 2>&1 &

# cxstart exiting 0 says almost nothing about whether Chromium came up.
# The only honest readiness signal is CDP answering.
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
    echo "ready after $((i / 2))s: $(curl -s "http://localhost:$PORT/json/version" | tr -d '\n')" >&2
    exit 0
  fi
  sleep 0.5
done

echo "CDP never came up on :$PORT after 30s. Last output:" >&2
tail -n 30 "$LOG" >&2 || true
# cxstart exits 0 and logs nothing when the Windows path does not exist, so an
# empty log here almost always means CX_EXE is wrong rather than a Wine problem.
echo "(empty log above usually means CX_EXE='$EXE' does not exist in the bottle — check" >&2
echo " ls ~/Library/Application\\ Support/CrossOver/Bottles/$BOTTLE/drive_c/)" >&2
exit 1
