#!/usr/bin/env bash
# Publish the current tree of a commit to the public repository as ONE new commit on top of the public history.
# The development history (authors, messages, old file contents) is never pushed: only trees are.
#
#   scripts/publish.sh <public-repo-url> [commit, default master] [-m "message"]
#
# Needs two untracked files next to the checkout's .git (they hold what must stay private, so they are not tracked):
#   .publish-identity   two lines: the author name, then the author email (e.g. a GitHub no-reply address)
#   .publish-deny       one extended regular expression per line (case-insensitive); a tree in which any tracked
#                       file matches one is refused
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
url=${1:?public repository url}; shift
rev=master; msg=
while [ $# -gt 0 ]; do
  case $1 in -m) msg=$2; shift 2 ;; *) rev=$1; shift ;; esac
done
[ -s .publish-identity ] || { echo "missing .publish-identity" >&2; exit 1; }
[ -s .publish-deny ] || { echo "missing .publish-deny" >&2; exit 1; }
name=$(sed -n 1p .publish-identity); email=$(sed -n 2p .publish-identity)
commit=$(git rev-parse --verify "$rev^{commit}")
tree=$(git rev-parse "$commit^{tree}")

# Refuse a tree that names anything on the deny list (file contents and file names). package-lock.json is left out:
# its integrity hashes are random letters that match short patterns by chance.
if git grep -n -I -i -E -f .publish-deny "$commit" -- . ':!package-lock.json' >/tmp/publish-deny.$$ 2>/dev/null; then
  echo "refusing to publish: tracked files match .publish-deny:" >&2
  cut -c1-160 /tmp/publish-deny.$$ | head -40 >&2; rm -f /tmp/publish-deny.$$; exit 1
fi
rm -f /tmp/publish-deny.$$
if git ls-tree -r --name-only "$commit" | grep -i -E -f .publish-deny >&2; then
  echo "refusing to publish: file names match .publish-deny" >&2; exit 1
fi

parent=$(git rev-parse -q --verify refs/heads/public || true)
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then echo "nothing new to publish"; exit 0; fi
[ -n "$msg" ] || msg=$([ -n "$parent" ] && echo "Update" || echo "Helm")
new=$(GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email \
  git commit-tree "$tree" ${parent:+-p "$parent"} -m "$msg")
git push "$url" "$new:refs/heads/main"
git update-ref refs/heads/public "$new"
echo "published $(git rev-parse --short "$new") (tree of $(git rev-parse --short "$commit"))"
