// Audio and video embedded in a text: streamed from the server when the original is not on this
// device, never loaded whole into memory first; from this device when it is.
import { expect, test, vi } from "vitest";
import type { DeviceFiles } from "../../packages/ui/src/files";
import { hydrateFiles } from "../../packages/ui/src/ui/Markdown";

/** `local`: whether the original is here, answered once the storage is open (`opened`). */
function fakeFiles(local: boolean, opened: Promise<void> = Promise.resolve()) {
  const url = vi.fn(async (h: string) => `blob:local-${h}`);
  const files = { isLocal: async () => (await opened, local), serverUrl: (h: string) => `https://server.test/api/blobs/${h}?t=x`, url, isMissing: () => false } as unknown as DeviceFiles;
  return { files, url };
}

function embed(tag: "audio" | "video") {
  const root = document.createElement("div");
  root.innerHTML = `<figure class="embed-av"><${tag} controls preload="none" data-hash="abc" class="embed-media"></${tag}></figure>`;
  return { root, el: root.querySelector(tag)! };
}

test.each(["audio", "video"] as const)("%s not on this device: streams from the server", async (tag) => {
  const { files, url } = fakeFiles(false);
  const { root, el } = embed(tag);
  hydrateFiles(root, files);
  await expect.poll(() => el.getAttribute("src")).toBe("https://server.test/api/blobs/abc?t=x");
  expect(url).not.toHaveBeenCalled();
});

test("video on this device: played from here", async () => {
  const { files, url } = fakeFiles(true);
  const { root, el } = embed("video");
  hydrateFiles(root, files);
  await expect.poll(() => el.getAttribute("src")).toBe("blob:local-abc");
  expect(url).toHaveBeenCalledWith("abc");
});

test("video on this device, the storage here still opening: waits and plays from here", async () => {
  let open!: () => void;
  const { files, url } = fakeFiles(true, new Promise((r) => (open = r)));
  const { root, el } = embed("video");
  hydrateFiles(root, files);
  await new Promise((r) => setTimeout(r, 50));
  expect(el.getAttribute("src")).toBeNull();
  open();
  await expect.poll(() => el.getAttribute("src")).toBe("blob:local-abc");
  expect(url).toHaveBeenCalledWith("abc");
});
