#!/bin/bash
set -euo pipefail
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
PLIST_LABEL="com.myloggy.synclog"
SRC="${HOME}/myloggy/scripts/com.myloggy.synclog.plist"
DST="${HOME}/Library/LaunchAgents/com.myloggy.synclog.plist"

launchctl bootout "${DOMAIN}/${PLIST_LABEL}" 2>/dev/null || true
cp "$SRC" "$DST"

if ! launchctl bootstrap "$DOMAIN" "$DST" 2>/dev/null; then
  echo "Warning: launchctl bootstrap failed; falling back to launchctl load (legacy macOS)" >&2
  launchctl load "$DST" || true
fi

PRINT_OUT="$(launchctl print "${DOMAIN}/${PLIST_LABEL}" 2>/dev/null || true)"
printf '%s\n' "$PRINT_OUT"
if printf '%s\n' "$PRINT_OUT" | grep -E 'state = (running|waiting)' -q; then
  echo "launchd: job state OK (running or waiting)."
else
  echo "Warning: could not confirm state = running|waiting from launchctl print" >&2
fi

echo "Installed. Next runs: every 3h while PC is awake."
