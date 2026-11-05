// Audio and video embedded in a text: from this device, or loaded with the token in the header and
// played from a blob: URL. Never a server URL in src, since no URL may open a content without a token.
import { expect, test, vi } from "vitest";
import type { DeviceFiles } from "../../packages/ui/src/files";
import { hydrateFiles } from "../../packages/ui/src/ui/Markdown";

function fakeFiles() {
  const url = vi.fn(async (h: string) => `blob:geladen-${h}`);
  const files = { url, isMissing: () => false } as unknown as DeviceFiles;
  return { files, url };
}

function embed(tag: "audio" | "video") {
  const root = document.createElement("div");
  root.innerHTML = `<figure class="embed-av"><${tag} controls preload="none" data-hash="abc" class="embed-media"></${tag}></figure>`;
  return { root, el: root.querySelector(tag)! };
}

test.each(["audio", "video"] as const)("%s plays from a blob: URL, never from a server URL", async (tag) => {
  const { files, url } = fakeFiles();
  const { root, el } = embed(tag);
  hydrateFiles(root, files);
  await expect.poll(() => el.getAttribute("src")).toBe("blob:geladen-abc");
  expect(url).toHaveBeenCalledWith("abc", { keep: false });
});
