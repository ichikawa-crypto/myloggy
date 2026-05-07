#!/bin/bash
set -euo pipefail
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
PLIST_LABEL="com.myloggy.synclog"
DST="${HOME}/Library/LaunchAgents/com.myloggy.synclog.plist"

launchctl bootout "${DOMAIN}/${PLIST_LABEL}" 2>/dev/null || true
rm -f "$DST"
echo "Uninstalled."
