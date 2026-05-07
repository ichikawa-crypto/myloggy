#!/usr/bin/env bash
# At-a-glance sync health (launchd + sync-history.log). macOS bash; deps: awk, date, tail, grep.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SCRIPT_DIR/.." && pwd)
LABEL="com.myloggy.synclog"
HIST="$REPO/logs/sync-history.log"

fmt_ago() {
  local sec=$1
  if ((sec < 60)); then
    printf '(%ss ago)' "$sec"
  elif ((sec < 3600)); then
    printf '(%sm ago)' "$((sec / 60))"
  else
    local h=$((sec / 3600))
    local m=$(((sec % 3600) / 60))
    printf '(%sh %sm ago)' "$h" "$m"
  fi
}

echo "=== myloggy sync status ==="

lc_line="$(launchctl list 2>/dev/null | grep -F "$LABEL" || true)"
if [[ -n "$lc_line" ]]; then
  pid="$(echo "$lc_line" | awk '{print $1}')"
  echo "launchd: loaded ($LABEL, last_pid=$pid)"
else
  echo "launchd: not loaded ($LABEL)"
fi

if [[ ! -f "$HIST" ]] || [[ ! -s "$HIST" ]]; then
  echo "No history yet"
  exit 0
fi

last_line="$(tail -n 1 "$HIST")"
ts="$(printf '%s' "$last_line" | cut -f1)"
st="$(printf '%s' "$last_line" | cut -f2)"
ts_wall="${ts%%+*}"

now_e=$(date +%s)
if epoch=$(TZ=Asia/Tokyo date -j -f "%Y-%m-%dT%H:%M:%S" "$ts_wall" +%s 2>/dev/null); then
  ago="$(fmt_ago "$((now_e - epoch))")"
else
  ago="(unknown)"
fi

echo "last run:    $ts  $ago"
echo "last status: $st"
echo "last 10 runs:"
tail -n 10 "$HIST" | awk '{a[++n]=$0} END{for (i=n; i>=1; i--) print a[i]}' | awk -F'\t' 'NF >= 8 {
  split($4, a, "="); l1 = a[2]
  split($7, b, "="); l2u = b[2]
  split($8, c, "="); olf = c[2]
  printf "  %s  %s    %s   l1+=%s   l2~=%s   ollama_fail=%s\n", $1, $2, $3, l1, l2u, olf
}'

cutoff=$((now_e - 86400))
runs=0
okc=0
failc=0
tl1=0
tl2=0
toll=0

while IFS= read -r line || [[ -n "${line:-}" ]]; do
  [[ -z "$line" ]] && continue
  ts="$(printf '%s' "$line" | cut -f1)"
  st="$(printf '%s' "$line" | cut -f2)"
  ts_wall="${ts%%+*}"
  if ! epoch=$(TZ=Asia/Tokyo date -j -f "%Y-%m-%dT%H:%M:%S" "$ts_wall" +%s 2>/dev/null); then
    continue
  fi
  ((epoch >= cutoff)) || continue

  runs=$((runs + 1))
  if [[ "$st" == OK ]]; then
    okc=$((okc + 1))
  else
    failc=$((failc + 1))
  fi
  l1="$(printf '%s' "$line" | cut -f4)"; l1="${l1#l1_added=}"
  l2="$(printf '%s' "$line" | cut -f7)"; l2="${l2#l2_updated=}"
  ol="$(printf '%s' "$line" | cut -f8)"; ol="${ol#ollama_fail=}"
  tl1=$((tl1 + ${l1:-0}))
  tl2=$((tl2 + ${l2:-0}))
  toll=$((toll + ${ol:-0}))
done < "$HIST"

echo "24h summary:"
echo "  runs:        $runs"
echo "  ok:          $okc"
echo "  fail:        $failc"
echo "  total l1+:   $tl1"
echo "  total l2~:   $tl2"
echo "  ollama_fail: $toll"
