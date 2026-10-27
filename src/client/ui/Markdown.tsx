import { Marked } from "marked";
import { useEffect, useMemo, useRef } from "react";
import { fmtBytes } from "../../shared/i18n";
import type { Item } from "../../shared/model";
import { openLightbox } from "./Lightbox";
import { repo } from "../repo";
import { useRepo } from "../hooks";
import { files } from "../files";
import { getLang, tr } from "../i18n";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    // Never render raw HTML from notes or agent output.
    html: (t) => esc(t.text),
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
      return `<a href="${esc(t.href)}"${internal ? "" : ' target="_blank" rel="noopener"'}>${text}</a>`;
    },
  },
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start: (src: string) => src.match(/!?\[\[/)?.index,
      tokenizer(src: string) {
        const m = /^(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/.exec(src);
        if (!m) return undefined;
        return { type: "wikilink", raw: m[0], embed: m[1] === "!", target: m[2]!.trim(), alias: m[4] };
      },
      renderer(t: any) {
        const id = repo.resolveTitle(t.target);
        const item = id ? repo.get(id) : undefined;
        const f = item?.file;
        const size = t.alias && /^\d+$/.test(t.alias) ? Number(t.alias) : undefined;
        if (f && t.embed) return embedHTML(item!, size);
        if (f) return `<a class="file-chip" href="#/i/${encodeURIComponent(id!)}">📎 ${esc(t.alias || item!.title)} <small>${fmtBytes(getLang(), f.size)}</small></a>`;
        const label = esc(t.alias || t.target);
        return id
          ? `<a class="wikilink" href="#/i/${encodeURIComponent(id)}">${label}</a>`
          : `<a class="wikilink missing" href="#/create?title=${encodeURIComponent(t.target)}" title="${esc(tr("link.missing"))}">${label}</a>`;
      },
    },
  ],
});

/**
 * An embedded file, the same in read-only text and in the editor: an image with its description
 * as alt text and caption, audio and video as a player, anything else (PDF …) as a card with
 * its first page.
 */
export function embedHTML(item: Item, size?: number): string {
  const f = item.file!;
  if (f.filetype === "bild")
    return `<figure class="embed-img"><img data-hash="${f.display ?? f.hash}" data-id="${esc(item.id)}" data-created="${item.created}" alt="${esc(item.body || item.title)}"${size ? ` style="width:${size}px"` : ""}>${item.body ? `<figcaption>${esc(item.body)}</figcaption>` : ""}</figure>`;
  if (f.filetype === "audio" || f.filetype === "video") {
    const tag = f.filetype === "audio" ? "audio" : "video";
    return `<figure class="embed-av"><${tag} controls preload="none" data-hash="${f.hash}" class="embed-media"></${tag}><figcaption><a href="#/i/${encodeURIComponent(item.id)}">${esc(item.title)}</a>${item.body ? ` · ${esc(item.body)}` : ""}</figcaption></figure>`;
  }
  return `<a class="embed-file" href="#/i/${encodeURIComponent(item.id)}">${f.thumb ? `<img data-hash="${f.thumb}" alt="">` : ""}<span><b>${esc(item.title)}</b><small>${[f.pages ? tr("file.pages", { count: f.pages }) : "", fmtBytes(getLang(), f.size)].filter(Boolean).join(" · ")}</small></span></a>`;
}

export function renderMarkdown(src: string): string {
  return md.parse(src, { async: false }) as string;
}

/** Fill in file contents (from this device or the hub) after rendering. */
export function hydrateFiles(root: HTMLElement | null) {
  if (!root) return;
  root.querySelectorAll<HTMLElement>("[data-hash]").forEach((el) => {
    const hash = el.dataset.hash!;
    if (el.dataset.done) return;
    el.dataset.done = "1";
    const keep = el.tagName === "IMG";
    files.url(hash, { keep }).then((u) => {
      if (u) (el as HTMLImageElement).src = u;
      else if (files.isMissing(hash) && el.tagName === "IMG") {
        // not on the hub: a quiet note instead of a broken image
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
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(src), [src, r.version]);
  useEffect(() => hydrateFiles(ref.current), [html]);
  // a click on an image opens the full view, paging through the images of this text
  const onClick = (e: React.MouseEvent) => {
    const img = (e.target as HTMLElement).closest<HTMLImageElement>(".embed-img img");
    if (!img || !ref.current) return;
    const ids = [...ref.current.querySelectorAll<HTMLImageElement>(".embed-img img[data-id]")].map((x) => x.dataset.id!);
    openLightbox(ids, ids.indexOf(img.dataset.id!));
  };
  return <div ref={ref} onClick={onClick} className={"md " + (className ?? "")} dangerouslySetInnerHTML={{ __html: html }} />;
}
