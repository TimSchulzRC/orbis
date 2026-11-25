// The React interface, shared by the web app and the desktop app (platform.ts tells them apart).
import "./theme";

export { App } from "./App";
export { refresh, unsynced } from "./accounts";
export { tr } from "./i18n";
export { notify } from "./ui/toasts";
export { setUpdate, setUpdateCheck } from "./update";
