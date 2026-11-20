// What the app's pages get from the desktop app: window.orbisDesktop (see
// packages/ui/src/platform.ts). Asked synchronously, so it is there before the app's first line.

import type { DesktopBridge } from "@orbis/ui/platform";
import { contextBridge, ipcRenderer } from "electron";

const bridge: DesktopBridge = {
	os: process.platform,
	local: ipcRenderer.sendSync("orbis:local"),
	renewLocal: () => ipcRenderer.invoke("orbis:renew"),
	theme: (choice) => ipcRenderer.send("orbis:theme", choice),
	checkUpdate: () => ipcRenderer.invoke("orbis:update"),
};

contextBridge.exposeInMainWorld("orbisDesktop", bridge);
