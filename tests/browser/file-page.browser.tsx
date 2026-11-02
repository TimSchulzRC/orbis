// The file page: a text or code file shows its content (monospace), an Office file the text the
// server took out, HTML only as text – never rendered; every file has its download.
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { Repo } from "@obtion/sync";
import { type FileMeta, initItem, newId, setFileMeta } from "@obtion/core/model";
import { FilePage } from "../../packages/ui/src/views/FilePage";
import { type DeviceFiles, setFiles } from "../../packages/ui/src/files";
import { workspace } from "./workspace";

afterEach(() => cleanup());

/** Contents only on the server: links point there, nothing is on this device. */
const serverFiles = {
  subscribe: () => () => {},
  getVersion: () => 0,
  isMissing: () => false,
  hasLocal: () => false,
  check: async () => {},
  url: async () => undefined,
  localUrl: async () => undefined,
  missingKey: () => "file.missing",
  serverUrl: (hash: string, name?: string, download = false) => `https://server.test/api/blobs/${hash}?name=${name ?? ""}${download ? "&download=1" : ""}`,
} as unknown as DeviceFiles;

async function show(meta: Partial<FileMeta> & { name: string }) {
  const repo: Repo = await workspace(false);
  setFiles(serverFiles);
  const id = newId();
  repo.change(id, (doc) => {
    initItem(doc, { kind: "datei", title: meta.name });
    setFileMeta(doc, { hash: "a".repeat(64), mime: "application/octet-stream", filetype: "sonstiges", size: 10, ...meta });
  });
  await Promise.resolve(); // the replica reads changed documents in a microtask
  await render(<FilePage item={repo.index().get(id)!} />);
}

const download = () => page.getByRole("link", { name: "Herunterladen" });

test("a code file: its content in monospace, scrollable, with the download", async () => {
  await show({ name: "schema.xsd", text: '<xs:schema>\n  <xs:element name="Beispiel"/>\n</xs:schema>', extracted: "x" });
  await expect.element(page.getByText("Inhalt", { exact: true })).toBeVisible();
  const pre = page.getByTestId("file-text");
  await expect.element(pre).toBeVisible();
  expect(pre.element().textContent).toContain('<xs:element name="Beispiel"/>');
  expect(pre.element().className).toContain("font-mono");
  expect(getComputedStyle(pre.element()).overflowY).toBe("auto");
  await expect.element(download()).toHaveAttribute("href", expect.stringContaining("download=1"));
});

test("a Word file: the extracted text", async () => {
  await show({ name: "Konzept.docx", filetype: "dokument", text: "Ablauf der Freigabe\nFeld\tQuelle", extracted: "x" });
  await expect.element(page.getByText("Erkannter Text", { exact: true })).toBeVisible();
  await expect.element(page.getByTestId("file-text")).toBeVisible();
  expect(page.getByTestId("file-text").element().textContent).toBe("Ablauf der Freigabe\nFeld\tQuelle");
  expect(page.getByTestId("file-text").element().className).toContain("font-sans");
});

test("HTML only as its text: no markup is rendered", async () => {
  await show({ name: "seite.html", text: "Kopf\nA & B", extracted: "x" });
  await expect.element(page.getByTestId("file-text")).toBeVisible();
  expect(page.getByTestId("file-text").element().textContent).toBe("Kopf\nA & B");
  expect(document.querySelector("main iframe, [data-testid=file-text] h1, [data-testid=file-text] script")).toBeNull();
});

test("a binary file: no preview, but the download", async () => {
  await show({ name: "lib.jar", extracted: "x" });
  await expect.element(page.getByText("Für diesen Dateityp gibt es keine Vorschau", { exact: false })).toBeVisible();
  await expect.element(download()).toBeVisible();
});

test("a file the server has not read yet says so", async () => {
  await show({ name: "neu.txt" });
  await expect.element(page.getByText("Der Server liest den Text dieser Datei gerade noch.")).toBeVisible();
});

test("long text cut on the server says so", async () => {
  await show({ name: "gross.csv", text: "a;b\nc;d\n…", extracted: "x" });
  await expect.element(page.getByText("Gekürzt – der ganze Inhalt steckt im Download.")).toBeVisible();
  expect(page.getByTestId("file-text").element().textContent).toBe("a;b\nc;d");
});
