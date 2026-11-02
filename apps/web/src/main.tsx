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
