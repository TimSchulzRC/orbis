// first: takes "#addLibrary=…" (a drawing library from libraries.excalidraw.com) out of the address
// before the app's routes see it
import "@obtion/ui/library-link";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@obtion/ui/styles.css";
import { App, refresh } from "@obtion/ui";
import { initUpdates } from "./update";

initUpdates();

void refresh();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
