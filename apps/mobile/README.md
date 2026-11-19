# Obtion for iPhone

A native iPhone app (Expo, React Native) for an Obtion server: the iOS tab bar, navigation bars, menus and sheets, so iOS 26 and later draw them in Liquid Glass. Every workspace of each account is a full copy on the phone (the same `@obtion/sync` replica as in the browser, stored in SQLite), so the app opens and edits offline and syncs when the server is back.

What it does:

- **Home**: what is due, what runs, what changed last
- **Inbox**: everything not sorted yet; a long press gives a type, puts it somewhere, brings it back tomorrow, pins or deletes it
- **Browse**: a workspace's pinned pages and types, each type as a list grouped by status
- **Search**: full text, in the tab bar's search field
- **Workspaces**: the switcher at the top left of each tab shows all workspaces or one of them, the same choice on every tab; its menu also starts a new workspace
- **Pages**: path, title, properties with native pickers, the text as Markdown (checkboxes tick, `[[links]]` open, query blocks list their entries), below, updates, links to it; the pencil edits the text
- **New note** and **new update** as sheets; **Settings** with each server, its account and the sync state of its workspaces, a new workspace on a server of your choice and another server to connect

## Server

Any Obtion server works as it is, and several at once, as in the desktop app: one account per server, with all its workspaces next to the others. Signing out of a server removes its workspaces from the phone. The app sends no `Origin` header and no cookies: the server takes such a request like one from its own page. The token goes in the `Authorization` header, on the WebSocket as the subprotocol, as in the browser. Sign in with email and password or with a code by email; passkeys and OAuth stay with the server's own web page.

## Run it

On a Mac with Xcode and CocoaPods 1.16 or newer (`brew install cocoapods`):

```bash
cd apps/mobile
bun install
npx expo run:ios                 # the simulator, with Metro for live reload
```

`npx expo run:ios` writes the native project to `ios/` (not in git) from `app.config.ts`. Once `ios/` exists it is not written again: after a change to `app.config.ts`, run `npx expo prebuild --platform ios` first.

With Xcode 27, `expo run:ios` may end with "Simulator app did not open fast enough" after it installed the app, and take Metro down with it. The app is installed: start Metro on its own (`npx expo start`), build with `--no-bundler`, and launch the app from the simulator or with `xcrun simctl launch booted app.obtion.mobile`.

### On your iPhone

1. Xcode → Settings → Accounts: add your Apple ID. A free Personal Team is enough; its apps run for 7 days, then install again.
2. Connect the iPhone by cable and trust the Mac. Turn on Developer Mode on the phone (Settings → Privacy & Security → Developer Mode).
3. Build and install a release build, which carries its JavaScript and runs without the Mac:

   ```bash
   OBTION_IOS_BUNDLE_ID=com.yourname.obtion OBTION_IOS_TEAM=<team id> \
     npx expo run:ios --device --configuration Release
   ```

   The bundle id must be one your team may use; with a Personal Team any unused reverse-domain name works. The team id is in Xcode → Settings → Accounts, or open `ios/Obtion.xcworkspace` and choose the team under Signing & Capabilities instead.
4. With a Personal Team, trust it once on the phone: Settings → General → VPN & Device Management.

## Code

- `src/app`: the screens (Expo Router). `(tabs)` holds the four tabs; entry and type pages are shared by all of them, so the tab bar stays.
- `src/lib`: the accounts and their replicas (`session.ts`), the SQLite storage (`storage.ts`), HTTP (`api.ts`), languages (`i18n.ts`, German or English like the phone).
- `src/ui`: lists, rows, properties, the Markdown view.
- `@obtion/core` and `@obtion/sync` come straight from `packages/` (see `metro.config.js`); the texts are the shared ones in `packages/core/locales`, the app's own under `mobile.*`.

The app has its own dependencies and lockfile: React Native pins its own React, so it is not part of the repository's Bun workspace. Checks: `bun run typecheck` here; Biome runs from the repository root. The icons come from `docs/design` with `bun scripts/generate-mobile-icons.ts`.
