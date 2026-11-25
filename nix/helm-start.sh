# What helm.service and helm-web.service start (nix/module.nix): the build that live update switched to, else the
# installed package, in the mode that build supports.
#
#   helm-start runner   helm.service: the runner (`helm runner`), or for a build from before the split (no
#                       lib/helm/runner.json) the whole of Helm in one process, which then serves the dashboard too
#   helm-start web      helm-web.service: the web service (`helm web`); exits at once, successfully, when the runner's
#                       build is from before the split, since that one serves the dashboard itself
#   helm-start all      one process (services.helm.split off)
#
#   HELM_START_LIVE     <dataDir>/live when live update is on (links current and web), else empty
#   HELM_START_PACKAGE  the installed package
#
# So rolling back to (or starting) a build from before the split works with the two units: the runner unit runs it as
# before and owns the port, and the web unit stays down instead of failing to bind it again and again.

set -euo pipefail

part=${1:-all}
live=${HELM_START_LIVE:-}
package=${HELM_START_PACKAGE:?HELM_START_PACKAGE is not set}

# pick LINK: the build a live-update link points at, else the package.
pick() {
  if [ -n "$live" ] && [ -x "$live/$1/bin/helm" ]; then readlink -f "$live/$1"; else echo "$package"; fi
}
split_build() { [ -f "$1/lib/helm/runner.json" ]; }

runner_build="$(pick current)"
case "$part" in
  runner)
    if split_build "$runner_build"; then exec "$runner_build/bin/helm" runner; fi
    echo "helm-start: $runner_build is from before the runner/web split; running it as one process" >&2
    exec "$runner_build/bin/helm"
    ;;
  web)
    if ! split_build "$runner_build"; then
      echo "helm-start: the runner's build ($runner_build) is from before the split and serves the dashboard itself; the web service stays down" >&2
      exit 0
    fi
    # A Helm in one process already serving the port: the runner unit still runs the process from before the system
    # rebuild that switched to two units (a rebuild does not restart it, so agents keep working). Wait for the port:
    # helm-split-adopt.service replaces that process with the runner once no agent is mid-turn (nix/live-update.sh
    # adopt), and then this goes on to start the web service.
    host=${HELM_HOST:-127.0.0.1}
    case "$host" in 0.0.0.0 | ::) host=127.0.0.1 ;; esac
    said=0
    while health="$(curl -s --max-time 3 "http://$host:${HELM_PORT:-4400}/api/health")" && [ -n "$health" ] && ! grep -q '"mode":"web"' <<<"$health"; do
      if [ "$said" = 0 ]; then
        echo "helm-start: Helm in one process is serving port ${HELM_PORT:-4400}; waiting for it to make way for the runner" >&2
        said=1
      fi
      sleep 2
    done
    if [ -n "$live" ] && [ -x "$live/web/bin/helm" ]; then web_build="$(readlink -f "$live/web")"; else web_build=$runner_build; fi
    if ! split_build "$web_build"; then
      echo "helm-start: the web build ($web_build) is from before the split; the web service stays down" >&2
      exit 0
    fi
    exec "$web_build/bin/helm" web
    ;;
  all)
    exec "$runner_build/bin/helm"
    ;;
  *)
    echo "usage: helm-start runner|web|all" >&2
    exit 2
    ;;
esac
