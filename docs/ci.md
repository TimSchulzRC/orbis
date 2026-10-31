# CI

[`ci.yml`](../.github/workflows/ci.yml) runs for every pull request and every push to `main`:

| Job | What | When |
|---|---|---|
| `check` | `bun test`, typecheck, browser tests (`tests/browser`), E2E (`tests/e2e`), side by side | always |
| `image` | builds the image for the runner's platform and starts it ([`check-image.sh`](../.github/scripts/check-image.sh)) | always, beside `check` |
| `publish` | builds both platforms and pushes `:dev` and `:sha-<commit>` | `main` only, after `check` and `image` |

A failed browser or E2E test gets one more try; a test that passes only then shows as flaky (Vitest) or with a warning (E2E). It is no bug in the code, most likely a load spike on the machine, but worth a look if it keeps happening.

## Runners

With the repository variable `RUNNER=obtion`, all jobs run on the self-hosted machine; without it on GitHub's runners. The machine has two runners, so two jobs run at once (`check` beside `image`, or two pull requests):

| Runner | Folder | User service |
|---|---|---|
| `homeserver` | `~/actions-runner` | `github-runner-obtion` |
| `homeserver-2` | `~/actions-runner-2` | `github-runner-obtion-2` |

Bun is not installed per job there: the machine has it and `bun upgrade` keeps it on the newest release.

Another runner on the same machine: copy the runner folder without its registration, register it with the label `obtion`, and start it like the others.

```bash
mkdir ~/actions-runner-3 && (cd ~/actions-runner && tar --exclude=./_work --exclude=./_diag --exclude=./.runner --exclude='./.credentials*' --exclude=./.env --exclude=./.path -cf - .) | tar -xf - -C ~/actions-runner-3
cd ~/actions-runner-3 && ./config.sh --unattended --url https://github.com/TimSchulzRC/obtion --name homeserver-3 --labels obtion \
  --token "$(gh api -X POST repos/TimSchulzRC/obtion/actions/runners/registration-token -q .token)"
sed 's/actions-runner/actions-runner-3/g' ~/.config/systemd/user/github-runner-obtion.service > ~/.config/systemd/user/github-runner-obtion-3.service
systemctl --user daemon-reload && systemctl --user enable --now github-runner-obtion-3
```

Each runner runs one job at a time; on four cores more than two mostly make each job slower.
