# CI

[`ci.yml`](../.github/workflows/ci.yml) runs for every pull request and every push to `main`:

| Job       | What                                                                                                             | When                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `check`   | `bun test`, typecheck, browser tests (`tests/browser`), E2E (`tests/e2e`), side by side                          | always                                 |
| `image`   | builds the image for the runner's platform and starts it ([`check-image.sh`](../.github/scripts/check-image.sh)) | always, beside `check`                 |
| `publish` | builds both platforms and pushes `:dev` and `:sha-<commit>`                                                      | `main` only, after `check` and `image` |

`bun run check` runs the same script locally. Biome runs as `biome ci --error-on-warnings`: a formatting difference, an unsorted import or any lint finding (warnings included) fails the job, and on GitHub each finding shows as an annotation on its line.

A failed browser or E2E test gets one more try; a test that passes only then shows as flaky (Vitest) or with a warning (E2E). It is no bug in the code, most likely a load spike on the runner, but worth a look if it keeps happening.

Tests that start servers as their own processes (`tests/integration/server.test.ts`) get 30 seconds instead of bun's five: beside the other checks a server can take seconds to start, and a test that runs out of time takes all the file's servers with it, so the tests after it fail too.

## Runners

All jobs run on GitHub's runners (`ubuntu-latest`; the desktop app also on `macos-latest` and `windows-latest`). The repository is public, so they cost nothing, and a pull request from a fork must never run its code on a machine of our own: it could change the workflow to pick that machine. Workflows from outside contributors start only after approval (Settings › Actions).
