# Releasing

How the [release channels](../README.md#release-channels) come about. One image, `ghcr.io/timschulzrc/obtion`, with a tag per channel:

| Channel | Made by                                                                                                 | Tags                                  | GitHub release                          |
| ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------- |
| Dev     | [CI](../.github/workflows/ci.yml), every push to `main` after the checks (tests, browser and E2E tests) | `dev`, `sha-<commit>`                 | none                                    |
| Nightly | [Release](../.github/workflows/release.yml), automatically when due or by hand                          | `nightly`, `0.0.2-nightly.20261030.1` | pre-release `v0.0.2-nightly.20261030.1` |
| Stable  | [Release](../.github/workflows/release.yml), only by hand                                               | `stable`, `latest`, `0.0.2`           | release `v0.0.2`                        |

Nightly and stable are built again from the same commit, only to carry their version; the base images in the `Dockerfile` are pinned to a digest so nothing else differs.
Every image is started once before it is pushed and has to answer with its version ([`check-image.sh`](../.github/scripts/check-image.sh)). Dependabot proposes newer base images, Bun dependencies and actions daily, so everything stays on the latest stable release. What the workflow builds is decided by [`resolve-release.sh`](../.github/scripts/resolve-release.sh).

## Nightly

A nightly builds the newest `main`, and only a commit that already has a dev image (its CI passed).

- **Automatically** every half hour: a new nightly when the last one is at least six hours old and `main` has commits it lacks. Otherwise the run ends without building.
- **By hand**: Actions → Release → _Run workflow_, channel `nightly`. No six-hour wait; it still needs new commits.

The version is the next stable one, the day (UTC) and the how-manieth nightly of that day: after `0.0.1` come `0.0.2-nightly.20261031.1`, `…20261031.2`, and so on.

### The automatic check

The workflow has a GitHub schedule (`8,38 * * * *`), but for this repository GitHub drops most of its runs without a trace. So the machine with the self-hosted runner starts the check as well, with `workflow_dispatch` and `auto=true` (which makes it wait the six hours like the schedule). The user timer is in [`scripts/systemd`](../scripts/systemd):

```bash
cp scripts/systemd/obtion-nightly-check.* ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now obtion-nightly-check.timer
```

It needs `gh`, logged in with the `workflow` scope, and user lingering (`loginctl enable-linger`) to run without a login. Its runs: `journalctl --user -u obtion-nightly-check`.

## Stable

Actions → Release → _Run workflow_, channel `stable`. It builds the commit of the latest nightly, so stable only ever ships what ran as nightly, and takes the version that nightly led up to (`0.0.2-nightly.…` becomes `0.0.2`).

For a new middle number, enter it as `version`, e.g. `0.1.0` for the beta. The next nightlies then lead up to `0.1.1`.

The workflow refuses a version that is not newer than the latest stable one, and a nightly that is already stable.

## Going back

Every version keeps its tag, so a server can go back with `OBTION_VERSION=<version>`. There is no hotfix for stable alone: a fix goes through `main`, a nightly and then stable, with everything merged in between.
