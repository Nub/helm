#!/usr/bin/env bash
# Scenarios for nix/live-update.sh with Helm split into a runner and a web service, on scratch user units
# (helm-lutest-runner.service and helm-lutest-web.service in $XDG_RUNTIME_DIR/systemd/user), real nix builds of
# throwaway commits, scratch data under a temporary folder and the Claude stand-in. Never touches the live service.
#
#   bash nix/live-update.check.sh [BASE_REV]
#
# BASE_REV: a commit from before the split (default: the merge base with master's first parent before the split,
# given explicitly by the caller). The checks, in order:
#   0. first deploy: a one-process Helm (the unit from before the split) with an agent mid-turn; the rebuild rewrites
#      the units (helm-web left failed); the adopt unit waits for the agent, then the runner and web service take over
#   1. the units start a pre-split build: the runner unit serves the dashboard, the web unit stays down cleanly
#   2. update pre-split -> split: both switch; runner and web come up
#   3. web-only update while an agent is mid-turn: only the web service restarts; the agent finishes undisturbed
#   4. runner update while an agent is mid-turn: the new dashboard runs at once, the runner waits until idle
#   5. runner update, "Restart agents now" through the API: the runner restarts at once; the agent is resumed after
#   6. a broken web-only build: rolled back, runner untouched
#   7. rollback after a web-only update: only the dashboard goes back
#   8. an orderly stop outside an update (systemctl restart, as a rebuild or reboot does): mid-turn agents resumed
#   9. a changed system configuration: shown on the Helm page, applied by Restart agents when idle once agents are idle
#  10. update to the pre-split build (release moved back): one process again, the web unit down cleanly
# and, between them: a runner crash leaves the dashboard up; the dashboard not answering during a wait is not taken
# for idle agents; through the API while an update waits: a new Update supersedes it, a runner restart records and
# resumes the agent, and Cancel puts the dashboard back on the runner's build.
set -Eeuo pipefail
trap 'echo "FAIL line $LINENO: $BASH_COMMAND (exit $?)" >&2' ERR

here="$(cd "$(dirname "$0")/.." && pwd)"
base=${1:?usage: live-update.check.sh PRE_SPLIT_REV}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
T="$(mktemp -d "${TMPDIR:-/tmp}/helm-lutest.XXXXXX")"
data=$T/data
live=$data/live
units=$XDG_RUNTIME_DIR/systemd/user
R=helm-lutest-runner.service
W=helm-lutest-web.service
X=helm-lutest-restart.service
U=helm-lutest-update.service
RB=helm-lutest-rollback.service
AD=helm-lutest-adopt.service
port=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
url=http://127.0.0.1:$port
token=lutest-$RANDOM$RANDOM
fake=$here/.claude/skills/helm-ui-check/scripts/fake-claude.mjs
mkdir -p "$data" "$T/projects" "$T/fake" "$units"

cleanup() {
  trap - ERR
  set +e
  systemctl --user stop "$AD" "$U" "$RB" "$X" "$W" "$R" 2>/dev/null
  rm -f "$units/$R" "$units/$W" "$units/$X" "$units/$U" "$units/$RB" "$units/$AD"
  systemctl --user daemon-reload
  systemctl --user reset-failed "$AD" "$U" "$RB" "$X" "$W" "$R" 2>/dev/null
  rm -rf "$T"
}
trap cleanup EXIT

ok() { echo "ok   $*"; }
fail() {
  echo "FAIL $*" >&2
  echo "--- status: $(cat "$live/status.json" 2>/dev/null)" >&2
  journalctl --user-unit "$R" --user-unit "$W" -n 40 --no-pager -o cat >&2 || true
  exit 1
}

# ---- throwaway commits: the split (HEAD), a web-only change, two runner changes, a broken web service ----
git clone -q --shared "$here" "$T/src"
cd "$T/src"
git checkout -q -b lu-a "$base"
git checkout -q -b lu-b "$(git -C "$here" rev-parse HEAD)"
git config user.email lutest@localhost
git config user.name lutest
commit() { git add -A && git commit -qm "$1" && git rev-parse HEAD; }
git checkout -q -b lu-web lu-b
sed -i 's|<h1 className="page-title">Helm</h1>|<h1 className="page-title">Helm</h1>{/* lutest web change */}|' web/src/update.tsx
commit "web-only change" >/dev/null
git checkout -q -b lu-run lu-web
echo "// lutest runner change" >>server/tools.ts
commit "runner change" >/dev/null
git checkout -q -b lu-run2 lu-run
echo "// lutest runner change 2" >>server/tools.ts
commit "runner change 2" >/dev/null
git checkout -q -b lu-run2web lu-run2
sed -i 's|{/\* lutest web change \*/}|{/* lutest web change on run2 */}|' web/src/update.tsx
commit "web-only change on runner 2" >/dev/null
git checkout -q -b lu-run3 lu-run2
echo "// lutest runner change 3" >>server/tools.ts
commit "runner change 3" >/dev/null
git checkout -q -b lu-broken lu-run2
sed -i 's|^export async function startWeb(.*{$|&\n  throw new Error("lutest: broken web service");|' server/web-main.ts
commit "broken web service" >/dev/null
cd "$here"

build() { nix --extra-experimental-features 'nix-command flakes' build "git+file://$T/src?ref=$1" --no-link --print-out-paths 2>/dev/null; }
echo "building the throwaway commits (cached after the first time) ..."
A=$(build lu-a)
B=$(build lu-b)
for b in lu-web lu-run lu-run2 lu-run2web lu-run3 lu-broken; do build $b >/dev/null; done
[ ! -f "$A/lib/helm/runner.json" ] || fail "the base build is not from before the split"
[ -f "$B/lib/helm/runner.json" ] || fail "the split build has no runner.json"
WEB_HASH_SAME=$(jq -r .hash "$B/lib/helm/runner.json")
[ "$(jq -r .hash "$(build lu-web)/lib/helm/runner.json")" = "$WEB_HASH_SAME" ] || fail "a web-only change changed the runner hash"
[ "$(jq -r .hash "$(build lu-run)/lib/helm/runner.json")" != "$WEB_HASH_SAME" ] || fail "a runner change kept the runner hash"
ok "runner hash: same for a web-only change, different for a runner change"

# ---- units, as nix/module.nix makes them (system units there; user units here) ----
start=$here/nix/helm-start.sh
stamp="stamp-a"
# write_units PACKAGE [one-process]: the runner and web units for PACKAGE (HELM_START_PACKAGE); "one-process" writes the
# runner unit as it was before the split (the package's helm, no web unit), for the first-deploy scenario.
write_units() {
  local package=$1 envs
  envs="Environment=PATH=$PATH
Environment=HOME=$HOME
Environment=HELM_DATA=$data
Environment=HELM_PROJECTS=$T/projects
Environment=HELM_PORT=$port
Environment=HELM_HOST=127.0.0.1
Environment=HELM_TOKEN=$token
Environment=HELM_CLAUDE_PATH=$fake
Environment=HELM_FAKE_DIR=$T/fake
Environment=FAKE_SPEED=1
Environment=HELM_LIVE_UPDATE_REPO=$T/src
Environment=HELM_LIVE_UPDATE_REF=lu-next
Environment=HELM_LIVE_UPDATE_DIR=$live
Environment=HELM_LIVE_UPDATE_SCOPE=user
Environment=HELM_LIVE_UPDATE_UPDATE_UNIT=$U
Environment=HELM_LIVE_UPDATE_ROLLBACK_UNIT=$RB
Environment=HELM_LIVE_UPDATE_RESTART_UNIT=$X
Environment=HELM_LIVE_UPDATE_ADOPT_UNIT=$AD
Environment=HELM_LIVE_UPDATE_WEB_UNIT=$W
Environment=HELM_START_LIVE=$live
Environment=HELM_START_PACKAGE=$package
Environment=HELM_UNIT_STAMP=$stamp"
  if [ "${2:-}" = one-process ]; then
    cat >"$units/$R" <<EOF
[Unit]
Description=Helm live-update check: one process, as before the split
[Service]
$envs
ExecStart=$package/bin/helm
Restart=on-failure
RestartSec=1
KillMode=mixed
TimeoutStopSec=30
EOF
    return
  fi
  cat >"$units/$R" <<EOF
[Unit]
Description=Helm live-update check: runner
Wants=$W
[Service]
$envs
ExecStart=/run/current-system/sw/bin/bash $start runner
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=30
EOF
  cat >"$units/$W" <<EOF
[Unit]
Description=Helm live-update check: web
After=$R
StartLimitIntervalSec=0
[Service]
$envs
ExecStart=/run/current-system/sw/bin/bash $start web
Restart=on-failure
RestartSec=1
EOF
}
# The update, rollback, restart-agents and adopt units (helm-update, helm-rollback, helm-restart-agents and
# helm-split-adopt in nix/module.nix). The update unit builds the branch lu-next, which the scenarios move.
luenv="Environment=PATH=$PATH
Environment=HELM_LU_DIR=$live
Environment=HELM_LU_PACKAGE=$A
Environment=HELM_LU_SERVICE=$R
Environment=HELM_LU_WEB_SERVICE=$W
Environment=HELM_LU_SCOPE=user
Environment=HELM_LU_URL=$url
Environment=HELM_LU_TIMEOUT=40
Environment=HELM_LU_POLL=1
Environment=HELM_LU_GC=0
Environment=HELM_LU_MIN_FREE_MB=0
Environment=HELM_LU_FLAKE=git+file://$T/src?ref=lu-next"
for pair in "$X:restart-runner:oneshot" "$U:update:oneshot" "$RB:rollback:oneshot" "$AD:adopt:simple"; do
  IFS=: read -r unit mode type <<<"$pair"
  cat >"$units/$unit" <<EOF
[Unit]
Description=Helm live-update check: $mode
[Service]
Type=$type
$luenv
ExecStart=/run/current-system/sw/bin/bash $here/nix/live-update.sh $mode
EOF
done
git -C "$T/src" branch -q lu-next lu-b
# The adopt run is only used in the first-deploy scenario, where the installed package is the split build.
echo "Environment=HELM_LU_PACKAGE=$B" >>"$units/$AD"

# shoot NAME: a phone screenshot of the Helm page into $SHOTS (when set).
shoot() {
  [ -n "${SHOTS:-}" ] || return 0
  mkdir -p "$SHOTS"
  node --input-type=module -e "
    import { launch } from '$here/.claude/skills/helm-ui-check/scripts/browser.mjs';
    const b = await launch();
    const p = await b.page({ device: 'phone', base: '$url/', cookie: '$cookie' });
    await p.go('#/helm');
    await new Promise((r) => setTimeout(r, 1500));
    await p.shot('$SHOTS/$1.png');
    if (p.errors.length) console.error(p.errors);
    await b.close();
  "
}

lu() {
  HELM_LU_GC=0 HELM_LU_MIN_FREE_MB=0 HELM_LU_DIR=$live HELM_LU_FLAKE="git+file://$T/src?ref=$2" HELM_LU_PACKAGE=${LU_PACKAGE:-$A} HELM_LU_SERVICE=$R HELM_LU_WEB_SERVICE=$W \
    HELM_LU_SCOPE=user HELM_LU_URL=$url HELM_LU_TIMEOUT=40 HELM_LU_POLL=1 bash "$here/nix/live-update.sh" "$1"
}
health() { curl -s --max-time 3 "$url/api/health"; }
cookie=""
login() { cookie=$(curl -s -i -H 'content-type: application/json' -d "{\"token\":\"$token\"}" "$url/api/login" | grep -i '^set-cookie' | sed 's/^[^:]*: //; s/;.*//'); }
api() { curl -s -H "cookie: $cookie" -H 'content-type: application/json' "$@"; }
wait_for() { # SECONDS DESCRIPTION COMMAND...
  local n=$1 what=$2; shift 2
  for _ in $(seq $((n * 5))); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.2; done
  fail "timed out: $what"
}
runner_pid() { systemctl --user show -p MainPID --value "$R"; }
agent_status() { api "$url/api/projects/$project" | jq -r --arg n "$1" '[.agents[] | select(.name == $n)] | last | .status // empty'; }
statuses() { api "$url/api/projects/$project" | jq -r '[.agents[].status] | join(",")'; }

# 0. first deploy: the one-process Helm from before the split, an agent mid-turn, then the rebuild
write_units "$B" one-process
systemctl --user daemon-reload
systemctl --user start "$R"
wait_for 30 "the one-process Helm to answer" curl -sf "$url/api/health"
[ "$(health | jq -r .runner.mode)" = all ] || fail "not one process before the rebuild"
login
project0=$(api -X POST -d '{"mode":"new","name":"First deploy"}' "$url/api/projects" | jq -r .id)
api -d '{"text":"DEMO: before the rebuild."}' "$url/api/projects/$project0/message" >/dev/null
wait_for 60 "the engineer working" bash -c "curl -s -H 'cookie: $cookie' $url/api/projects/$project0 | jq -e '[.agents[] | select(.status == \"working\" and .parent_id != null)] | length > 0'"
pid=$(runner_pid)
# helm-web from an earlier attempt, failed.
printf '[Service]\nExecStart=/run/current-system/sw/bin/false\n' >"$units/$W"
systemctl --user daemon-reload
systemctl --user start "$W" || true
wait_for 10 "the web unit failed" bash -c "[ \"\$(systemctl --user is-active $W)\" = failed ]"
# The rebuild: new unit files; helm.service is not restarted (restartIfChanged = false); the adopt unit starts.
write_units "$B"
systemctl --user daemon-reload
systemctl --user start "$AD"
wait_for 60 "the adopt run waiting for the agent" bash -c "[ \"\$(jq -r .stage $live/status.json 2>/dev/null)\" = waiting ]"
[ "$(runner_pid)" = "$pid" ] || fail "the one-process Helm was replaced while an agent was mid-turn"
login
r=$(api -d '{}' "$url/api/version/update" || true); grep -q "switching to a runner and a web service" <<<"$r" || fail "Update during the first deploy's wait was not refused: $r"
r=$(api -d '{}' "$url/api/version/rollback" || true); grep -q "switching to a runner and a web service" <<<"$r" || fail "Roll back during the first deploy's wait was not refused: $r"
ok "while the first deploy waits for idle agents, Update and Roll back are refused, saying why"
r=$(api -d '{}' "$url/api/version/end-wait" || true); jq -e .status >/dev/null <<<"$r" || fail "Don't restart refused: $r"
[ "$(jq -r .stage "$live/status.json")" = cancelled ] || fail "the adopt wait did not end as cancelled: $(jq -r .stage "$live/status.json")"
[ "$(runner_pid)" = "$pid" ] || fail "Don't restart restarted the one-process Helm"
[ "$(health | jq -r .runner.mode)" = all ] || fail "Don't restart changed the running Helm"
ok "Don't restart during the first deploy's wait: nothing restarted or rolled back (helm-web left as it was: failed, from before)"
# The Helm page offers the switch: "Switch to two services now" starts the adopt run (when idle, as before).
[ "$(api "$url/api/version" | jq -r .oneProcess)" = true ] || fail "the Helm page does not offer the switch: $(api "$url/api/version" | jq -c '{oneProcess, split}')"
shoot one-process
r=$(api -d '{}' "$url/api/version/adopt" || true); jq -e .status >/dev/null <<<"$r" || fail "Switch to two services now refused: $r"
wait_for 240 "the adopt run healthy" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = healthy ]"
[ "$(health | jq -r .runner.mode)" = web ] || fail "not split after adopting"
[ "$(systemctl --user is-active "$W")" = active ] || fail "the failed web unit was not started"
[ "$(runner_pid)" != "$pid" ] || fail "the one-process Helm still runs"
login
case "$(api "$url/api/projects/$project0" | jq -r '[.agents[].status] | join(",")')" in *interrupted*|*error*) fail "an agent was interrupted by the first deploy" ;; esac
ok "first deploy: after the rebuild, adopt waited for the agent mid-turn, then the runner and the (failed) web unit took over"

# 0c. An Update while Helm still runs as one process under the split units (the switch not done yet): it switches
# both, instead of starting a new dashboard that cannot get the port and rolling back.
systemctl --user stop "$W" "$R"
write_units "$B" one-process
systemctl --user daemon-reload
systemctl --user start "$R"
wait_for 30 "the one-process Helm to answer" bash -c "curl -s $url/api/health | jq -e '.runner.mode == \"all\"'"
write_units "$B"
systemctl --user daemon-reload
login
api -d '{"text":"DEMO: still one process."}' "$url/api/projects/$project0/message" >/dev/null
wait_for 60 "the engineer working" bash -c "curl -s -H 'cookie: $cookie' $url/api/projects/$project0 | jq -e '[.agents[] | select(.status == \"working\" and .parent_id != null)] | length > 0'"
LU_PACKAGE=$B lu update lu-web || fail "an Update while Helm runs as one process under the split units"
[ "$(jq -r .stage "$live/status.json")" = healthy ] || fail "the update: $(jq -r .stage "$live/status.json")"
[ "$(health | jq -r .runner.mode)" = web ] || fail "not split after the Update"
[ "$(health | jq -r .rev)" = "$(git -C "$T/src" rev-parse lu-web)" ] || fail "not on the new build"
[ "$(systemctl --user is-active "$W")" = active ] || fail "helm-web not active"
login
wait_for 120 "the interrupted agent resumed and finished" bash -c "! curl -s -H 'cookie: $cookie' $url/api/projects/$project0 | jq -e '[.agents[] | select(.status == \"interrupted\" or .status == \"working\")] | length > 0'"
ok "an Update while Helm still runs as one process switched both (not rolled back); the agent it interrupted was resumed"
# Back to a clean start for the rest: the pre-split package, no links.
systemctl --user stop "$AD" "$W" "$R"
rm -rf "$live"
mkdir -p "$live/generations"
write_units "$A"
systemctl --user daemon-reload

# 0b. first deploy when `current` points at a pre-split build (an install that has not updated to the split yet)
write_units "$A" one-process
ln -sfn "$A" "$live/current"
systemctl --user daemon-reload
systemctl --user start "$R"
wait_for 30 "the pre-split Helm to answer" curl -sf "$url/api/health"
[ "$(health | jq -r '.runner // "none"')" = none ] || fail "not the pre-split build"
login
project0b=$(api -X POST -d '{"mode":"new","name":"Pre-split"}' "$url/api/projects" | jq -r .id)
api -d '{"text":"DEMO: before everything."}' "$url/api/projects/$project0b/message" >/dev/null
wait_for 60 "the engineer working" bash -c "curl -s -H 'cookie: $cookie' $url/api/projects/$project0b | jq -e '[.agents[] | select(.status == \"working\" and .parent_id != null)] | length > 0'"
pid=$(runner_pid)
write_units "$B"
systemctl --user daemon-reload
systemctl --user start "$W" "$AD"
sleep 5
[ "$(runner_pid)" = "$pid" ] || fail "the rebuild restarted the pre-split Helm"
[ "$(systemctl --user is-active "$W")" = inactive ] || fail "helm-web is $(systemctl --user is-active "$W") with a pre-split runner build, expected inactive"
[ "$(systemctl --user show -p NRestarts --value "$W")" = 0 ] || fail "helm-web restarted itself"
[ "$(systemctl --user is-active "$AD")" = inactive ] || fail "adopt is $(systemctl --user is-active "$AD")"
[ "$(health | jq -r '.runner // "none"')" = none ] || fail "the pre-split Helm was replaced by the rebuild"
ok "rebuild with current on a pre-split build: nothing restarts; helm-web stays down cleanly (not failed, no restarts); adopt leaves it"
lu update lu-b || fail "Update to the split build after the rebuild"
[ "$(health | jq -r .runner.mode)" = web ] || fail "not split after the Update"
[ "$(systemctl --user is-active "$W")" = active ] || fail "helm-web not active after the Update"
login
wait_for 120 "the interrupted agent resumed and finished" bash -c "! curl -s -H 'cookie: $cookie' $url/api/projects/$project0b | jq -e '[.agents[] | select(.status == \"interrupted\" or .status == \"working\")] | length > 0'"
ok "then the next Update split Helm; the agent it interrupted was recorded and resumed, and finished"
systemctl --user stop "$AD" "$W" "$R"
rm -rf "$live"
mkdir -p "$live/generations"
write_units "$A"
systemctl --user daemon-reload

# 1. pre-split build under the two units
systemctl --user start "$R" "$W"
wait_for 30 "the pre-split build to answer" curl -sf "$url/api/health"
[ "$(health | jq -r .rev)" = "$(jq -r .rev "$A/lib/helm/version.json")" ] || fail "not running the pre-split build"
[ "$(health | jq -r '.runner // "none"')" = none ] || fail "the pre-split build reports a runner"
sleep 2
[ "$(systemctl --user is-active "$W")" = inactive ] || fail "the web unit is $(systemctl --user is-active "$W"), expected inactive"
[ "$(systemctl --user show -p NRestarts --value "$W")" = 0 ] || fail "the web unit restarted itself"
ok "a pre-split build runs as one process under the runner unit; the web unit exits cleanly and stays down"

login
project=$(api -X POST -d '{"mode":"new","name":"Demo"}' "$url/api/projects" | jq -r .id)

# 2. pre-split -> split
lu update lu-b || fail "update to the split build"
[ "$(health | jq -r .runner.mode)" = web ] || fail "not split after the update"
[ "$(systemctl --user is-active "$W")" = active ] || fail "the web unit is not active"
login
ok "update from the pre-split build to the split build: runner and web service both up ($(health | jq -c .runner))"

# An adopt run cut short (a reboot during its wait) left its status waiting: the next adopt run (at boot) closes it.
now=$(date +%s%3N)
jq -n --argjson t "$now" '{id: "stale-adopt", kind: "adopt", stage: "waiting", message: "waiting", log: "", fromRev: "", toRev: "", startedAt: $t, updatedAt: $t}' >"$live/status.json"
[ "$(api "$url/api/version" | jq -r .busy)" = true ] || fail "the stale adopt status does not count as running"
systemctl --user start "$AD"
wait_for 30 "the adopt run to end" bash -c "[ \"\$(systemctl --user is-active $AD)\" != active ] && [ \"\$(systemctl --user is-active $AD)\" != activating ]"
[ "$(jq -r .stage "$live/status.json")" = cancelled ] || fail "the stale adopt status was left: $(jq -r .stage "$live/status.json")"
[ "$(api "$url/api/version" | jq -r .busy)" = false ] || fail "the dashboard still sees a run"
ok "an adopt status left waiting by a reboot is closed by the next adopt run, so Update is not refused"

# 3. web-only update with an agent mid-turn
api -d '{"text":"DEMO: start the work."}' "$url/api/projects/$project/message" >/dev/null
wait_for 60 "the engineer working" bash -c "[ \"\$(curl -s -H 'cookie: $cookie' $url/api/projects/$project | jq -r '[.agents[] | select(.name == \"Login engineer\")] | last | .status')\" = working ]"
pid=$(runner_pid)
lu update lu-web || fail "web-only update"
[ "$(jq -r .agents "$live/status.json")" = keep ] || fail "the update was not web-only"
[ "$(runner_pid)" = "$pid" ] || fail "the runner restarted during a web-only update"
login
wait_for 90 "the engineer to finish" bash -c "[ \"\$(curl -s -H 'cookie: $cookie' $url/api/projects/$project | jq -r '[.agents[] | select(.name == \"Login engineer\")] | last | .status')\" = done ]"
case "$(statuses)" in *interrupted*|*error*) fail "an agent was interrupted: $(statuses)" ;; esac
ok "web-only update: only the web service restarted (runner pid $pid kept); the agent mid-turn finished undisturbed"

# a runner crash leaves the dashboard up
wpid=$(systemctl --user show -p MainPID --value "$W")
pid=$(runner_pid)
kill -9 "$pid"
wait_for 10 "the dashboard to say agents are restarting" bash -c "curl -s $url/api/health | jq -e '.runner.up == false'"
wait_for 30 "the runner back" bash -c "curl -s $url/api/health | jq -e '.runner.up'"
[ "$(systemctl --user show -p MainPID --value "$W")" = "$wpid" ] || fail "the runner crash restarted the web service"
[ "$(runner_pid)" != "$pid" ] || fail "the runner did not restart"
ok "a runner crash: the runner restarted by itself, the dashboard stayed up throughout (web pid $wpid)"

# 4. runner update waits for idle agents
api -d '{"text":"DEMO: second round."}' "$url/api/projects/$project/message" >/dev/null
wait_for 60 "an engineer working" bash -c "curl -s -H 'cookie: $cookie' $url/api/projects/$project | jq -e '[.agents[] | select(.status == \"working\" and .parent_id != null)] | length > 0'"
pid=$(runner_pid)
lu update lu-run >"$T/lu4.log" 2>&1 &
lupid=$!
wait_for 120 "the waiting stage" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = waiting ]"
login
[ "$(health | jq -r .rev)" = "$(git -C "$T/src" rev-parse lu-run)" ] || fail "the new dashboard is not running while the runner waits"
[ "$(runner_pid)" = "$pid" ] || fail "the runner restarted before agents were idle"
echo "     waiting: $(jq -r .message "$live/status.json")"
# The dashboard not answering is not taken for idle agents.
systemctl --user stop "$W"
sleep 4
[ "$(jq -r .stage "$live/status.json")" = waiting ] || fail "with the dashboard down the wait ended: $(jq -r .stage "$live/status.json")"
[ "$(runner_pid)" = "$pid" ] || fail "the runner restarted while the dashboard did not answer"
systemctl --user start "$W"
wait_for 30 "the dashboard back" curl -sf "$url/api/health"
login
ok "while an update waits, a dashboard that does not answer is not taken for idle agents"
wait "$lupid" || { cat "$T/lu4.log" >&2; fail "runner update"; }
[ "$(runner_pid)" != "$pid" ] || fail "the runner was not restarted"
[ "$(health | jq -r .runner.rev)" = "$(git -C "$T/src" rev-parse lu-run)" ] || fail "the runner is not on the new build"
case "$(statuses)" in *interrupted*) fail "an agent was interrupted: $(statuses)" ;; esac
ok "runner update: new dashboard at once, runner restarted only once no agent was mid-turn ($(statuses))"

# 5. runner update, Restart agents now
login
api -d '{"text":"DEMO: third round."}' "$url/api/projects/$project/message" >/dev/null
wait_for 60 "an engineer working" bash -c "curl -s -H 'cookie: $cookie' $url/api/projects/$project | jq -e '[.agents[] | select(.status == \"working\" and .parent_id != null)] | length > 0'"
pid=$(runner_pid)
lu update lu-run2 >"$T/lu5.log" 2>&1 &
lupid=$!
wait_for 120 "the waiting stage" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = waiting ]"
login
r=$(api -d '{}' "$url/api/version/restart-agents"); jq -e '.status.stage' >/dev/null <<<"$r" || fail "Restart agents now was refused: $r"
wait "$lupid" || { cat "$T/lu5.log" >&2; fail "runner update with Restart agents now"; }
[ "$(runner_pid)" != "$pid" ] || fail "the runner was not restarted"
login
# The interrupted engineer is resumed once the update reports healthy, then finishes.
wait_for 120 "the interrupted agent to be resumed and finish" bash -c "! curl -s -H 'cookie: $cookie' $url/api/projects/$project | jq -e '[.agents[] | select(.status == \"interrupted\" or .status == \"working\")] | length > 0'"
ok "Restart agents now: the runner restarted at once; the interrupted agent was resumed and finished ($(statuses))"

# while an update waits: supersede, Cancel, an orderly runner restart (all through the API). The director waiting on a
# permission prompt nobody answers keeps an agent mid-turn for as long as this takes.
login
curl -s -X PATCH -H "cookie: $cookie" -H 'content-type: application/json' -d '{"permission_answerer":"user"}' "$url/api/projects/$project" >/dev/null
api -d '{"text":"ASK-PERMISSION and wait."}' "$url/api/projects/$project/message" >/dev/null
wait_for 60 "the director waiting on the permission" bash -c "[ \"\$(curl -s $url/api/health | jq -r .runner.working)\" -ge 1 ]"
runner_rev=$(health | jq -r .runner.rev)
pid=$(runner_pid)
git -C "$T/src" branch -qf lu-next lu-run
r=$(api -d '{}' "$url/api/version/update" || true); jq -e .status >/dev/null <<<"$r" || fail "Update refused: $r"
wait_for 120 "the first update waiting" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = waiting ]"
first=$(jq -r .id "$live/status.json")
login
shoot waiting-cancel
git -C "$T/src" branch -qf lu-next lu-web
r=$(api -d '{}' "$url/api/version/update" || true); jq -e .status >/dev/null <<<"$r" || fail "a second Update during the wait was refused: $r"
wait_for 120 "the second update waiting" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = waiting ] && [ \"\$(jq -r .id $live/status.json)\" != $first ]"
[ "$(health | jq -r .rev)" = "$(git -C "$T/src" rev-parse lu-web)" ] || fail "the second update's dashboard is not running"
ok "a new Update supersedes one waiting for idle agents"
login
r=$(api -d '{}' "$url/api/version/rollback" || true); jq -e .status >/dev/null <<<"$r" || fail "Cancel refused: $r"
wait_for 120 "the cancel done" bash -c "jq -r .message $live/status.json | grep -q cancelled"
[ "$(jq -r .stage "$live/status.json")" = healthy ] || fail "cancel: $(jq -r .stage "$live/status.json")"
[ "$(health | jq -r .rev)" = "$runner_rev" ] || fail "the dashboard is not back on the runner's build"
[ "$(runner_pid)" = "$pid" ] || fail "supersede or cancel restarted the runner"
ok "Cancel during the wait: the dashboard is back on the runner's build $(echo "$runner_rev" | cut -c1-7), runner untouched"
# A stop during the wait (a reboot, a rebuild) records the agent mid-turn, and the next runner resumes it.
login
git -C "$T/src" branch -qf lu-next lu-run
r=$(api -d '{}' "$url/api/version/update" || true); jq -e .status >/dev/null <<<"$r" || fail "Update refused: $r"
wait_for 120 "the update waiting again" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = waiting ]"
since=$(date +%s)
systemctl --user restart "$R"
wait_for 60 "the runner back" bash -c "curl -s $url/api/health | jq -e '.runner.up'"
journalctl --user-unit "$R" --since "@$since" --no-pager -o cat | grep -qE "Stopping: [1-9][0-9]* agent\(s\) to resume at the next start" || fail "a stop during the wait did not record the agents"
journalctl --user-unit "$R" --since "@$since" --no-pager -o cat | grep -qE "Resumed [1-9][0-9]* agent\(s\) after the restart" || wait_for 30 "the agents resumed" bash -c "journalctl --user-unit $R --since @$since --no-pager -o cat | grep -qE 'Resumed [1-9][0-9]* agent'"
ok "a runner restart during the wait recorded the agent mid-turn and resumed it"
# The resumed director is no longer waiting on anything: the update finishes.
wait_for 180 "the update to finish" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = healthy ]"
[ "$(health | jq -r .runner.rev)" = "$(git -C "$T/src" rev-parse lu-run)" ] || fail "the runner is not on lu-run after the wait"
login
curl -s -X PATCH -H "cookie: $cookie" -H 'content-type: application/json' -d '{"permission_answerer":"director"}' "$url/api/projects/$project" >/dev/null
# Back on lu-run2 for the scenarios after (no agent working: the runner restarts at once).
lu update lu-run2 >/dev/null 2>&1 || fail "back to lu-run2"

# Roll back after a Cancel undoes the last finished update, never brings the cancelled dashboard back. The last finished
# update before it is web-only (last-kind web), the case in which Roll back would use web-previous.
lu update lu-run2web >/dev/null 2>&1 || fail "web-only update to lu-run2web"
[ "$(jq -r .agents "$live/status.json")" = keep ] || fail "lu-run2web was not web-only"
previous_rev=$(jq -r .rev "$(readlink -f "$live/previous")/lib/helm/version.json")
login
curl -s -X PATCH -H "cookie: $cookie" -H 'content-type: application/json' -d '{"permission_answerer":"user"}' "$url/api/projects/$project" >/dev/null
api -d '{"text":"ASK-PERMISSION once more."}' "$url/api/projects/$project/message" >/dev/null
wait_for 60 "the director waiting on the permission" bash -c "[ \"\$(curl -s $url/api/health | jq -r .runner.working)\" -ge 1 ]"
git -C "$T/src" branch -qf lu-next lu-run3
r=$(api -d '{}' "$url/api/version/update" || true); jq -e .status >/dev/null <<<"$r" || fail "Update refused: $r"
wait_for 120 "the update waiting" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = waiting ]"
login
r=$(api -d '{}' "$url/api/version/rollback" || true); jq -e .status >/dev/null <<<"$r" || fail "Cancel refused: $r"
wait_for 120 "the cancel done" bash -c "jq -r .message $live/status.json | grep -q cancelled"
[ "$(health | jq -r .rev)" = "$(git -C "$T/src" rev-parse lu-run2web)" ] || fail "cancel did not go back to lu-run2web"
login
r=$(api -d '{}' "$url/api/version/rollback" || true); jq -e .status >/dev/null <<<"$r" || fail "Roll back refused: $r"
wait_for 180 "the rollback done" bash -c "jq -e '.kind == \"rollback\" and (.stage == \"healthy\" or .stage == \"rolled-back\" or .stage == \"failed\")' $live/status.json"
[ "$(jq -r .stage "$live/status.json")" = healthy ] || fail "Roll back after Cancel: $(jq -r .stage "$live/status.json")"
[ "$(health | jq -r .rev)" != "$(git -C "$T/src" rev-parse lu-run3)" ] || fail "Roll back after Cancel brought the cancelled dashboard back"
[ "$(health | jq -r .rev)" = "$previous_rev" ] || fail "Roll back after Cancel went to $(health | jq -r .rev), expected the previous build $previous_rev"
ok "Roll back after a Cancel undoes the last finished update (to $(echo "$previous_rev" | cut -c1-7)), not back to the cancelled dashboard"

# A dashboard that never answers again during the wait: the run gives up, restores the dashboard and exits failed.
login
api -d '{"text":"ASK-PERMISSION and wait again."}' "$url/api/projects/$project/message" >/dev/null
wait_for 60 "the director waiting on the permission" bash -c "[ \"\$(curl -s $url/api/health | jq -r .runner.working)\" -ge 1 ]"
web_rev=$(health | jq -r .rev)
pid=$(runner_pid)
HELM_LU_NO_ANSWER_SECONDS=8 lu update lu-run3 >"$T/lu-silent.log" 2>&1 &
lupid=$!
wait_for 120 "the update waiting" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = waiting ]"
systemctl --user stop "$W"
if wait "$lupid"; then fail "the run did not give up on a silent dashboard"; fi
[ "$(jq -r .stage "$live/status.json")" = failed ] || fail "status after giving up: $(jq -r .stage "$live/status.json")"
jq -r .message "$live/status.json" | grep -q "has not answered" || fail "the status does not say why: $(jq -r .message "$live/status.json")"
wait_for 30 "the dashboard back" curl -sf "$url/api/health"
[ "$(health | jq -r .rev)" = "$web_rev" ] || fail "the dashboard was not restored to $web_rev"
[ "$(runner_pid)" = "$pid" ] || fail "giving up restarted the runner"
ok "a dashboard that never answers during the wait: the run gave up, restored the dashboard and failed, runner untouched"
login
# The director still waits on its permission prompt: deny it, so the agents are idle for what follows.
rid=$(api "$url/api/inbox" | jq -r '[.. | objects | select(.kind? == "permission" and .status? == "open") | .id] | first // empty')
[ -n "$rid" ] && api -d '{"choice":"Deny"}' "$url/api/requests/$rid/answer" >/dev/null
wait_for 60 "the agents idle" bash -c "[ \"\$(curl -s $url/api/health | jq -r .runner.working)\" = 0 ]"
curl -s -X PATCH -H "cookie: $cookie" -H 'content-type: application/json' -d '{"permission_answerer":"director"}' "$url/api/projects/$project" >/dev/null
lu update lu-run2 >/dev/null 2>&1 || fail "back to lu-run2"

# 6. broken web-only build
pid=$(runner_pid)
if lu update lu-broken >"$T/lu6.log" 2>&1; then fail "a broken build was accepted"; fi
[ "$(jq -r .stage "$live/status.json")" = rolled-back ] || fail "not rolled back: $(jq -r .stage "$live/status.json")"
[ "$(runner_pid)" = "$pid" ] || fail "the runner restarted for a broken web-only build"
[ "$(health | jq -r .rev)" = "$(git -C "$T/src" rev-parse lu-run2)" ] || fail "not back on the previous dashboard"
ok "a broken web-only build: rolled back by itself, runner untouched"

# 7. rollback after a web-only update
lu update lu-web >/dev/null 2>&1 || true # lu-web has a different runner: a runner update (no agents working: immediate)
[ "$(health | jq -r .rev)" = "$(git -C "$T/src" rev-parse lu-web)" ] || fail "not on lu-web"
git -C "$T/src" checkout -q -b lu-web2 lu-web
sed -i 's|{/\* lutest web change \*/}|{/* lutest web change 2 */}|' "$T/src/web/src/update.tsx"
git -C "$T/src" commit -qam "web-only change 2"
pid=$(runner_pid)
lu update lu-web2 || fail "web-only update 2"
[ "$(jq -r .agents "$live/status.json")" = keep ] || fail "update 2 was not web-only"
lu rollback x || fail "rollback"
[ "$(health | jq -r .rev)" = "$(git -C "$T/src" rev-parse lu-web)" ] || fail "rollback did not return to lu-web"
[ "$(runner_pid)" = "$pid" ] || fail "rolling back a web-only update restarted the runner"
ok "rollback after a web-only update: only the dashboard went back, runner pid $pid kept"

# 8. an orderly restart of the runner outside any update resumes the agent it interrupted
login
api -d '{"text":"DEMO: fourth round."}' "$url/api/projects/$project/message" >/dev/null
wait_for 60 "an engineer working" bash -c "curl -s -H 'cookie: $cookie' $url/api/projects/$project | jq -e '[.agents[] | select(.status == \"working\" and .parent_id != null)] | length > 0'"
since=$(date +%s)
systemctl --user restart "$R"
wait_for 60 "the runner back" bash -c "curl -s $url/api/health | jq -e '.runner.up'"
login
wait_for 120 "the interrupted agent to be resumed and finish" bash -c "! curl -s -H 'cookie: $cookie' $url/api/projects/$project | jq -e '[.agents[] | select(.status == \"interrupted\" or .status == \"working\")] | length > 0'"
journalctl --user-unit "$R" --since "@$since" --no-pager -o cat | grep -qE "Stopping: [1-9][0-9]* agent\(s\) to resume at the next start" || fail "the stop did not record agents to resume"
ok "an orderly restart outside an update: the interrupted agent was resumed and finished ($(statuses))"

# 9. a system rebuild changed the configuration: the web service restarted with it, the runner did not
sed -i 's/HELM_UNIT_STAMP=stamp-a/HELM_UNIT_STAMP=stamp-b/' "$units/$R" "$units/$W"
systemctl --user daemon-reload
pid=$(runner_pid)
systemctl --user restart "$W"
wait_for 30 "the dashboard back" curl -sf "$url/api/health"
login
[ "$(api "$url/api/version" | jq -r .split.configPending)" = true ] || fail "the changed configuration is not shown: $(api "$url/api/version" | jq -c .split)"
shoot config-pending
api -d '{"text":"DEMO: fifth round."}' "$url/api/projects/$project/message" >/dev/null
wait_for 60 "an engineer working" bash -c "curl -s -H 'cookie: $cookie' $url/api/projects/$project | jq -e '[.agents[] | select(.status == \"working\" and .parent_id != null)] | length > 0'"
r=$(api -d '{}' "$url/api/version/restart-agents"); jq -e '.status' >/dev/null <<<"$r" || fail "Restart agents when idle was refused: $r"
wait_for 60 "the restart waiting for idle agents" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = waiting ] && [ \"\$(jq -r .kind $live/status.json)\" = restart-runner ]"
[ "$(runner_pid)" = "$pid" ] || fail "the runner restarted while an agent was mid-turn"
shoot config-waiting
r=$(api -d '{}' "$url/api/version/rollback" || true); grep -q "waiting to restart" <<<"$r" || fail "Roll back during a restart of the agents was not refused: $r"
r=$(api -d '{}' "$url/api/version/update" || true); grep -q "waiting to restart" <<<"$r" || fail "Update during a restart of the agents was not refused: $r"
before_rev=$(health | jq -r .rev)
r=$(api -d '{}' "$url/api/version/end-wait" || true); jq -e .status >/dev/null <<<"$r" || fail "Don't restart refused: $r"
[ "$(jq -r .stage "$live/status.json")" = cancelled ] || fail "the wait did not end as cancelled: $(jq -r .stage "$live/status.json")"
[ "$(runner_pid)" = "$pid" ] || fail "Don't restart restarted the runner"
[ "$(health | jq -r .rev)" = "$before_rev" ] || fail "Don't restart changed the dashboard's build"
[ "$(health | jq -r .runner.mode)" = web ] || fail "Don't restart left Helm unsplit"
ok "Don't restart during a restart of the agents: nothing restarted or rolled back; Update and Roll back were refused meanwhile"
r=$(api -d '{}' "$url/api/version/restart-agents" || true); jq -e '.status' >/dev/null <<<"$r" || fail "Restart agents when idle (again) was refused: $r"
wait_for 180 "the runner restarted with the new configuration" bash -c "[ \"\$(jq -r .stage $live/status.json)\" = healthy ]"
[ "$(runner_pid)" != "$pid" ] || fail "the runner was not restarted"
login
[ "$(api "$url/api/version" | jq -r .split.configPending)" = false ] || fail "the configuration still shows as changed"
case "$(statuses)" in *interrupted*) fail "an agent was interrupted: $(statuses)" ;; esac
shoot config-applied
ok "a changed configuration is shown; Restart agents when idle waited for the busy agent, then restarted the runner ($(statuses))"

# 10. back to the pre-split build (release moved back)
lu update lu-a || fail "update to the pre-split build"
[ "$(health | jq -r '.runner // "none"')" = none ] || fail "still split"
[ "$(health | jq -r .rev)" = "$(jq -r .rev "$A/lib/helm/version.json")" ] || fail "not on the pre-split build"
sleep 3
[ "$(systemctl --user is-active "$W")" = inactive ] || fail "the web unit is $(systemctl --user is-active "$W") under a pre-split build"
ok "update to a pre-split build: one process again under the runner unit; the web unit stays down cleanly"
lu rollback x || fail "rollback to the split build"
[ "$(health | jq -r .runner.mode)" = web ] || fail "rollback did not return to the split build"
ok "rollback from the pre-split build to the split one: both units up again"
echo "all live-update scenarios passed"
