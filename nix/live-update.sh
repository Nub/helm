# Helm live update: build a new Helm, switch to it, restart, check health, roll back if it does not come up.
#
#   helm-live-update update          build $HELM_LU_FLAKE#$HELM_LU_ATTR and switch to it
#   helm-live-update rollback        switch to the previous version
#   helm-live-update restart-runner  restart the runner when no agent is mid-turn: to apply a changed system
#                                    configuration, or to bring a runner that is behind onto the dashboard's build
#   helm-live-update adopt           after the system rebuild that turns the split on: replace the one-process Helm
#                                    still running from before it with the runner and the web service, once no
#                                    agent is mid-turn (helm-split-adopt.service runs it after activation)
#
# Run by helm-update.service / helm-rollback.service / helm-restart-agents.service (nix/module.nix) as the service
# user; nix/live-update.check.sh runs the same script against scratch user units with HELM_LU_SCOPE=user. Everything
# it needs comes from the environment:
#
#   HELM_LU_DIR          <dataDir>/live: generations/gen-N (nix out-links, so GC roots), current, previous, web,
#                        web-previous, status.json
#   HELM_LU_FLAKE        flake to build, e.g. git+file:///home/you/src/helm?ref=release
#   HELM_LU_ATTR         package attribute (default "default")
#   HELM_LU_PACKAGE      the build the module installed; what runs while there is no current link
#   HELM_LU_SERVICE      the unit to restart (helm.service): the runner, or the whole of Helm when not split
#   HELM_LU_WEB_SERVICE  the web service's unit (helm-web.service) when Helm runs split (server/runner.ts); unset: one
#                        process, and every update restarts HELM_LU_SERVICE as before the split
#   HELM_LU_SCOPE        system (default) or user: which systemd manager and journal to use
#   HELM_LU_URL          base URL of the running server, e.g. http://127.0.0.1:8080
#   HELM_LU_TIMEOUT      seconds to wait for the new server to be healthy (default 60)
#   HELM_LU_KEEP         generations to keep (default 5); the current and previous ones are always kept
#   HELM_LU_POLL         seconds between checks while waiting for agents to be idle (default 5)
#   HELM_LU_MIN_FREE_MB  free space the Nix store needs before a build starts (default 10240)
#   HELM_LU_GC           0: skip nix-collect-garbage after a healthy update (default 1)
#
# Status for the dashboard is written to $HELM_LU_DIR/status.json at every stage. Stages: building, built,
# restarting-web, waiting (for agents to be idle), restarting, checking, then one of healthy | unchanged | failed
# (nothing was restarted) | rolled-back. Only a restart interrupts anything: building runs beside the service.
#
# Split (HELM_LU_WEB_SERVICE set): `current` is the runner's build and `web` the web service's. A build whose runner is
# the same as the running one (lib/helm/runner.json, server/closure.ts) changes only `web` and restarts only the web
# service: agents keep working. Otherwise the web service switches first, then the script waits until no agent is
# mid-turn (or $HELM_LU_DIR/restart-now appears: "Restart agents now"), then switches and restarts the runner, which
# resumes the agents it interrupted. A build from before the split (no runner.json) runs as one process under
# HELM_LU_SERVICE; the web unit then exits at once (nix/helm-start.sh).

set -uo pipefail

mode=${1:-update}
# What status.json calls the run: the mode. The dashboard offers different things during a wait by kind: an update's
# wait can be superseded by a new Update or cancelled by Roll back; a restart-runner or adopt wait can only be ended
# ("Don't restart"), and Update and Roll back are refused meanwhile (server/liveupdate.ts).
kind=$mode
dir=${HELM_LU_DIR:?HELM_LU_DIR is not set}
flake=${HELM_LU_FLAKE:-}
attr=${HELM_LU_ATTR:-default}
package=${HELM_LU_PACKAGE:?HELM_LU_PACKAGE is not set}
service=${HELM_LU_SERVICE:-helm.service}
web_service=${HELM_LU_WEB_SERVICE:-}
scope=${HELM_LU_SCOPE:-system}
url=${HELM_LU_URL:-http://127.0.0.1:8080}
timeout=${HELM_LU_TIMEOUT:-60}
keep=${HELM_LU_KEEP:-5}
poll=${HELM_LU_POLL:-5}
# How long a wait for idle agents may go without any answer from the dashboard before it gives up (seconds).
no_answer_limit=${HELM_LU_NO_ANSWER_SECONDS:-1800}

if [ "$scope" = user ]; then
  sysctl=(systemctl --user)
  journal=(journalctl --user-unit "$service")
  [ -n "$web_service" ] && journal+=(--user-unit "$web_service")
else
  sysctl=(systemctl)
  journal=(journalctl --unit "$service")
  [ -n "$web_service" ] && journal+=(--unit "$web_service")
fi

mkdir -p "$dir/generations"
status="$dir/status.json"
id="$(date +%s%3N)"
started=$id
from_path=""
from_rev=""
to_path=""
to_rev=""
agents=""
waiting_since=0

# One update or rollback at a time (the units could otherwise overlap).
exec 9>"$dir/lock"
if ! flock -n 9; then
  echo "another update or rollback is running" >&2
  exit 1
fi

# write_status STAGE [MESSAGE] [LOG]: atomically replace status.json. `agents`: "keep" (they keep working), "restart"
# (the runner restarts), or empty (not split, or not known yet).
write_status() {
  local tmp
  tmp="$(mktemp "$dir/.status.XXXXXX")"
  jq -n \
    --arg id "$id" --arg kind "$kind" --arg stage "$1" --arg message "${2:-}" --arg log "${3:-}" \
    --arg fromRev "$from_rev" --arg toRev "$to_rev" --arg fromPath "$from_path" --arg toPath "$to_path" --arg agents "$agents" \
    --argjson startedAt "$started" --argjson updatedAt "$(date +%s%3N)" --argjson waitingSince "${waiting_since:-0}" \
    '{id: $id, kind: $kind, stage: $stage, message: $message, log: $log, fromRev: $fromRev, toRev: $toRev,
      fromPath: $fromPath, toPath: $toPath, agents: $agents, startedAt: $startedAt, updatedAt: $updatedAt,
      waitingSince: $waitingSince}' >"$tmp" &&
    mv -f "$tmp" "$status"
  echo "[$1] ${2:-}" >&2
}

# What the runner (or the one process) starts: the current link's target, or the installed package when there is none.
running_path() {
  if [ -x "$dir/current/bin/helm" ]; then readlink -f "$dir/current"; else echo "$package"; fi
}

# What the web service starts: the web link's target, else the runner's.
web_path() {
  if [ -x "$dir/web/bin/helm" ]; then readlink -f "$dir/web"; else running_path; fi
}

rev_of() {
  jq -r '.rev // "unknown"' "$1/lib/helm/version.json" 2>/dev/null || echo unknown
}

# The runner's code hash of a build (server/closure.ts); empty for a build from before the split.
runner_hash() {
  jq -r '.hash // empty' "$1/lib/helm/runner.json" 2>/dev/null || true
}

is_split_build() {
  [ -f "$1/lib/helm/runner.json" ]
}

short() { echo "${1:0:12}"; }

# set_link NAME TARGET: atomically point $dir/NAME at TARGET (relative for generations, absolute for the package).
set_link() {
  local target=$2
  case "$target" in "$dir"/*) target="${target#"$dir"/}" ;; esac
  ln -sfn "$target" "$dir/.$1.tmp" && mv -fT "$dir/.$1.tmp" "$dir/$1"
}

# restore_link NAME OLD_TARGET: put a link back as it was (OLD_TARGET from readlink; empty means there was none).
restore_link() {
  if [ -n "$2" ]; then ln -sfn "$2" "$dir/.$1.tmp" && mv -fT "$dir/.$1.tmp" "$dir/$1"; else rm -f "$dir/$1"; fi
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

# health_json: /api/health of the running server, or nothing.
health_json() {
  curl -s --max-time 5 "$url/api/health" 2>/dev/null || true
}

# unit_ok UNIT: active, or sets $why.
unit_ok() {
  if "${sysctl[@]}" is-active --quiet "$1"; then return 0; fi
  local restarts
  restarts="$("${sysctl[@]}" show -p NRestarts --value "$1" 2>/dev/null || echo 0)"
  if [ "${restarts:-0}" -gt 0 ]; then
    why="it keeps exiting ($1 restarted itself $restarts times)"
  else
    why="$1 is not running ($("${sysctl[@]}" is-active "$1" 2>/dev/null))"
  fi
  return 1
}

# healthy EXPECTED_REV [RUNNER_REV]: the service is active, / answers 200 and /api/health reports EXPECTED_REV (and,
# when Helm runs split, its runner up, with RUNNER_REV if given), three times in a row two seconds apart, within
# $timeout seconds. Which unit serves the port depends on the build: the web service for a split one. Sets $why.
healthy() {
  local want=$1 want_runner=${2:-} deadline=$(( $(date +%s) + timeout )) ok=0 code got h runner_up runner_rev units
  why="did not answer within ${timeout}s"
  units=("$service")
  if [ -n "$web_service" ] && is_split_build "$(web_path)"; then units+=("$web_service"); fi
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local active=1 u
    for u in "${units[@]}"; do unit_ok "$u" || { active=0; break; }; done
    if [ "$active" = 0 ]; then
      ok=0
    else
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url/" || true)"
      h="$(health_json)"
      got="$(jq -r '.rev // empty' <<<"$h" 2>/dev/null || true)"
      runner_up="$(jq -r 'if .runner then (.runner.up | tostring) else "none" end' <<<"$h" 2>/dev/null || echo none)"
      runner_rev="$(jq -r '.runner.rev // empty' <<<"$h" 2>/dev/null || true)"
      if [ "$code" != 200 ]; then
        why="GET / answered ${code:-nothing}"
        ok=0
      elif [ -z "$got" ]; then
        why="GET /api/health did not answer"
        ok=0
      elif [ "$want" != unknown ] && [ "$got" != "$want" ]; then
        why="the server reports revision $(short "$got"), expected $(short "$want")"
        ok=0
      elif [ "${#units[@]}" -gt 1 ] && [ "$runner_up" != true ]; then
        why="the runner is not running (no heartbeat)"
        ok=0
      elif [ -n "$want_runner" ] && [ "$want_runner" != unknown ] && [ "$runner_rev" != "$want_runner" ]; then
        why="the runner reports revision $(short "$runner_rev"), expected $(short "$want_runner")"
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

restart_web() {
  "${sysctl[@]}" restart "$web_service"
}

# Restart both halves (each explicitly: a runner restart does not restart the web service) in the order that frees the
# port first: the web service before a runner that will serve the
# dashboard itself (a build from before the split), the runner first otherwise. RUNNER_TARGET: the build it starts.
restart_both() {
  if is_split_build "$1"; then
    restart && restart_web
  else
    restart_web
    restart
  fi
}

# ---------- not split: one process (as before the split) ----------

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
  restore_link previous "$old_previous"
  restart || true
  if healthy "$from_rev"; then
    write_status rolled-back "$(short "$to_rev") did not come up healthy ($reason). Back on $(short "$from_rev")." "$log"
  else
    write_status rolled-back "$(short "$to_rev") did not come up healthy ($reason). Switched back to $(short "$from_rev"), but it is not healthy either ($why)." "$log"
  fi
  return 1
}

# ---------- split: a runner and a web service ----------

# set_last_kind web|both: what the last finished update changed (Roll back undoes that), replaced atomically.
set_last_kind() {
  local tmp
  tmp="$(mktemp "$dir/.last-kind.XXXXXX")" && echo "$1" >"$tmp" && mv -f "$tmp" "$dir/last-kind"
}

# The links as they were before this run, to put back on failure.
save_links() {
  old_current="$(readlink "$dir/current" 2>/dev/null || true)"
  old_previous="$(readlink "$dir/previous" 2>/dev/null || true)"
  old_web="$(readlink "$dir/web" 2>/dev/null || true)"
  old_web_previous="$(readlink "$dir/web-previous" 2>/dev/null || true)"
}
put_back_links() {
  restore_link current "$old_current"
  restore_link previous "$old_previous"
  restore_link web "$old_web"
  restore_link web-previous "$old_web_previous"
}

# give_up RESTART_AT REASON: after a failed switch, put the links back, restart both and report rolled-back.
give_up() {
  local restart_at=$1 reason=$2 log
  log="$(service_log "$restart_at")"
  write_status rolling-back "$(short "$to_rev") is not healthy: $reason" "$log"
  put_back_links
  restart_both "$from_runner_path" || true
  if healthy "$from_rev" "$(is_split_build "$from_runner_path" && rev_of "$from_runner_path")"; then
    write_status rolled-back "$(short "$to_rev") did not come up healthy ($reason). Back on $(short "$from_rev")." "$log"
  else
    write_status rolled-back "$(short "$to_rev") did not come up healthy ($reason). Switched back to $(short "$from_rev"), but it is not healthy either ($why)." "$log"
  fi
}

# switch_web TARGET: point the web service at TARGET and restart only it; the runner and its agents carry on.
switch_web() {
  local target=$1 restart_at
  set_link web-previous "$(link_for "$from_path")"
  set_link web "$target"
  restart_at="$(date +%s%3N)"
  write_status restarting-web "Restarting the dashboard on $(short "$to_rev"); agents keep working"
  if ! restart_web; then
    why="systemctl restart $web_service failed"
  elif healthy "$to_rev"; then
    return 0
  fi
  # Only the dashboard goes back; the runner was never touched.
  local reason=$why log
  log="$(service_log "$restart_at")"
  write_status rolling-back "$(short "$to_rev") is not healthy: $reason" "$log"
  restore_link web "$old_web"
  restore_link web-previous "$old_web_previous"
  restart_web || true
  if healthy "$from_rev"; then
    write_status rolled-back "$(short "$to_rev") did not come up healthy ($reason). Back on $(short "$from_rev"); agents kept working." "$log"
  else
    write_status rolled-back "$(short "$to_rev") did not come up healthy ($reason). Switched back to $(short "$from_rev"), but it is not healthy either ($why)." "$log"
  fi
  return 1
}

# The number of agents mid-turn, as the running server reports it: 0 when the runner is not running (nothing to
# interrupt), "unknown" when nothing answers or the answer cannot be read. Unknown is never taken for idle.
working_now() {
  local h n
  h="$(health_json)"
  n="$(jq -r 'if (.runner | type) != "object" then "unknown" elif .runner.up then (.runner.working | tostring) else "0" end' <<<"$h" 2>/dev/null || true)"
  [[ $n =~ ^[0-9]+$ ]] || n=unknown
  echo "$n"
}

# wait_for_idle WHAT: until no agent is mid-turn, or the user asks for the restart now. Refreshes the status at least
# every minute, so the dashboard never takes the wait for a dead run. Returns:
#   0  go on with the restart
#   1  an update's wait was superseded ($dir/supersede, written by the dashboard before it starts another update or
#      a rollback): the run ends as "superseded", leaving the links as they are (the new dashboard, the old runner)
#   2  the user ended a restart-runner or adopt wait ($dir/cancel-wait, "Don't restart"): the run ends as
#      "cancelled", nothing changed
#   3  the dashboard has not answered for no_answer_limit seconds: give up (the caller restores what it changed)
wait_for_idle() {
  local what=$1 n last="" said=0 note silent_since=0
  rm -f "$dir/restart-now" "$dir/supersede" "$dir/cancel-wait"
  waiting_since="$(date +%s%3N)"
  while :; do
    if [ -e "$dir/supersede" ]; then
      rm -f "$dir/supersede"
      if [ "$mode" = update ]; then
        write_status superseded "Replaced by a newer request before agents were idle."
        return 1
      fi
    fi
    if [ -e "$dir/cancel-wait" ]; then
      rm -f "$dir/cancel-wait"
      if [ "$mode" != update ]; then
        write_status cancelled "Not restarted: the wait was ended from the dashboard. Nothing changed."
        return 2
      fi
    fi
    if [ -e "$dir/restart-now" ]; then
      rm -f "$dir/restart-now"
      echo "restart requested by the user" >&2
      return 0
    fi
    n="$(working_now)"
    [ "$n" = 0 ] && return 0
    if [ "$n" = unknown ]; then
      [ "$silent_since" = 0 ] && silent_since=$(date +%s)
      if [ $(( $(date +%s) - silent_since )) -ge "$no_answer_limit" ]; then
        why="the dashboard has not answered for $(( no_answer_limit / 60 )) minutes"
        return 3
      fi
    else
      silent_since=0
    fi
    if [ "$n" != "$last" ] || [ $(( $(date +%s) - said )) -ge 60 ]; then
      if [ "$n" = unknown ]; then note="the dashboard does not answer, so agents are taken as working"; else note="$n working"; fi
      write_status waiting "$what; agents restart when idle ($note)"
      last=$n
      said=$(date +%s)
    fi
    sleep "$poll"
  done
}

# switch_runner TARGET: point both halves at TARGET and restart the runner (and the web service with it).
switch_runner() {
  local target=$1 restart_at to_runner_rev=""
  set_link previous "$(link_for "$from_runner_path")"
  set_link current "$target"
  set_link web "$target"
  restart_at="$(date +%s%3N)"
  # "restarting": the runner records the agents it interrupts and resumes them once this run reports healthy.
  write_status restarting "Restarting agents on $(short "$to_rev")"
  is_split_build "$to_path" && to_runner_rev=$to_rev
  if ! restart_both "$to_path"; then
    why="systemctl restart failed"
  elif write_status checking "Waiting for $(short "$to_rev") to answer" && healthy "$to_rev" "$to_runner_rev"; then
    write_status healthy "Running $(short "$to_rev")"
    return 0
  fi
  give_up "$restart_at" "$why"
  return 1
}

# activate_split TARGET_LINK: the update or rollback when Helm runs split.
activate_split() {
  local target=$1
  save_links
  from_hash="$(runner_hash "$from_runner_path")"
  to_hash="$(runner_hash "$to_path")"
  # A Helm still running as one process holds the port (the first deploy's switch was not done yet: "Don't restart",
  # or adopt has not run): a new dashboard could not start beside it. Switch both, recording and resuming the agents.
  if [ "$(health_json | jq -r 'if (.runner | type) == "object" then .runner.mode else "none" end' 2>/dev/null)" = all ]; then
    agents=restart
    switch_runner "$target"
    return
  fi
  if [ -n "$from_hash" ] && [ "$from_hash" = "$to_hash" ] && is_split_build "$from_path"; then
    # The same runner: only the dashboard changes.
    agents=keep
    switch_web "$target" || return 1
    write_status healthy "Running $(short "$to_rev"); agents kept working"
    return 0
  fi
  agents=restart
  if is_split_build "$from_runner_path" && is_split_build "$to_path"; then
    # The new dashboard first (it works with the runner one version older), the runner once agents are idle.
    switch_web "$target" || return 1
    wait_for_idle "New dashboard $(short "$to_rev") is running"
    case $? in
      0) ;;
      3)
        # The new dashboard never answers again: put the one that worked back (the runner was never touched).
        local gave_up=$why
        restore_link web "$old_web"
        restore_link web-previous "$old_web_previous"
        restart_web || true
        healthy "$from_rev" || true
        write_status failed "Gave up waiting: $gave_up. The dashboard is back on $(short "$from_rev"); agents kept working."
        exit 1
        ;;
      *)
        superseded=1
        return 0
        ;;
    esac
  fi
  # A build from before the split on either side runs as one process: both switch together.
  switch_runner "$target"
}

# ---------- the run ----------

generation_numbers() {
  local g
  for g in "$dir"/generations/gen-*; do
    g=${g##*/gen-}
    [[ $g =~ ^[0-9]+$ ]] && echo "$g"
  done
  return 0
}

prune() {
  local g n=0 keepers=() t k skip
  for k in current previous web web-previous; do keepers+=("$(readlink -f "$dir/$k" 2>/dev/null || true)"); done
  # Newest first by generation number.
  while IFS= read -r g; do
    g="$dir/generations/gen-$g"
    n=$((n + 1))
    t="$(readlink -f "$g" 2>/dev/null || true)"
    skip=0
    for k in "${keepers[@]}"; do [ -n "$k" ] && [ "$t" = "$k" ] && skip=1; done
    if [ "$n" -le "$keep" ] || [ "$skip" = 1 ]; then continue; fi
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

from_runner_path="$(running_path)"
if [ -n "$web_service" ]; then from_path="$(web_path)"; else from_path="$from_runner_path"; fi
from_rev="$(rev_of "$from_path")"

if [ "$mode" = restart-runner ] || [ "$mode" = adopt ]; then
  if [ -z "$web_service" ]; then
    write_status failed "Helm does not run split: there is no separate runner to restart."
    exit 1
  fi
  if [ "$mode" = adopt ]; then
    # Only when what answers on the port is a one-process Helm (the one a rebuild left running) and the runner's
    # build can run split. Anything else (nothing up yet at boot, already split) is not ours to touch.
    h="$(health_json)"
    if [ -z "$h" ] || [ "$(jq -r 'if (.runner | type) == "object" then .runner.mode else "none" end' <<<"$h" 2>/dev/null)" = web ] || ! is_split_build "$from_runner_path"; then
      # Nothing to do. An adopt run cut short (a reboot during its wait) left its status waiting: close it, or the
      # dashboard would refuse Update and Roll back until it went stale.
      if [ "$(jq -r 'select(.kind == "adopt") | .stage' "$status" 2>/dev/null)" = waiting ]; then
        write_status cancelled "Nothing to switch: Helm already runs as a runner and a web service, or cannot yet."
      fi
      exit 0
    fi
  fi
  # A runner behind the dashboard (web-only updates since it started) restarts on the dashboard's build.
  to_path=$from_runner_path
  if is_split_build "$from_path" && [ "$(runner_hash "$from_path")" != "$(runner_hash "$from_runner_path")" ]; then to_path=$from_path; fi
  to_rev="$(rev_of "$to_path")"
  agents=restart
  if [ "$mode" = adopt ]; then why_text="Helm switches to a runner and a web service"; else why_text="Helm's system configuration changed"; fi
  [ "$to_path" != "$from_runner_path" ] && why_text="Agents move to the dashboard's build $(short "$to_rev")"
  # A one-process Helm from before the split cannot count agents mid-turn: nothing to wait on. It records them on
  # SIGTERM when this run says "restarting", and the runner resumes them once it says "healthy".
  if [ "$(working_now)" != unknown ] || [ "$mode" != adopt ]; then
    wait_for_idle "$why_text"
    case $? in
      0) ;;
      3)
        write_status failed "Gave up waiting: $why. Nothing was restarted."
        exit 1
        ;;
      *) exit 0 ;;
    esac
  fi
  save_links
  if [ "$to_path" != "$from_runner_path" ]; then
    set_link previous "$(link_for "$from_runner_path")"
    set_link current "$(link_for "$to_path")"
  fi
  restart_at="$(date +%s%3N)"
  write_status restarting "Restarting agents"
  # adopt: the web unit may be waiting for the port, or failed: restart it too (it has no start limit).
  if restart && { [ "$mode" != adopt ] || restart_web; } && healthy "$(rev_of "$(web_path)")" "$(is_split_build "$to_path" && echo "$to_rev")"; then
    if [ "$mode" = adopt ]; then write_status healthy "Helm runs as a runner and a web service"; else write_status healthy "Agents restarted on $(short "$to_rev")"; fi
    exit 0
  fi
  [ "$to_path" != "$from_runner_path" ] && put_back_links && restart
  write_status failed "The restart did not come up healthy: $why" "$(service_log "$restart_at")"
  exit 1
fi

if [ "$mode" = rollback ]; then
  if [ -n "$web_service" ] && is_split_build "$from_path" && is_split_build "$from_runner_path" && [ "$(runner_hash "$from_path")" != "$(runner_hash "$from_runner_path")" ]; then
    # The dashboard is on a newer build than the runner (an update that was waiting for idle agents, then cancelled,
    # superseded or cut short by a reboot): Cancel puts back the dashboard that ran before it (web-previous, which that
    # update set), when it suits the runner, else the runner's own build. Agents keep working.
    to_path=$from_runner_path
    if [ -e "$dir/web-previous" ]; then
      prev_web="$(readlink -f "$dir/web-previous")"
      if is_split_build "$prev_web" && [ "$(runner_hash "$prev_web")" = "$(runner_hash "$from_runner_path")" ]; then to_path=$prev_web; fi
    fi
    to_rev="$(rev_of "$to_path")"
    save_links
    agents=keep
    switch_web "$(link_for "$to_path")" || exit 1
    # The cancelled update never finished: Roll back afterwards undoes the last finished update with both halves
    # (previous), never this cancel, and web-previous keeps no trace of the cancelled dashboard.
    restore_link web-previous "$old_web_previous"
    set_last_kind both
    write_status healthy "Update cancelled: the dashboard is back on $(short "$to_rev"), which suits the build agents run"
    exit 0
  fi
  if [ -n "$web_service" ] && [ -e "$dir/last-kind" ] && [ "$(cat "$dir/last-kind")" = web ] && [ -e "$dir/web-previous" ]; then
    # The last update changed only the dashboard: roll back only the dashboard.
    to_path="$(readlink -f "$dir/web-previous")"
    to_rev="$(rev_of "$to_path")"
    if [ ! -x "$to_path/bin/helm" ]; then
      write_status failed "The previous version ($to_path) is gone."
      exit 1
    fi
    save_links
    agents=keep
    switch_web "$(link_for "$to_path")" || exit 1
    set_last_kind both
    write_status healthy "Running $(short "$to_rev"); agents kept working"
    exit 0
  fi
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
  if [ -n "$web_service" ]; then
    save_links
    agents=restart
    switch_runner "$(link_for "$to_path")" || exit 1
  else
    activate "$(link_for "$to_path")" || exit 1
  fi
  exit 0
fi

if [ "$mode" != update ]; then
  echo "usage: $0 update|rollback|restart-runner|adopt" >&2
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

if [ "$to_path" = "$from_path" ] && { [ "$to_path" = "$from_runner_path" ] || [ "$(runner_hash "$to_path")" = "$(runner_hash "$from_runner_path")" ]; }; then
  rm -f "$gen"
  write_status unchanged "Already running $(short "$to_rev")."
  exit 0
fi

write_status built "Built $(short "$to_rev")"
if [ -n "$web_service" ]; then
  superseded=0
  if activate_split "$gen"; then
    # Superseded while waiting: the new dashboard stays, its generation too; the next run takes over from here.
    [ "$superseded" = 1 ] && exit 0
    if [ "$agents" = keep ]; then set_last_kind web; else set_last_kind both; fi
    prune
    collect_garbage
    exit 0
  fi
elif activate "$gen"; then
  prune
  collect_garbage
  exit 0
fi
# A version that did not come up is not kept around as a generation.
rm -f "$gen"
exit 1
