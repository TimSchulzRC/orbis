import { fmtBytes } from "@obtion/core/i18n";
import { type Item, wikiLinkRe } from "@obtion/core/model";
import type { Repo } from "@obtion/sync";
import { Marked, type Tokens } from "marked";
import { useEffect, useMemo, useRef } from "react";
import { drawingEmbedHTML, hydrateDrawings } from "../drawing/Drawing";
import { files as current, type DeviceFiles } from "../files";
import { itemPath, spaceHref, useFiles, useRepo, useSpaceId } from "../hooks";
import { getLang, tr } from "../i18n";
import { repo } from "../repo";
import { openLightbox } from "./Lightbox";
import { escapeHtml } from "./text";

const WIKILINK_AT_START = wikiLinkRe(true);

/** `alias` is the text after |, a width for files. */
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
		// Never render raw HTML from notes or agent output; only a line break (in a table cell, where
		// a row is one line of Markdown, "<br>" is the way to break one).
		html: (t) => (/^<br\s*\/?>$/i.test(t.text.trim()) ? "<br>" : escapeHtml(t.text)),
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
				const match = WIKILINK_AT_START.exec(src);
				if (!match) return undefined;
				return {
					type: "wikilink",
					raw: match[0],
					embed: match[1] === "!",
					target: match[2]!.trim(),
					alias: match[4]?.slice(1),
				};
			},
			renderer(token) {
				const link = token as WikiToken; // made by the tokenizer above
				const source = rendering ?? repo;
				const id = source.resolveTitle(link.target);
				const item = id ? source.get(id) : undefined;
				const file = item?.file;
				const size = link.alias && /^\d+$/.test(link.alias) ? Number(link.alias) : undefined;
				if (file && link.embed) return embedHTML(item!, size, renderingSpace);
				if (item?.kind === "drawing" && link.embed && !item.deleted) return drawingEmbedHTML(item);
				if (file)
					return `<a class="file-chip" href="${spaceHref(renderingSpace, itemPath(id!))}">📎 ${escapeHtml(link.alias || item!.title)} <small>${fmtBytes(getLang(), file.size)}</small></a>`;
				const label = escapeHtml(link.alias || link.target);
				return id
					? `<a class="wikilink" href="${spaceHref(renderingSpace, itemPath(id))}">${label}</a>`
					: `<a class="wikilink missing" href="${spaceHref(renderingSpace, `/create?title=${encodeURIComponent(link.target)}`)}" title="${escapeHtml(tr("link.missing"))}">${label}</a>`;
			},
		},
	],
});

/**
 * Shared by read-only text and the editor. `space` is the text's workspace, so links open there
 * (in a new tab too).
 */
export function embedHTML(item: Item, size?: number, space?: string): string {
	const href = spaceHref(space, itemPath(item.id));
	const file = item.file!;
	if (file.filetype === "image")
		return `<figure class="embed-img"><img data-hash="${file.display ?? file.hash}" data-id="${escapeHtml(item.id)}" data-created="${item.created}" alt="${escapeHtml(item.body || item.title)}"${size ? ` style="width:${size}px"` : ""}>${item.body ? `<figcaption>${escapeHtml(item.body)}</figcaption>` : ""}</figure>`;
	if (file.filetype === "audio" || file.filetype === "video") {
		const tag = file.filetype;
		return `<figure class="embed-av"><${tag} controls preload="none" data-hash="${file.hash}" class="embed-media"></${tag}><figcaption><a href="${href}">${escapeHtml(item.title)}</a>${item.body ? ` · ${escapeHtml(item.body)}` : ""}</figcaption></figure>`;
	}
	const meta = [
		file.pages ? tr("file.pages", { count: file.pages }) : "",
		fmtBytes(getLang(), file.size),
	]
		.filter(Boolean)
		.join(" · ");
	return `<a class="embed-file" href="${href}">${file.thumb ? `<img data-hash="${file.thumb}" alt="">` : ""}<span><b>${escapeHtml(item.title)}</b><small>${meta}</small></span></a>`;
}

/** Module state because marked's renderers get no context. Set only inside renderMarkdown. */
let rendering: Repo | undefined;
let renderingSpace: string | undefined;
/** Tables get a wrapper that scrolls sideways when they are wider than the text. */
export function renderMarkdown(src: string, source?: Repo, space?: string): string {
	rendering = source;
	renderingSpace = space;
	try {
		return (md.parse(src, { async: false }) as string)
			.replace(/<table>/g, '<div class="md-table"><table>')
			.replace(/<\/table>/g, "</table></div>");
	} finally {
		rendering = undefined;
		renderingSpace = undefined;
	}
}

export function hydrateFiles(root: HTMLElement | null, files: DeviceFiles = current) {
	if (!root) return;
	for (const el of root.querySelectorAll<HTMLElement>("[data-hash]")) {
		const hash = el.dataset.hash!;
		if (el.dataset.done) continue;
		el.dataset.done = "1";
		const keep = el.tagName === "IMG";
		files.url(hash, { keep }).then((url) => {
			if (url) (el as HTMLImageElement).src = url;
			else if (files.isMissing(hash) && el.tagName === "IMG") {
				// gone from the server too: a quiet note instead of a broken image
				const note = document.createElement("span");
				note.className = "embed-missing";
				note.textContent = tr(files.missingKey(Number(el.dataset.created) || 0));
				el.replaceWith(note);
			}
		});
	}
}

export function Markdown({ src, className }: { src: string; className?: string }) {
	const spaceRepo = useRepo();
	const space = useSpaceId();
	const files = useFiles();
	const ref = useRef<HTMLDivElement>(null);
	const html = useMemo(
		() => renderMarkdown(src, spaceRepo, space),
		[src, spaceRepo, space, spaceRepo.version],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: html is the trigger, each new html replaces the DOM that needs its files and drawings
	useEffect(() => {
		hydrateFiles(ref.current, files);
		if (ref.current) hydrateDrawings(ref.current, spaceRepo, files);
	}, [html, files, spaceRepo]);
	const onClick = (e: React.MouseEvent) => {
		const img = (e.target as HTMLElement).closest<HTMLImageElement>(".embed-img img");
		if (!img || !ref.current) return;
		const ids = [...ref.current.querySelectorAll<HTMLImageElement>(".embed-img img[data-id]")].map(
			(x) => x.dataset.id!,
		);
		openLightbox(ids, ids.indexOf(img.dataset.id!));
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the click is delegated to the rendered images, which only zoom in; links and text stay usable by keyboard
		<div
			className={`md ${className ?? ""}`}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: marked renders it with raw HTML and item text escaped (see the renderers above)
			dangerouslySetInnerHTML={{ __html: html }}
			onClick={onClick}
			ref={ref}
		/>
	);
}
