import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@obtion/ui/styles.css";
import { App, files, repo } from "@obtion/ui";
import { initUpdates } from "./update";

// Development only: lets tests drive the replica from the browser console.
if (import.meta.env.DEV) Object.assign(window, { obtion: { repo, files } });

// Service worker: a new version waits until the user reloads it from the one notice (update.ts).
initUpdates();

repo.init().catch((e) => {
  console.error(e);
  document.getElementById("root")!.textContent = `Could not open local storage: ${e?.message ?? e}`;
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
