import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@obtion/ui/styles.css";
import { App, refresh } from "@obtion/ui";
import { initUpdates } from "./update";

// Service worker: a new version waits until the user reloads it from the one notice (update.ts).
initUpdates();

// the workspaces of every account, as the servers know them now (offline: as last known)
void refresh();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
