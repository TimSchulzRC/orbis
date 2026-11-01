# File API

Scripts and agents move files over plain HTTP. Base URL per workspace:

```
https://<server>/w/<workspace id>/api/files
```

The MCP `get` tool prints the exact URL for a file, and the MCP instructions name the upload URL.

## Authentication

`Authorization: Bearer <token>`, one of:

- the workspace's MCP token (settings › "Connect an agent (MCP)", or `POST /api/workspaces/<id>/mcp-token`). It opens these file routes and `/mcp`, nothing else.
- an app session token.

The token's owner must still be a member of the workspace. A token never goes into the query string. Without a valid token the answer is `401`; a session of someone who isn't a member gets `403`.

## Upload a new file

```sh
curl -fsS -X POST -H "Authorization: Bearer $OBTION_TOKEN" \
  --data-binary @schema.xsd \
  "$BASE?name=schema.xsd&parent=<id or exact title>"
```

- The body is the raw content, streamed to disk. Any file type, up to 512 MB.
- `name` (required): the file name with extension. Folders in it are dropped (`a/b.xsd` becomes `b.xsd`).
- `parent` (optional): an item id or a unique title. Without it the file lands in the inbox.
- `201` with `{ id, name, hash, size, mime, url, step }`. `hash` is the SHA-256 of the content; `url` is the file's address for download and replace; `step` can be undone with the MCP `undo` tool.
- `400` for a missing name or an unknown parent, `413` when too large. Nothing is created then.

## Replace the content of a file

```sh
curl -fsS -X PUT -H "Authorization: Bearer $OBTION_TOKEN" \
  --data-binary @schema.xsd "$BASE/<file id>"
```

Same item, same name, same place and links. The old content stays in the file's history. `200` with `{ id, name, hash, size, mime, url, step, replaced, previous }`; `replaced: false` when the content was already the same. `404` for an id that isn't a file, `409` for a file in the trash.

## Download the original

```sh
curl -fsS -H "Authorization: Bearer $OBTION_TOKEN" -o schema.xsd "$BASE/<file id>"
```

Always a download (`Content-Disposition: attachment` with the file name). Headers: `ETag` and `X-Obtion-Hash` carry the SHA-256, so a script can skip files it already has. `HEAD` gives the headers only.

## Text

The server reads the text of every file it can (PDF incl. embedded Factur-X/ZUGFeRD/XRechnung XML, Word, Excel, PowerPoint, OpenDocument, text and code files in UTF-8, UTF-16 or Windows-1252, HTML as text, a ZIP's list of entries, Outlook `.msg` roughly). It is searchable and shown by MCP `get`, at most 100,000 characters per file. Files from before are read once when the workspace opens.

## Serving in the browser

Only images, PDF, audio, video and plain text are shown inline, always with `X-Content-Type-Options: nosniff` and a sandbox CSP. Everything else, HTML and SVG downloads through this API included, is sent as `application/octet-stream` with `attachment`.
