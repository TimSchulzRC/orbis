import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { useTheme } from "../theme";
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph from "force-graph";
import { type Item, META_TYPE } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { isDone, statusProp } from "@obtion/core/traits";
import { useRepo, openItem, useDocumentTitle } from "../hooks";
import { useT } from "../i18n";
import { cn, toggled } from "../lib/utils";
import { TypeGlyph } from "../ui/item-look";
import { NOTE_ICON, FILES_ICON } from "../ui/icons";
import { Button } from "../ui/primitives";

type EdgeKind = "link" | "part" | "rel";
interface GNode {
  id: string;
  title: string;
  color: string;
  square?: boolean;
  deg: number;
  x?: number;
  y?: number;
}
interface GLink {
  source: string | GNode;
  target: string | GNode;
  kind: EdgeKind;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function edgesOf(ix: Index, ids: Set<string>, kinds: Set<EdgeKind>): GLink[] {
  const out: GLink[] = [];
  const seen = new Set<string>();
  const add = (a: string, b: string, kind: EdgeKind) => {
    if (a === b || !ids.has(a) || !ids.has(b) || !kinds.has(kind)) return;
    const key = a < b ? a + b + kind : b + a + kind;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source: a, target: b, kind });
  };
  for (const id of ids) {
    const item = ix.get(id)!;
    for (const l of ix.textLinks(item)) add(id, l.to, "link");
    for (const ref of item.refs) add(id, ref, "link");
    for (const p of ix.parentsOf(id)) add(id, p, "part");
    for (const targets of Object.values(item.rels)) for (const x of targets) add(id, x, "rel");
  }
  return out;
}

function buildGraph(ix: Index, items: Item[], kinds: Set<EdgeKind>) {
  const ids = new Set(items.map((n) => n.id));
  const links = edgesOf(ix, ids, kinds);
  const deg = new Map<string, number>();
  for (const l of links) for (const x of [l.source as string, l.target as string]) deg.set(x, (deg.get(x) ?? 0) + 1);
  const nodes: GNode[] = items.map((n) => {
    const schema = ix.schemaOf(n);
    return { id: n.id, title: n.title || "–", color: n.kind === "datei" ? "--t-file" : (schema?.color ?? "--t-note"), square: !!statusProp(schema), deg: deg.get(n.id) ?? 0 };
  });
  return { nodes, links };
}

function GraphCanvas({ data, highlight }: { data: { nodes: GNode[]; links: GLink[] }; highlight?: Set<string> }) {
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraph<GNode, GLink> | null>(null);
  const hover = useRef<GNode | null>(null);
  const theme = useTheme().resolved;
  const hl = useRef<Set<string> | undefined>(highlight);
  hl.current = highlight;
  const links = useRef(new Map<string, Set<string>>()); // id -> its neighbours
  const fitted = useRef(false);

  useEffect(() => {
    const el = host.current!;
    const colorOf = (c: string) => cssVar(c.startsWith("--") ? c : `--pal-${c}`);
    const text = cssVar("--text");
    const faint = cssVar("--muted"); // labels are text: muted keeps 4.5:1
    const line = cssVar("--border");
    const neighbours = (links.current = new Map());
    fitted.current = false;
    const g = new ForceGraph<GNode, GLink>(el)
      .backgroundColor("rgba(0,0,0,0)")
      .nodeId("id")
      .nodeLabel(() => "")
      .linkColor((l) => (l.kind === "part" ? colorOf("violet") + "66" : l.kind === "rel" ? colorOf("teal") + "66" : line))
      .linkWidth((l) => {
        const hovered = hover.current;
        if (!hovered) return 1;
        const source = (l.source as GNode).id, target = (l.target as GNode).id;
        return source === hovered.id || target === hovered.id ? 2 : 0.6;
      })
      .nodeCanvasObject((n, ctx, scale) => {
        const radius = 2.5 + Math.sqrt(n.deg) * 1.6;
        const hovered = hover.current;
        const lit = hl.current;
        const isHovered = hovered?.id === n.id;
        const nextToHovered = !!hovered && !!neighbours.get(hovered.id)?.has(n.id);
        const dim = (hovered && !isHovered && !nextToHovered) || (lit && lit.size > 0 && !lit.has(n.id));
        ctx.globalAlpha = dim ? 0.18 : 1;
        ctx.beginPath();
        if (n.square) ctx.rect(n.x! - radius * 0.85, n.y! - radius * 0.85, radius * 1.7, radius * 1.7);
        else ctx.arc(n.x!, n.y!, radius, 0, 2 * Math.PI);
        ctx.fillStyle = colorOf(n.color);
        ctx.fill();
        // labels: the hovered node and its neighbours, every node when zoomed in, hubs a little earlier, a few highlighted
        const showLabel = isHovered || nextToHovered || scale > 2.2 || (scale > 1 && n.deg > 6) || (lit?.has(n.id) && lit.size < 30);
        if (showLabel && !dim) {
          const fontSize = Math.max(10 / scale, 2.5);
          ctx.font = `${isHovered ? 600 : 400} ${fontSize}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = isHovered ? text : faint;
          const label = n.title.length > 40 ? n.title.slice(0, 38) + "…" : n.title;
          ctx.fillText(label, n.x!, n.y! + radius + 1.5);
        }
        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((n, color, ctx) => {
        const radius = 4 + Math.sqrt(n.deg) * 1.6;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, radius, 0, 2 * Math.PI);
        ctx.fill();
      })
      .onNodeHover((n) => {
        hover.current = n;
        el.style.cursor = n ? "pointer" : "default";
      })
      .onNodeClick((n) => openItem(n.id))
      .cooldownTicks(200)
      .onEngineStop(() => {
        if (!fitted.current) {
          fitted.current = true;
          g.zoomToFit(400, 60);
        }
      });
    g.d3Force("charge")?.strength?.(-38);
    graph.current = g;
    const resize = new ResizeObserver(() => {
      g.width(el.clientWidth);
      g.height(el.clientHeight);
    });
    resize.observe(el);
    return () => {
      resize.disconnect();
      g._destructor();
    };
  }, [theme]); // colours are read once: drawn again when light/dark changes

  useEffect(() => {
    const g = graph.current!;
    const neighbours = links.current;
    neighbours.clear();
    for (const l of data.links) {
      const source = typeof l.source === "string" ? l.source : l.source.id;
      const target = typeof l.target === "string" ? l.target : l.target.id;
      if (!neighbours.has(source)) neighbours.set(source, new Set());
      if (!neighbours.has(target)) neighbours.set(target, new Set());
      neighbours.get(source)!.add(target);
      neighbours.get(target)!.add(source);
    }
    // Keep positions of nodes that survive a data change.
    const old = new Map(g.graphData().nodes.map((n) => [n.id, n]));
    const nodes = data.nodes.map((n) => {
      const kept = old.get(n.id);
      return kept ? Object.assign(kept, { title: n.title, color: n.color, deg: n.deg }) : { ...n };
    });
    g.graphData({ nodes, links: data.links.map((l) => ({ ...l })) });
    fitted.current = false;
  }, [data]);

  // Highlight changes don't move nodes, so the paused canvas must be told to repaint.
  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    g.autoPauseRedraw(false);
    const timer = setTimeout(() => g.autoPauseRedraw(true), 300);
    if (highlight?.size) g.zoomToFit(500, 80, (n) => highlight.has(n.id));
    return () => clearTimeout(timer);
  }, [highlight]);

  return <div ref={host} className="absolute inset-0" />;
}

export function GraphView() {
  const repo = useRepo();
  const { t } = useT();
  useDocumentTitle(t("nav.graph"));
  const ix = repo.index();
  const types = ix.typesByName();
  // "" = without type, "#file" = files
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(["#file"]));
  const [kinds, setKinds] = useState<Set<EdgeKind>>(() => new Set<EdgeKind>(["link", "part", "rel"]));
  const [hideOrphans, setHideOrphans] = useState(true);
  const [hideDone, setHideDone] = useState(true);
  const [tag, setTag] = useState("");
  const [q, setQ] = useState("");
  const data = useMemo(() => {
    const key = (n: Item) => (n.kind === "datei" ? "#file" : (ix.typeOf(n) ?? ""));
    // drawings are part of their note
    const items = ix.live.filter((n) => n.type !== META_TYPE && n.kind !== "zeichnung" && !hidden.has(key(n)) && (!tag || n.tags.includes(tag)) && (!hideDone || !isDone(n, ix.schemaOf(n))));
    const graph = buildGraph(ix, items, kinds);
    if (!hideOrphans) return graph;
    return { nodes: graph.nodes.filter((n) => n.deg > 0), links: graph.links };
  }, [repo.version, hidden, kinds, hideOrphans, hideDone, tag]);
  const highlight = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return undefined;
    const byTitle = ix.live.filter((n) => n.title.toLowerCase().includes(needle));
    return new Set((byTitle.length ? byTitle : repo.search(q, 15)).map((n) => n.id));
  }, [q, repo.version]);
  const tags = useMemo(() => ix.tags().slice(0, 80), [repo.version]);
  const chip = (on: boolean) => cn("flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs", on ? "bg-hover text-fg" : "text-muted-foreground");
  return (
    <div className="relative h-full">
      <GraphCanvas data={data} highlight={highlight} />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start gap-2 p-3">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl border border-line bg-surface/90 p-1 shadow-sm backdrop-blur">
          {types.map((type) => (
            <Button variant="plain" key={type.id} onClick={() => setHidden(toggled(hidden, type.id))} className={chip(!hidden.has(type.id))} aria-pressed={!hidden.has(type.id)}>
              <TypeGlyph schema={type.schema} size={13} /> {type.schema.name}
            </Button>
          ))}
          <Button variant="plain" onClick={() => setHidden(toggled(hidden, ""))} className={chip(!hidden.has(""))} aria-pressed={!hidden.has("")}>
            <NOTE_ICON size={13} /> {t("kind.note")}
          </Button>
          <Button variant="plain" onClick={() => setHidden(toggled(hidden, "#file"))} className={chip(!hidden.has("#file"))} aria-pressed={!hidden.has("#file")}>
            <FILES_ICON size={13} /> {t("graph.files")}
          </Button>
        </div>
        <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl border border-line bg-surface/90 p-1 shadow-sm backdrop-blur">
          {(["link", "part", "rel"] as EdgeKind[]).map((k) => (
            <Button variant="plain" key={k} onClick={() => setKinds(toggled(kinds, k))} className={chip(kinds.has(k))} aria-pressed={kinds.has(k)}>
              {t("graph.edge." + k)}
            </Button>
          ))}
        </div>
        <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface/90 px-2 py-1 shadow-sm backdrop-blur">
          <Input variant="bare" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("graph.highlight")} className="field w-32 bg-transparent text-xs outline-none" aria-label={t("graph.highlight")} />
          <NativeSelect value={tag} onChange={(e) => setTag(e.target.value)} className="bg-transparent text-xs text-muted-foreground" aria-label={t("graph.tag")}>
            <option value="">{t("graph.allTags")}</option>
            {tags.map((x) => (
              <option key={x.tag} value={x.tag}>
                #{x.tag} ({x.count})
              </option>
            ))}
          </NativeSelect>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <Checkbox checked={hideOrphans} onCheckedChange={(checked) => setHideOrphans(checked === true)} /> {t("graph.hideUnlinked")}
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <Checkbox checked={hideDone} onCheckedChange={(checked) => setHideDone(checked === true)} /> {t("graph.hideDone")}
          </label>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 text-xs text-muted-foreground">{t("graph.stats", { nodes: data.nodes.length, links: data.links.length })}</div>
    </div>
  );
}
