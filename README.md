# Obtion

Notes that link to each other and projects with tasks, in one app. It runs on your own server (for example a NAS), works in the browser on every device, also offline, and can be used through an AI agent. German and English.

## Running it

```bash
git clone <repository> obtion && cd obtion
mkdir data
docker compose up -d
```

Open `http://<address of the machine>:8480` and create the first account; it becomes the admin. Optional settings go into `.env` (see `.env.example`).

Update with `git pull && docker compose up -d --build`. Everything lives in the `data` folder; back that up.

## Connecting an agent

A workspace's settings show a ready-made MCP command under **Connect an agent**.

## License

[AGPL-3.0-or-later](LICENSE)
