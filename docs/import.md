# Import a folder or Git repository

`obtion import` moves a folder or a Git repository into Obtion so the repository can be retired: every tracked file becomes an item, the Git history goes along, and a report proves that nothing is missing. It is part of the [CLI](cli.md) and talks to a running server, so it works from any machine.

```sh
obtion import ~/repos/ablage --into "Ablage" --config mapping.json --dry-run   # the plan, nothing written
obtion import ~/repos/ablage --into "Ablage" --config mapping.json             # the import
```

`--into` is an item id or an exact title. If nothing has that title, a new pinned item is made as the root. Further options: `--report <file.md>` (where the local report goes), `--tmp <dir>` (scratch space for the bundle), `--no-history`, `--no-bundle`.

## What becomes what

- **Files to import:** in a Git repository the tracked files (`git ls-files`, with the content of the working tree), in a plain folder every file. The ignore list (default `.git/`, `.gitkeep`, `.gitignore`, `.gitattributes`) is skipped, and every skipped file is listed in the report. Symbolic links and submodules are listed as ignored.
- **A folder** becomes an information with the folder's name. Its `README.md` is the folder's text (`readme_as_body`), so a customer folder reads as one page. The repository's own `README.md` is the root's text.
- **A `.md` file** becomes an information titled like the file without `.md`, with the exact text: line endings, a BOM, a front matter of its own, every byte. A `.md` that isn't UTF-8 goes in as a file.
- **Everything else** becomes a file, uploaded over the [file API](files-api.md) and checked against its SHA-256. Up to 512 MB per file.
- **Git LFS:** a file whose working tree still holds the LFS pointer gets its content from the repository's LFS store (`.git/lfs/objects`), checked against the pointer's SHA-256. If the object isn't there, the file fails with a hint (`git lfs fetch` in the repository, then import again).

## Where the repo path lives

Every item keeps its original path as **`source`**: `repo:<name>/<path>`, for example `repo:Ablage/04_Customer_Projects/Germany_ACME/STATUS_2026-10-30.md`. MCP `get` shows it, `search` finds it, so an old note that says "see STATUS_2026-10-30.md §6" stays findable. A re-run finds the item by it.

## Links

Relative Markdown links (`[Status](STATUS_2026-10-30.md#6)`, images too) and mentions of tracked files (`` `sources/schema.xsd` ``, `STATUS_2026-10-30.md` in plain text) become `[[id|label]]` links; the label is the original text, an anchor stays (`[[id#6|Status]]`). A mention resolves as a path relative to the note, from the repository root, as a unique file name, or as a unique tail of a path (`bic/manual.pdf`). Nothing else in the text changes. Left alone: code blocks (fenced or indented), URLs, lines with a `|` (table rows: the `|` of a link would split the cell; existing `[[id|label]]` links), reference definitions, and links of a note to itself. Every rewrite is in the report (original → new), so each text can be turned back; links that resolve to nothing are listed too. `"rewrite_links": false` keeps every text byte for byte.

## The mapping config

A JSON file, all keys optional. Example for a repository shaped like `00_…`, `01_…`, `02_Countries/<nn_Country>`, `04_Customer_Projects/<Country>_<Customer>`, `_tools`: [examples/import-mapping.json](examples/import-mapping.json).

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | folder name | the name in `source` keys and titles |
| `ignore` | `.git/`, `.gitkeep`, `.gitignore`, `.gitattributes` | patterns like `.obtionignore`: `dir/` a folder, `*.log` any base name, `a/*.tmp` a path |
| `readme_as_body` | `true` | a folder's `README.md` is the folder's text |
| `rewrite_links` | `true` | see Links |
| `rules_file`, `rules_title` | –, `Regeln für Agenten` | the note of this repo path (e.g. `CLAUDE.md`) is titled `rules_title`. Once workspaces have their own field for agent rules, this note's text can move there. |
| `history.updates` | `true` | dated updates on folder items whose type has updates |
| `history.notes` | `["*", "*/*"]` | folders (globs) without updates that get a note `Verlauf <title>` |
| `history.refs` | `["--branches", "--tags"]` | which refs count for the history and the bundle; `["--all"]` also takes tool refs such as `refs/t3/…` |
| `bundle` | `true` | a `git bundle` of those refs below the root |
| `lfs` | `true` | older Git LFS versions that aren't among the current files go into `Git-LFS-Archiv` |
| `concurrency` | `4` | parallel uploads |
| `rules` | – | see below |

A rule applies to a folder or file whose repo path matches `path` (a glob) and whose name matches `match` (a regex, optional); the first matching rule wins:

```json
{ "path": "04_Customer_Projects/Germany_*", "match": "^Germany_(.+)$", "title": "{1}", "type": "Projekt", "parent": "Deutschland", "pin": false, "properties": { "Status": "Aktiv" } }
```

- `title`: a template with `{name}` (the base name), `{stem}` (without extension) and `{1}`, `{2}` … (groups of `match`).
- `type`: must exist in the workspace (the import stops before writing anything if it doesn't).
- `parent`: another place instead of the repo's folder: an item id or exact title (made below the root if there is none), or `path:<repo folder>`.
- `properties`: set when the item is made; later runs never touch them.

For a file only `parent` and `pin` apply: a file's title is its name, and files have no type.

## History

- A note **`Git-Verlauf`** at the root: every commit of the chosen refs (newest first) with date, author, the message unchanged in a code block, and the changed paths; on top the list of refs.
- For each folder item whose type has updates: one **update per commit** that changed something below it, dated with the commit's date (MCP `add_update` with `at`), with the message and the changed paths. A folder without updates that matches `history.notes` gets a note **`Verlauf <title>`** instead.
- **`<name>.bundle`** below the root: `git clone <name>.bundle` brings the repository back, with every commit and branch (with Git LFS: `GIT_LFS_SKIP_SMUDGE=1 git clone <name>.bundle`, the LFS files then hold their pointers). Git LFS contents are not in a bundle; they are the imported files themselves (an LFS id is the SHA-256 of the content, the same hash the file has in Obtion), and older LFS versions are in `Git-LFS-Archiv`.

## The report

Written locally (`--report`, default `obtion-import-<name>-<date>.md`) and as the note **`Importbericht <name> <date>`** below the root (a second run on the same day updates it). It has:

- the verdict on top: complete, or how many problems;
- counts per status and per file extension;
- one row per tracked file: path, item id, status, SHA-256 of the original, SHA-256 in Obtion, and the check: for files the server's hash against the original's, for Markdown the text on the server compared byte for byte with what was meant to be written ("Text Byte für Byte gleich" when no link was rewritten);
- history, bundle and LFS archive; rewritten and unresolved links; items whose path the repository no longer has.

Statuses: `imported` (new), `updated` (changed in the repo, written), `unchanged`, `conflict` (changed in Obtion, not overwritten), `ignored`, `failed`. Old LFS versions that aren't on the machine are listed as `unavailable`: they would be lost with the repository, so they count as problems too (as does a repository that uses or once used LFS, on a machine without git-lfs), and so does a folder that could not be made (e.g. a cycle of `path:` parents). **Exit code 1 when anything is `failed`, `conflict` or `unavailable`**, 0 when everything is there.

## Re-runs during a transition period

Keep working in the repository for a while and import again whenever you like. A re-run:

- finds every item by its `source` and never makes a second one, also items below a place outside the root (a rule's `parent`) or moved out of it in Obtion;
- uploads new files, replaces changed ones (only if nobody replaced the file in Obtion since: `If-Match`), writes changed texts (only if the text in Obtion is still the one the last import wrote);
- reports an item edited in Obtion as `conflict` and leaves it alone. Merge by hand, in Obtion or in the repository;
- adds updates for new commits only, rewrites `Git-Verlauf`, replaces the bundle when the refs changed;
- never deletes: files removed from the repository stay in Obtion and are listed in the report;
- never moves: a folder you placed elsewhere in Obtion stays there;
- leaves the report note of the same day alone if someone edited it in Obtion (the local report is written anyway).

What the last import wrote is kept on the server as the file `obtion-import-<name>.json` below the root, so a re-run works from any machine. Don't delete it during the transition period; without it, a text that differs from the repository counts as a conflict.

A run that breaks off (network, a full disk) can simply be started again; it continues where it stopped.

## Checklist for retiring a repository

1. `git status` clean, `git lfs fetch --all` (old LFS versions) and `git lfs pull`.
2. A dry run: `--dry-run`. Check the planned titles and the unresolved links.
3. The import. The report must say "Vollständig".
4. Spot checks: a customer page, a file download (`obtion pull` of a folder gives the originals back), a search for an old file name.
5. A second run: it must report everything as `unchanged`.
