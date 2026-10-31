#!/usr/bin/env bash
# Starts a built image the way a server does (entrypoint, empty /data) and fails unless it answers:
# /api/info with the expected version and commit, the web app at /. Catches what a build alone
# misses: a broken entrypoint, a module missing from the production install, a missing dist.
#   check-image.sh <image> <version> <commit>
set -euo pipefail
image=$1 version=$2 commit=$3
name=obtion-check-$$
trap 'docker rm -f -v "$name" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$name" -p 127.0.0.1::8480 "$image" >/dev/null
port=$(docker port "$name" 8480/tcp | head -1 | cut -d: -f2)
url=http://127.0.0.1:$port

fail() {
  echo "::error::$1"
  echo "::group::container log"
  docker logs "$name" 2>&1 || true
  echo "::endgroup::"
  exit 1
}

for _ in $(seq 60); do
  info=$(curl -fsS "$url/api/info" 2>/dev/null) && break
  [[ $(docker inspect -f '{{.State.Running}}' "$name") == true ]] || fail "the container stopped"
  sleep 1
done
[[ -n ${info:-} ]] || fail "no answer from /api/info within 60 s"
echo "/api/info: $info"
# plain text matching: the runners need nothing beyond Docker and curl
for want in "\"firstAccount\":true" "\"version\":\"$version\"" "\"commit\":\"$commit\""; do
  [[ $info == *"$want"* ]] || fail "/api/info should show version $version, commit $commit and no account yet"
done
curl -fsS "$url/" | grep -qi '<div id="root"' || fail "/ does not serve the web app"
echo "image $image ok"
