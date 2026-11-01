// What the app's pages get from the desktop app: window.obtionDesktop (see
// packages/ui/src/platform.ts). Asked synchronously, so it is there before the app's first line.

import type { DesktopBridge } from "@obtion/ui/platform";
import { contextBridge, ipcRenderer } from "electron";

const bridge: DesktopBridge = {
	os: process.platform,
	local: ipcRenderer.sendSync("obtion:local"),
	renewLocal: () => ipcRenderer.invoke("obtion:renew"),
};

contextBridge.exposeInMainWorld("obtionDesktop", bridge);
