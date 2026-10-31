import { Marked, type Tokens } from "marked";
import { useEffect, useMemo, useRef } from "react";
import { fmtBytes } from "@obtion/core/i18n";
import { type Item, wikiLinkRe } from "@obtion/core/model";
import { openLightbox } from "./Lightbox";
import { repo } from "../repo";
import { itemPath, spaceHref, useFiles, useRepo, useSpaceId } from "../hooks";
import { type DeviceFiles, files as current } from "../files";
import type { Repo } from "@obtion/sync";
import { getLang, tr } from "../i18n";
import { escapeHtml } from "./text";

const WIKILINK_AT_START = wikiLinkRe(true);

/** A [[link]] or ![[embed]] (`alias`: the text after |, for files a width). */
interface WikiToken extends Tokens.Generic {
  type: "wikilink";
  raw: string;
  embed: boolean;
  target: string;
  alias?: string;
}

const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    // Never render raw HTML from notes or agent output.
    html: (t) => escapeHtml(t.text),
    link(t) {
      const text = this.parser.parseInline(t.tokens);
      const internal = t.href.startsWith("#");
      if (!internal) {
        let proto = "";
        try {
          proto = new URL(t.href, location.href).protocol;
        } catch {
          return text;
        }
        if (!["http:", "https:", "mailto:"].includes(proto)) return text;
      }
      return `<a href="${escapeHtml(t.href)}"${internal ? "" : ' target="_blank" rel="noopener"'}>${text}</a>`;
    },
  },
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start: (src: string) => src.match(/!?\[\[/)?.index,
      tokenizer(src: string): WikiToken | undefined {
        const m = WIKILINK_AT_START.exec(src);
        if (!m) return undefined;
        return { type: "wikilink", raw: m[0], embed: m[1] === "!", target: m[2]!.trim(), alias: m[4]?.slice(1) };
      },
      renderer(token) {
        const t = token as WikiToken; // made by the tokenizer above
        const r = rendering ?? repo;
        const id = r.resolveTitle(t.target);
        const item = id ? r.get(id) : undefined;
        const f = item?.file;
        const size = t.alias && /^\d+$/.test(t.alias) ? Number(t.alias) : undefined;
        if (f && t.embed) return embedHTML(item!, size, renderingSpace);
        if (f) return `<a class="file-chip" href="${spaceHref(renderingSpace, itemPath(id!))}">📎 ${escapeHtml(t.alias || item!.title)} <small>${fmtBytes(getLang(), f.size)}</small></a>`;
        const label = escapeHtml(t.alias || t.target);
        return id
          ? `<a class="wikilink" href="${spaceHref(renderingSpace, itemPath(id))}">${label}</a>`
          : `<a class="wikilink missing" href="${spaceHref(renderingSpace, `/create?title=${encodeURIComponent(t.target)}`)}" title="${escapeHtml(tr("link.missing"))}">${label}</a>`;
      },
    },
  ],
});

/**
 * An embedded file, the same in read-only text and in the editor: an image with its description
 * as alt text and caption, audio and video as a player, anything else (PDF …) as a card with
 * its first page. `space`: the workspace of the text, so its links open there (in a new tab too).
 */
export function embedHTML(item: Item, size?: number, space?: string): string {
  const href = spaceHref(space, itemPath(item.id));
  const f = item.file!;
  if (f.filetype === "bild")
    return `<figure class="embed-img"><img data-hash="${f.display ?? f.hash}" data-id="${escapeHtml(item.id)}" data-created="${item.created}" alt="${escapeHtml(item.body || item.title)}"${size ? ` style="width:${size}px"` : ""}>${item.body ? `<figcaption>${escapeHtml(item.body)}</figcaption>` : ""}</figure>`;
  if (f.filetype === "audio" || f.filetype === "video") {
    const tag = f.filetype === "audio" ? "audio" : "video";
    return `<figure class="embed-av"><${tag} controls preload="none" data-hash="${f.hash}" class="embed-media"></${tag}><figcaption><a href="${href}">${escapeHtml(item.title)}</a>${item.body ? ` · ${escapeHtml(item.body)}` : ""}</figcaption></figure>`;
  }
  return `<a class="embed-file" href="${href}">${f.thumb ? `<img data-hash="${f.thumb}" alt="">` : ""}<span><b>${escapeHtml(item.title)}</b><small>${[f.pages ? tr("file.pages", { count: f.pages }) : "", fmtBytes(getLang(), f.size)].filter(Boolean).join(" · ")}</small></span></a>`;
}

/** The replica whose titles [[links]] resolve against while rendering (the workspace of the text), and its id for the links. */
let rendering: Repo | undefined;
let renderingSpace: string | undefined;
function renderMarkdown(src: string, r?: Repo, space?: string): string {
  rendering = r;
  renderingSpace = space;
  try {
    return md.parse(src, { async: false }) as string;
  } finally {
    rendering = undefined;
    renderingSpace = undefined;
  }
}

/** Fill in file contents (from this device or the server) after rendering. */
export function hydrateFiles(root: HTMLElement | null, files: DeviceFiles = current) {
  if (!root) return;
  root.querySelectorAll<HTMLElement>("[data-hash]").forEach((el) => {
    const hash = el.dataset.hash!;
    if (el.dataset.done) return;
    el.dataset.done = "1";
    const keep = el.tagName === "IMG";
    files.url(hash, { keep }).then((u) => {
      if (u) (el as HTMLImageElement).src = u;
      else if (files.isMissing(hash) && el.tagName === "IMG") {
        // not on the server: a quiet note instead of a broken image
        const note = document.createElement("span");
        note.className = "embed-missing";
        note.textContent = tr(files.missingKey(Number(el.dataset.created) || 0));
        el.replaceWith(note);
      }
    });
  });
}

export function Markdown({ src, className }: { src: string; className?: string }) {
  const r = useRepo();
  const space = useSpaceId();
  const files = useFiles();
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(src, r, space), [src, r, space, r.version]);
  useEffect(() => hydrateFiles(ref.current, files), [html]);
  // a click on an image opens the full view, paging through the images of this text
  const onClick = (e: React.MouseEvent) => {
    const img = (e.target as HTMLElement).closest<HTMLImageElement>(".embed-img img");
    if (!img || !ref.current) return;
    const ids = [...ref.current.querySelectorAll<HTMLImageElement>(".embed-img img[data-id]")].map((x) => x.dataset.id!);
    openLightbox(ids, ids.indexOf(img.dataset.id!));
  };
  return <div ref={ref} onClick={onClick} className={"md " + (className ?? "")} dangerouslySetInnerHTML={{ __html: html }} />;
}
