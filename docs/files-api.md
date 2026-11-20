# File API

Scripts and agents move files over plain HTTP. Base URL per workspace:

```
https://<server>/w/<workspace id>/api/files
```

The MCP `get` tool prints the exact URL for a file, and the MCP instructions name the upload URL.

## Authentication

`Authorization: Bearer <token>`, one of:

- the workspace's MCP token (settings › "Connect an agent (MCP)", or `POST /api/workspaces/<id>/mcp-token`). It opens these file routes and `/mcp` of its own workspace, nothing else. Each member has one per workspace: a new one ends the previous one at once, `DELETE /api/workspaces/<id>/mcp-token` ends it without a new one.
- an app session token.

The token's owner must still be a member of the workspace. A token never goes into the query string, and the server ignores one there. Requests without the header get no CORS headers, and cookies count for nothing. Without a valid token the answer is `401`; a session of someone who isn't a member gets `403`.

## Upload a new file

```sh
curl -fsS -X POST -H "Authorization: Bearer $ORBIS_TOKEN" \
  --data-binary @schema.xsd \
  "$BASE?name=schema.xsd&parent=<id or exact title>"
```

> Always pass `parent`. A file uploaded without it sits in the inbox, and from there an agent can only suggest a place.

- The body is the raw content, streamed to disk. Any file type, up to 512 MB.
- `name` (required): the file name with extension. Folders in it are dropped (`a/b.xsd` becomes `b.xsd`).
- `parent`: an item id or a unique title. Formally optional, but always give it when an agent or script transfers files. Without it the file lands in the inbox, and agents may not sort the inbox: afterwards they can only `suggest` a place, which a person has to accept in the app. With the MCP token there is no way to move the file out of the inbox.
- `201` with `{ id, name, hash, size, mime, url, step }`. `hash` is the SHA-256 of the content; `url` is the file's address for download and replace; `step` can be undone with the MCP `undo` tool.
- `400` for a missing name or an unknown parent, `413` when too large. Nothing is created then.

## Replace the content of a file

```sh
curl -fsS -X PUT -H "Authorization: Bearer $ORBIS_TOKEN" \
  --data-binary @schema.xsd "$BASE/<file id>"
```

Same item, same name, same place and links. The old content stays in the file's history. `200` with `{ id, name, hash, size, mime, url, step, replaced, previous }`; `replaced: false` when the content was already the same. `404` for an id that isn't a file, `409` for a file in the trash.

## Download the original

```sh
curl -fsS -H "Authorization: Bearer $ORBIS_TOKEN" -o schema.xsd "$BASE/<file id>"
```

Always a download (`Content-Disposition: attachment` with the file name). Headers: `ETag` and `X-Orbis-Hash` carry the SHA-256, so a script can skip files it already has. `HEAD` gives the headers only.

## Text

The server reads the text of every file it can (PDF incl. embedded Factur-X/ZUGFeRD/XRechnung XML, Word, Excel, PowerPoint, OpenDocument, text and code files in UTF-8, UTF-16 or Windows-1252, HTML as text, a ZIP's list of entries, Outlook `.msg` roughly). It is searchable and shown by MCP `get`, at most 100,000 characters per file. The whole text stays on the server beside the content; the file's facts, which sync to every device, carry only its first 4,000 characters (preview and offline search). The app loads the rest on the file's page.

## Serving in the browser

No URL opens a file without a token, see Authentication. The app loads images, PDFs, audio and video with the header and shows them from `blob:` URLs on the device. Audio and video therefore load whole before they play.

Only images, PDF, audio, video and plain text are shown inline, always with `X-Content-Type-Options: nosniff` and a sandbox CSP. Everything else, HTML and SVG downloads through this API included, is sent as `application/octet-stream` with `attachment`.
