#!/usr/bin/env bash
# BLE matrix harness — orchestrator (RUN THIS IN YOUR OWN TERMINAL, not inside Claude/the harness:
# it drives the real BlueZ adapter and the Claude harness SIGKILLs bluez).
#
# For each meter profile it: starts the `fakemeter` peripheral (sibling PyPI emulator) advertising
# as that meter, drives the web app on the adb-connected phone via matrix.mjs to connect + decode,
# asserts the right driver matched, then tears the peripheral down and moves on. Prints a PASS/FAIL
# table across all 11 drivers at the end.
#
#   Peripheral half (this script, your adapter):  fakemeter --profile X
#   Central+UI half (matrix.mjs, the phone):      navigate → connect → assert driverId + reading
#
# Prereqs:
#   * fakemeter installed:   pipx install fakemeter   (needs a working BlueZ; may need sudo to
#                            register a GATT peripheral — set FAKEMETER="sudo -E fakemeter" if so)
#   * a BLE adapter free for peripheral role (ADAPTER, default hci0)
#   * phone connected over adb with Chrome, USB debugging on
#   * the DEV web app running:   pnpm dev    (serves http://localhost:5173/multimeter/)
#     — must be the DEV build; the window.__bleMatrix hook is stripped from prod/Pages builds
#
# Usage:
#   tools/ble-matrix/run.sh                 # all 11 drivers
#   tools/ble-matrix/run.sh uni-t owon-plus # just these
#   ADAPTER=hci1 FAKEMETER="sudo -E fakemeter" tools/ble-matrix/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER="${ADAPTER:-hci0}"
DEV_PORT="${DEV_PORT:-5173}"
CDP_PORT="${CDP_PORT:-9222}"
APP_URL="${APP_URL:-http://localhost:${DEV_PORT}/multimeter/}"
FAKEMETER="${FAKEMETER:-fakemeter}"
# Browser on the phone — must be Chromium-based with Web Bluetooth + adb remote debugging. Kiwi
# (com.kiwibrowser.browser) is the validated default (works without Google Play services, e.g. on
# LineageOS); Chrome (com.android.chrome) works too. Both expose the chrome_devtools_remote socket.
# One-time setup the browser needs: BLUETOOTH_SCAN/CONNECT + location perms granted and BT on —
#   adb shell pm grant <pkg> android.permission.BLUETOOTH_SCAN
#   adb shell pm grant <pkg> android.permission.BLUETOOTH_CONNECT
#   adb shell pm grant <pkg> android.permission.ACCESS_FINE_LOCATION
#   adb shell svc bluetooth enable
BROWSER_PKG="${BROWSER_PKG:-com.kiwibrowser.browser}"
SETTLE="${SETTLE:-3}"        # seconds to let an advertisement come up before connecting
TIMEOUT="${TIMEOUT:-15000}"  # per-profile connect+decode timeout (ms)

# driver id -> fakemeter advertised default_name (both equal the app's driver id, names verified
# against each driver's namePrefixes). The chooser matches by name; the app then service-matches /
# sniffs to pick the driver — which is exactly what we assert.
declare -A NAME=(
  [uni-t]=UT60BT-FAKE [ut171]=UT171-FAKE [ut181a]=UT181A-FAKE [ut117c]=UT117C-FAKE
  [ut219p]=UT219P-FAKE [ut202bt]=UT202BT-FAKE [bdm]=BDM-FAKE [owon-plus]=OWON-PLUS-FAKE
  [owon-old]=OWON-OLD-FAKE [voltcraft]=VC915-FAKE [ai-care]=AICARE-FAKE
)
ALL=(uni-t ut171 ut181a ut117c ut219p ut202bt bdm owon-plus owon-old voltcraft ai-care)
PROFILES=("$@"); [ ${#PROFILES[@]} -eq 0 ] && PROFILES=("${ALL[@]}")

command -v adb >/dev/null || { echo "adb not found"; exit 2; }
command -v node >/dev/null || { echo "node not found"; exit 2; }
$FAKEMETER --help >/dev/null 2>&1 || { echo "fakemeter not runnable ('$FAKEMETER'); pipx install fakemeter"; exit 2; }

echo "→ adb reverse (phone localhost:${DEV_PORT} → this host's dev server)"
adb reverse "tcp:${DEV_PORT}" "tcp:${DEV_PORT}" || { echo "adb reverse failed (phone connected?)"; exit 2; }
echo "→ adb forward (this host:${CDP_PORT} → phone Chrome devtools)"
adb forward "tcp:${CDP_PORT}" localabstract:chrome_devtools_remote || { echo "adb forward failed"; exit 2; }
echo "→ opening the app on the phone ($BROWSER_PKG)"
# Just ensure the browser is running so its devtools endpoint exists — matrix.mjs handles tab
# hygiene itself (closes leftover/background tabs and opens one fresh foreground tab per profile),
# so no force-stop here (force-stop makes Chromium RESTORE its old tabs, the opposite of what we
# want).
adb shell am start -a android.intent.action.VIEW -d "$APP_URL" "$BROWSER_PKG" >/dev/null 2>&1
sleep 3
curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null \
  || { echo "phone devtools not reachable on :${CDP_PORT} — open the app/chrome on the phone, enable USB debugging"; exit 2; }

FIFO="$(mktemp -u)"; mkfifo "$FIFO"
FMPID=""
cleanup() { [ -n "$FMPID" ] && kill "$FMPID" 2>/dev/null; exec 3>&- 2>/dev/null; rm -f "$FIFO"; }
trap cleanup EXIT

# All 11 profiles advertise from the same host adapter MAC, so the phone can serve the previous
# profile's name from its in-memory scan cache. A light BT off/on between profiles flushes that
# cache; combined with matrix.mjs's exact-name match (it waits for the right name rather than
# picking any device) this keeps profiles from colliding. Set CLEAR_BT=0 to skip.
CLEAR_BT="${CLEAR_BT:-1}"
reset_bt_cache() {
  [ "$CLEAR_BT" = 1 ] || return 0
  adb shell svc bluetooth disable >/dev/null 2>&1
  sleep 1
  adb shell svc bluetooth enable >/dev/null 2>&1
  for _ in 1 2 3 4 5 6; do
    [ "$(adb shell settings get global bluetooth_on 2>/dev/null | tr -d '\r')" = 1 ] && break
    sleep 1
  done
  sleep 2
}

declare -A RESULT
for drv in "${PROFILES[@]}"; do
  name="${NAME[$drv]:-}"
  if [ -z "$name" ]; then echo "?? unknown profile '$drv' — skipping"; RESULT[$drv]="SKIP unknown"; continue; fi
  echo; echo "════════ $drv  (advertising as $name) ════════"
  reset_bt_cache   # clear the phone's stale per-MAC name cache from the previous profile

  # Start fakemeter; keep stdin open via the fifo so its REPL doesn't EOF-exit and kill the
  # peripheral. --no-walk = fixed reading (the 300ms re-push loop still delivers it post-subscribe).
  exec 3<>"$FIFO"
  $FAKEMETER --profile "$drv" --adapter "$ADAPTER" --no-walk <&3 >"/tmp/fakemeter-${drv}.log" 2>&1 &
  FMPID=$!
  sleep "$SETTLE"
  if ! kill -0 "$FMPID" 2>/dev/null; then
    echo "  ✗ fakemeter exited early — see /tmp/fakemeter-${drv}.log"
    RESULT[$drv]="FAIL fakemeter-died"; exec 3>&- ; continue
  fi

  # Hard ceiling so a wedged matrix.mjs (e.g. dead devtools socket) can never stall the whole
  # sweep — generous over the in-script TIMEOUT (ms→s + navigation/handshake overhead).
  out="$(timeout $((TIMEOUT / 1000 + 30)) node "$HERE/matrix.mjs" --driver "$drv" --name "$name" --url "$APP_URL" --port "$CDP_PORT" --timeout "$TIMEOUT")"
  [ -z "$out" ] && out='{"pass":false,"reason":"matrix.mjs timed out / no output"}'
  echo "  $out"
  if echo "$out" | grep -q '"pass":true'; then
    disp="$(echo "$out" | sed -n 's/.*"display":"\([^"]*\)".*/\1/p')"
    RESULT[$drv]="PASS  ${disp}"
  else
    reason="$(echo "$out" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p')"
    RESULT[$drv]="FAIL  ${reason}"
  fi

  kill "$FMPID" 2>/dev/null; wait "$FMPID" 2>/dev/null; FMPID=""; exec 3>&-
  sleep 1
done

echo; echo "════════════════════ MATRIX RESULT ════════════════════"
fails=0
for drv in "${PROFILES[@]}"; do
  r="${RESULT[$drv]:-FAIL no-result}"
  printf '  %-11s %s\n' "$drv" "$r"
  [[ "$r" == FAIL* ]] && fails=$((fails+1))
done
echo "════════════════════════════════════════════════════════"
echo "$((${#PROFILES[@]}-fails))/${#PROFILES[@]} passed"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
