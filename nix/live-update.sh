# Helm live update: build a new Helm, switch to it, restart, check health, roll back if it does not come up.
#
#   helm-live-update update     build $HELM_LU_FLAKE#$HELM_LU_ATTR and switch to it
#   helm-live-update rollback   switch to the previous version
#
# Run by helm-update.service / helm-rollback.service (nix/module.nix) as the service user; the test harness runs the
# same script against a scratch instance with HELM_LU_SCOPE=user. Everything it needs comes from the environment:
#
#   HELM_LU_DIR      <dataDir>/live: generations/gen-N (nix out-links, so GC roots), current, previous, status.json
#   HELM_LU_FLAKE    flake to build, e.g. git+file:///home/you/src/helm?ref=release
#   HELM_LU_ATTR     package attribute (default "default")
#   HELM_LU_PACKAGE  the build the module installed; what runs while there is no current link
#   HELM_LU_SERVICE  the unit to restart (helm.service)
#   HELM_LU_SCOPE    system (default) or user: which systemd manager and journal to use
#   HELM_LU_URL      base URL of the running server, e.g. http://127.0.0.1:8080
#   HELM_LU_TIMEOUT  seconds to wait for the new server to be healthy (default 60)
#   HELM_LU_KEEP     generations to keep (default 5); the current and previous ones are always kept
#   HELM_LU_MIN_FREE_MB  free space the Nix store needs before a build starts (default 10240)
#   HELM_LU_GC       0: skip nix-collect-garbage after a healthy update (default 1)
#
# Status for the dashboard is written to $HELM_LU_DIR/status.json at every stage. Stages: building, built,
# restarting, checking, then one of healthy | unchanged | failed (nothing was restarted) | rolled-back.
# Only the restart interrupts the running service: building runs beside it.

set -uo pipefail

mode=${1:-update}
dir=${HELM_LU_DIR:?HELM_LU_DIR is not set}
flake=${HELM_LU_FLAKE:-}
attr=${HELM_LU_ATTR:-default}
package=${HELM_LU_PACKAGE:?HELM_LU_PACKAGE is not set}
service=${HELM_LU_SERVICE:-helm.service}
scope=${HELM_LU_SCOPE:-system}
url=${HELM_LU_URL:-http://127.0.0.1:8080}
timeout=${HELM_LU_TIMEOUT:-60}
keep=${HELM_LU_KEEP:-5}

if [ "$scope" = user ]; then
  sysctl=(systemctl --user)
  journal=(journalctl --user-unit "$service")
else
  sysctl=(systemctl)
  journal=(journalctl --unit "$service")
fi

mkdir -p "$dir/generations"
status="$dir/status.json"
id="$(date +%s%3N)"
started=$id
from_path=""
from_rev=""
to_path=""
to_rev=""

# One update or rollback at a time (the two units could otherwise overlap).
exec 9>"$dir/lock"
if ! flock -n 9; then
  echo "another update or rollback is running" >&2
  exit 1
fi

# write_status STAGE [MESSAGE] [LOG]: atomically replace status.json.
write_status() {
  local tmp
  tmp="$(mktemp "$dir/.status.XXXXXX")"
  jq -n \
    --arg id "$id" --arg kind "$mode" --arg stage "$1" --arg message "${2:-}" --arg log "${3:-}" \
    --arg fromRev "$from_rev" --arg toRev "$to_rev" --arg fromPath "$from_path" --arg toPath "$to_path" \
    --argjson startedAt "$started" --argjson updatedAt "$(date +%s%3N)" \
    '{id: $id, kind: $kind, stage: $stage, message: $message, log: $log, fromRev: $fromRev, toRev: $toRev,
      fromPath: $fromPath, toPath: $toPath, startedAt: $startedAt, updatedAt: $updatedAt}' >"$tmp" &&
    mv -f "$tmp" "$status"
  echo "[$1] ${2:-}" >&2
}

# What the service starts: the current link's target, or the installed package when there is none.
running_path() {
  if [ -x "$dir/current/bin/helm" ]; then readlink -f "$dir/current"; else echo "$package"; fi
}

rev_of() {
  jq -r '.rev // "unknown"' "$1/lib/helm/version.json" 2>/dev/null || echo unknown
}

short() { echo "${1:0:12}"; }

# set_link NAME TARGET: atomically point $dir/NAME at TARGET (relative for generations, absolute for the package).
set_link() {
  local target=$2
  case "$target" in "$dir"/*) target="${target#"$dir"/}" ;; esac
  ln -sfn "$target" "$dir/.$1.tmp" && mv -fT "$dir/.$1.tmp" "$dir/$1"
}

# The generation link (or package path) a store path is reachable through, so links stay GC roots.
link_for() {
  local p=$1 g
  for g in "$dir"/generations/gen-*; do
    [ -e "$g" ] && [ "$(readlink -f "$g")" = "$p" ] && { echo "$g"; return; }
  done
  echo "$p"
}

service_log() {
  "${journal[@]}" --since "@$(( $1 / 1000 ))" --no-pager -o cat -n 40 2>&1 | tail -n 40
}

# healthy EXPECTED_REV: the service is active, / answers 200 and /api/health reports EXPECTED_REV, three times
# in a row two seconds apart, within $timeout seconds. Sets $why when it is not.
healthy() {
  local want=$1 deadline=$(( $(date +%s) + timeout )) ok=0 code got
  why="did not answer within ${timeout}s"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! "${sysctl[@]}" is-active --quiet "$service"; then
      local restarts
      restarts="$("${sysctl[@]}" show -p NRestarts --value "$service" 2>/dev/null || echo 0)"
      if [ "${restarts:-0}" -gt 0 ]; then
        why="it keeps exiting ($service restarted itself $restarts times)"
      else
        why="$service is not running ($("${sysctl[@]}" is-active "$service" 2>/dev/null))"
      fi
      ok=0
    else
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url/" || true)"
      got="$(curl -s --max-time 5 "$url/api/health" | jq -r '.rev // empty' 2>/dev/null || true)"
      if [ "$code" != 200 ]; then
        why="GET / answered ${code:-nothing}"
        ok=0
      elif [ -z "$got" ]; then
        why="GET /api/health did not answer"
        ok=0
      elif [ "$want" != unknown ] && [ "$got" != "$want" ]; then
        why="the server reports revision $(short "$got"), expected $(short "$want")"
        ok=0
      else
        ok=$((ok + 1))
        [ "$ok" -ge 3 ] && return 0
      fi
    fi
    sleep 2
  done
  return 1
}

restart() {
  "${sysctl[@]}" restart "$service"
}

# activate TARGET_LINK: switch current to it, restart, check; on failure switch back and restart again.
activate() {
  local target=$1 previous_target restart_at old_previous
  old_previous="$(readlink "$dir/previous" 2>/dev/null || true)"
  previous_target="$(link_for "$from_path")"
  set_link previous "$previous_target"
  set_link current "$target"
  restart_at="$(date +%s%3N)"
  write_status restarting "Restarting Helm on $(short "$to_rev")"
  if ! restart; then
    why="systemctl restart $service failed"
  elif write_status checking "Waiting for $(short "$to_rev") to answer" && healthy "$to_rev"; then
    write_status healthy "Running $(short "$to_rev")"
    return 0
  fi
  local reason=$why log
  log="$(service_log "$restart_at")"
  write_status rolling-back "$(short "$to_rev") is not healthy: $reason" "$log"
  set_link current "$previous_target"
  if [ -n "$old_previous" ]; then set_link previous "$old_previous"; else rm -f "$dir/previous"; fi
  restart || true
  if healthy "$from_rev"; then
    write_status rolled-back "$(short "$to_rev") did not come up healthy ($reason). Back on $(short "$from_rev")." "$log"
  else
    write_status rolled-back "$(short "$to_rev") did not come up healthy ($reason). Switched back to $(short "$from_rev"), but it is not healthy either ($why)." "$log"
  fi
  return 1
}

# Generation numbers in generations/, one per line.
generation_numbers() {
  local g
  for g in "$dir"/generations/gen-*; do
    g=${g##*/gen-}
    [[ $g =~ ^[0-9]+$ ]] && echo "$g"
  done
  return 0
}

prune() {
  local g n=0 cur prev t
  cur="$(readlink -f "$dir/current" 2>/dev/null || true)"
  prev="$(readlink -f "$dir/previous" 2>/dev/null || true)"
  # Newest first by generation number.
  while IFS= read -r g; do
    g="$dir/generations/gen-$g"
    n=$((n + 1))
    t="$(readlink -f "$g" 2>/dev/null || true)"
    if [ "$n" -le "$keep" ] || [ "$t" = "$cur" ] || [ "$t" = "$prev" ]; then continue; fi
    echo "pruning $g" >&2
    rm -f "$g"
  done < <(generation_numbers | sort -nr)
}

# After a healthy switch and the prune: free what the pruned generations and the old build held. Plain
# nix-collect-garbage (not -d, which would also delete this user's old profile generations); it removes
# only store paths nothing refers to. Helm is already running the new build, so this only takes time. HELM_LU_GC=0
# skips it (the test harness).
collect_garbage() {
  [ "${HELM_LU_GC:-1}" = 0 ] && return 0
  echo "collecting garbage" >&2
  timeout 30m nix-collect-garbage >"$dir/gc.log" 2>&1 || echo "nix-collect-garbage failed (see $dir/gc.log)" >&2
  tail -n 1 "$dir/gc.log" >&2
}

# free_mb PATH: megabytes free on the filesystem holding PATH.
free_mb() {
  df -Pm "$1" 2>/dev/null | tail -n 1 | tr -s ' ' | cut -d ' ' -f 4
}

from_path="$(running_path)"
from_rev="$(rev_of "$from_path")"

if [ "$mode" = rollback ]; then
  if [ ! -e "$dir/previous" ]; then
    write_status failed "There is no previous version to roll back to."
    exit 1
  fi
  to_path="$(readlink -f "$dir/previous")"
  to_rev="$(rev_of "$to_path")"
  if [ ! -x "$to_path/bin/helm" ]; then
    write_status failed "The previous version ($to_path) is gone."
    exit 1
  fi
  activate "$(link_for "$to_path")" || exit 1
  exit 0
fi

if [ "$mode" != update ]; then
  echo "usage: $0 update|rollback" >&2
  exit 2
fi
if [ -z "$flake" ]; then
  write_status failed "HELM_LU_FLAKE is not set."
  exit 1
fi

# A build needs room: do not start one on a nearly full disk (the dashboard refuses too, see server/disk.ts).
min_free=${HELM_LU_MIN_FREE_MB:-10240}
store_free="$(free_mb /nix/store)"
if [ -n "$store_free" ] && [ "$store_free" -lt "$min_free" ]; then
  write_status failed "Not building: only ${store_free} MB free for the Nix store (at least ${min_free} MB needed). Free disk space first; nothing was restarted."
  exit 1
fi

last="$(generation_numbers | sort -n | tail -n 1)"
gen="$dir/generations/gen-$(( ${last:-0} + 1 ))"

write_status building "Building $flake#$attr"
buildlog="$dir/build.log"
if ! nix --extra-experimental-features 'nix-command flakes' build "$flake#$attr" \
  --no-write-lock-file --out-link "$gen" --print-out-paths -L >"$buildlog.out" 2>"$buildlog"; then
  rm -f "$gen"
  write_status failed "The build failed. Nothing was restarted." "$(tail -n 40 "$buildlog")"
  exit 1
fi
to_path="$(readlink -f "$gen")"
to_rev="$(rev_of "$to_path")"

if [ "$to_path" = "$from_path" ]; then
  rm -f "$gen"
  write_status unchanged "Already running $(short "$to_rev")."
  exit 0
fi

write_status built "Built $(short "$to_rev")"
if activate "$gen"; then
  prune
  collect_garbage
  exit 0
fi
# A version that did not come up is not kept around as a generation.
rm -f "$gen"
exit 1
