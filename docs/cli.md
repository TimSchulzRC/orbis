# CLI: a part of Obtion as a local folder

`obtion` mirrors an item and everything below it into a folder on your disk. You or an agent work there with ordinary tools (an editor, Python, PowerShell, Eclipse, the SEEBURGER BIS designer), and `obtion push` sends the changes back. It talks to a running server over MCP and the [file API](files-api.md), so it works from any machine that reaches the server.

## Install

The CLI is a Bun program in `apps/cli`.

- **With Bun** (Linux, macOS, Windows): `bun apps/cli/src/index.ts <command>` from a checkout, or `bun run obtion <command>` in its root. An alias saves typing: `alias obtion="bun ~/obtion/apps/cli/src/index.ts"` (PowerShell: `function obtion { bun $HOME\obtion\apps\cli\src\index.ts @args }`).
- **Without Bun**: `bun run build:cli` builds single-file programs in `dist/cli/`: `obtion-linux-x64`, `obtion-linux-arm64`, `obtion-darwin-x64`, `obtion-darwin-arm64`, `obtion-windows-x64.exe`. Copy the one for the machine into the `PATH` as `obtion` (`obtion.exe`). `bun apps/cli/build.ts bun-windows-x64` builds just one. On macOS an unsigned program needs `xattr -d com.apple.quarantine obtion` once.

## Log in

Create an MCP token in Obtion (settings › "Connect an agent (MCP)"); it belongs to one workspace. The workspace id is in the app's address (`/w/<id>`).

```sh
echo "$TOKEN" | obtion login https://obtion.example.org --workspace <id>
```

The token comes from stdin or `OBTION_TOKEN`, never from the command line (it would end up in the shell history). The CLI checks it against the server and stores server, workspace and token in

| System  | File                                              |
| ------- | ------------------------------------------------- |
| Linux   | `$XDG_CONFIG_HOME/obtion/config.json` (`~/.config/obtion/config.json`) |
| macOS   | `~/Library/Application Support/obtion/config.json` |
| Windows | `%APPDATA%\obtion\config.json`                      |

with mode 0600 in a 0700 folder (on Windows the profile's permissions protect it). `OBTION_SERVER`, `OBTION_WORKSPACE` and `OBTION_TOKEN` override the file, `OBTION_CONFIG` names another file: handy for agents and CI.

## Pull

```sh
obtion pull "Kunde A" ~/work/kunde-a     # an id or an exact title
cd ~/work/kunde-a
obtion pull                              # later: bring it up to date
```

What lands where:

- An item with children is a folder. If it is an information, its own text is the folder's `README.md`.
- An information without children is `<title>.md`.
- A file is its original under its own name, checked against the SHA-256 the server has.
- An item with several parents appears once: below its home if that is part of the pulled tree, else below its first parent there.
- Names work on Windows, macOS and Linux: `< > : " / \ | ? *` and control characters become `_`, reserved names (`CON`, `NUL`, `COM1` …) get a `_` in front, trailing dots and spaces go, names are cut at 120 characters. Two items with the same name in one folder (also differing only in case): the older keeps the name, the next is `Name (2)`.

A note starts with a small block of our own, then the body exactly as Obtion stores it (line endings, a front matter of its own, every byte):

```markdown
---
obtion_id: 0mvyenr3suqzi7b6j
obtion_version: aa348e1fa45f
type: Projekt
Status: "In Arbeit"
---
The body …
```

The block is for reading. Edits in it are not sent; change type and properties in Obtion or over MCP.

`.obtion/state.json` records what each path was at the last pull or push: the id, the version, the SHA-256 of the body or file. That is how the CLI tells your edits from changes in Obtion. A pull never overwrites a local edit:

- changed here only: kept, reported as `kept`.
- changed here and in Obtion: kept, reported as `conflict` (exit code 1). `pull --force` replaces it with Obtion's version and keeps yours as `<name>.obtion-conflict.<ext>`.
- deleted here: stays deleted (`pull --force` restores it).
- renamed or moved in Obtion: the file moves along, unless you changed it.
- removed in Obtion: the local file goes, unless you changed it.
- a file that was already there before the first pull: never overwritten. If it differs, it counts as a local edit of that item.

## Status

```sh
obtion status            # local changes and changes in Obtion since the last pull
obtion status --local    # only the local side, without the server
```

## Push

```sh
obtion push --dry-run    # what would be sent
obtion push
obtion push --delete     # also send deletions
```

- An edited note or README.md: `update` with the version from the last pull as `base_version`. If someone changed the text in Obtion since, nothing is sent for it: your file stays, Obtion's text lands next to it as `<name>.obtion-conflict.md`, and push exits with 1. Merge what you need into your file, delete the copy, push again. As long as the copy is there, push refuses that file. (If only title or properties changed in Obtion, your text goes up without a conflict.)
- A changed file: replaced over the file API (same item, the old content stays in its history), unless it was replaced in Obtion too; then the same conflict copy, with Obtion's original.
- A new `.md`: a new information, title from the file name, placed below the folder's item. A new `README.md` in a folder becomes the text of the folder's item.
- A new folder with files: a new item (its `README.md` its text), the files below it. A folder `X/` next to a note `X.md` goes below that note instead. Empty folders stay local.
- A new file: uploaded below the folder's item, the server's SHA-256 checked against the local one.
- Deleted here: only with `--delete`, then the items go to the trash (restorable), and only if they didn't change in Obtion since your pull. A deleted `README.md` empties the folder's text.
- Moved or renamed here: not sent. Move or rename in Obtion; the next pull follows.

Never sent: `.obtion/`, `.git/`, conflict copies, `.DS_Store`, `Thumbs.db`, `desktop.ini`, Office lock files (`~$*`), `__pycache__/`, `*.pyc`. More patterns go into `.obtionignore` in the folder, one per line (`build/` a folder, `*.log` any base name, `out/*.jar` a path).

Exit codes: 0 done, 1 conflicts or failures (each listed), 2 wrong use or an error before anything was done.

## For agents: `_tools` and mapping projects

An agent that runs scripts or edits a SEEBURGER BIS mapping project needs the files as files. Give it a pulled folder:

```sh
obtion pull "_tools" ~/work/tools
python ~/work/tools/convert.py input.xml       # tools run where they are
obtion pull "Kunde A Mapping" ~/work/mapping   # an Eclipse project: .project, .classpath, *.seemap …
# edit, build, test locally
obtion status && obtion push
```

Rules that keep it safe:

- `obtion pull` before you start, `obtion status` before `obtion push`.
- Exit code 1 after push: read the `conflict` lines, merge the `.obtion-conflict` copy, delete it, push again. Never delete a conflict copy without merging.
- Outputs a tool writes into the folder are pushed as new files. Put them outside the folder, or list them in `.obtionignore`.
- Prefer MCP for small text edits in Obtion (`update` with `old_text`/`new_text`); use the folder for files and for work that needs local tools.
