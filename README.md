# Obtion

Notes that link to each other and projects with tasks, in one app. It runs on your own server (for example a NAS), works in the browser on every device, also offline, and can be used through an AI agent. German and English.

## Running it

GitHub Actions builds the image `ghcr.io/timschulzrc/obtion` (amd64 and arm64) from every push to `main`. On the server you need only [`docker-compose.yaml`](docker-compose.yaml), not the repository:

```bash
mkdir obtion && cd obtion
# copy docker-compose.yaml here (and .env.example as .env, if needed)
docker compose up -d
```

Open `http://<address of the machine>:8480` and create the first account; it becomes the admin. Optional settings go into `.env` (see `.env.example`).

Update with `docker compose pull && docker compose up -d`. Everything lives in the `data` folder; back that up.

While the package on GitHub is private, the server has to log in once: `docker login ghcr.io -u <GitHub user>` with a [personal access token (classic)](https://github.com/settings/tokens/new?scopes=read:packages) that has only the `read:packages` scope as the password.

`latest` is always the newest `main`; every build also keeps a tag `sha-<commit>` to go back to (`OBTION_VERSION` in `.env`). To build the image yourself: `docker build -t ghcr.io/timschulzrc/obtion .`

## Connecting an agent

A workspace's settings show a ready-made MCP command under **Connect an agent**.

## License

[AGPL-3.0-or-later](LICENSE)
