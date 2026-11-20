#!/usr/bin/env bash
# Decides what release.yml builds and writes it to $GITHUB_OUTPUT (or prints it):
#   skip     true: nothing to do (no build, no release)
#   sha      the commit to build
#   version  0.0.2-nightly.20261030.1 or 0.0.2
#   title    the release's title: Orbis 0.0.2-nightly.20261030.1 or Orbis 0.0.2 (Alpha)
#   tags     the image tags, comma-separated
#   notes    the release the notes start from (the previous one of the channel), may be empty
#
# nightly: the newest main ($SHA). Only when the dev image of that commit exists (ci.yml passed),
#   main has commits the last nightly lacks and, when automatic (schedule or dispatch with auto),
#   the last nightly is at least six hours old. Version: the next stable one, the day and the how-manieth nightly of that day.
# stable: the commit of the latest nightly, so stable only ever ships what ran as nightly. Version:
#   the one that nightly led up to, or $VERSION_INPUT (e.g. 0.1.0 for the beta).
#
# Needs: CHANNEL (nightly | stable), AUTO (true: started by a timer, false: by hand), SHA, GITHUB_REPOSITORY,
# GH_TOKEN; optional VERSION_INPUT. The dev image is looked up with docker (logged in to ghcr.io).
set -euo pipefail

repo=$GITHUB_REPOSITORY
image=ghcr.io/${repo,,}
out=${GITHUB_OUTPUT:-/dev/stdout}
GAP_HOURS=6
# Stable releases keep this stage in their title while Orbis is in it, like T3 Code (Alpha); the
# same word as STABLE_STAGE in packages/core/src/release.ts, which puts it into the app's name.
STABLE_STAGE=Alpha

skip() {
  echo "::notice::$1"
  echo "skip=true" >> "$out"
  exit 0
}
fail() {
  echo "::error::$1"
  exit 1
}

# Releases newest first; a nightly's tag is v<version>-nightly.<date>.<n>
releases=$(gh api --paginate "repos/$repo/releases?per_page=100" --jq '.[] | select(.draft | not) | [.tag_name, .published_at] | @tsv')
last_nightly=$(awk -F'\t' '$1 ~ /-nightly\./ { print; exit }' <<< "$releases")
last_stable=$(awk -F'\t' '$1 ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/ { print $1 }' <<< "$releases" | sort -V | tail -n1)
nightly_tag=${last_nightly%%$'\t'*}
nightly_at=${last_nightly#*$'\t'}
stable_version=${last_stable#v}

if [[ $CHANNEL == nightly ]]; then
  sha=$SHA
  docker buildx imagetools inspect "$image:sha-${sha:0:7}" > /dev/null 2>&1 ||
    if [[ $AUTO == true ]]; then skip "No dev image for ${sha:0:7} yet (CI still running or failed)"; else fail "No dev image for ${sha:0:7}: wait for CI on main"; fi

  if [[ -n $nightly_tag ]]; then
    if [[ $AUTO == true ]] && (($(date -u +%s) - $(date -u -d "$nightly_at" +%s) < GAP_HOURS * 3600)); then
      skip "$nightly_tag is less than $GAP_HOURS hours old"
    fi
    status=$(gh api "repos/$repo/compare/$nightly_tag...$sha" --jq .status)
    [[ $status == ahead ]] || skip "Nothing new since $nightly_tag ($status)"
  fi

  IFS=. read -r major minor patch <<< "${stable_version:-0.0.0}"
  next=$major.$minor.$((patch + 1))
  day=$(date -u +%Y%m%d)
  n=$(($(cut -f1 <<< "$releases" | grep -c -- "-nightly\.$day\." || true) + 1))
  version=$next-nightly.$day.$n
  title="Orbis $version"
  tags=$image:nightly,$image:$version
  notes=$nightly_tag
else
  [[ -n $nightly_tag ]] || fail "No nightly yet: stable builds the commit of the latest nightly"
  sha=$(gh api "repos/$repo/commits/$nightly_tag" --jq .sha)
  version=${VERSION_INPUT:-}
  version=${version#v}
  if [[ -z $version ]]; then
    [[ $nightly_tag =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-nightly\. ]] || fail "Cannot read a version from $nightly_tag"
    version=${BASH_REMATCH[1]}
  fi
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid version $version (expected e.g. 0.1.0)"
  if [[ -n $stable_version ]]; then
    [[ $(printf '%s\n%s\n' "$stable_version" "$version" | sort -V | tail -n1) == "$version" && $version != "$stable_version" ]] ||
      fail "$version is not newer than the latest stable $stable_version"
    [[ $(gh api "repos/$repo/commits/v$stable_version" --jq .sha) != "$sha" ]] ||
      fail "$nightly_tag is already stable as v$stable_version"
  fi
  title="Orbis $version ($STABLE_STAGE)"
  tags=$image:stable,$image:latest,$image:$version
  notes=${last_stable}
fi

echo "::notice::$CHANNEL $title from ${sha:0:7}"
{
  echo "skip=false"
  echo "sha=$sha"
  echo "version=$version"
  echo "title=$title"
  echo "tags=$tags"
  echo "notes=$notes"
} >> "$out"
