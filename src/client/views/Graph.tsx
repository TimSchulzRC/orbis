// Graph: informations as nodes; links, "Teil von" and relations as edges, filterable.
import { useTheme } from "../theme";
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph from "force-graph";
import { type Item, META_TYPE } from "../../shared/model";
import type { Index } from "../../shared/graph";
import { isDone, statusProp } from "../../shared/traits";
import { useRepo, go } from "../hooks";
import { useT } from "../i18n";
import { cx, TypeGlyph } from "../ui/bits";
import { NOTE_ICON, FILES_ICON } from "../ui/icons";

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
    const k = a < b ? a + b + kind : b + a + kind;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ source: a, target: b, kind });
  };
  for (const id of ids) {
    const it = ix.get(id)!;
    for (const l of ix.textLinks(it)) add(id, l.to, "link");
    for (const r of it.refs) add(id, r, "link");
    for (const p of ix.parentsOf(id)) add(id, p, "part");
    for (const v of Object.values(it.rels)) for (const x of v) add(id, x, "rel");
  }
  return out;
}

function buildGraph(ix: Index, items: Item[], kinds: Set<EdgeKind>) {
  const ids = new Set(items.map((n) => n.id));
  const links = edgesOf(ix, ids, kinds);
  const deg = new Map<string, number>();
  for (const l of links) for (const x of [l.source as string, l.target as string]) deg.set(x, (deg.get(x) ?? 0) + 1);
  const nodes: GNode[] = items.map((n) => {
    const s = ix.schemaOf(n);
    return { id: n.id, title: n.title || "–", color: n.kind === "datei" ? "--t-file" : (s?.color ?? "--t-note"), square: !!statusProp(s), deg: deg.get(n.id) ?? 0 };
  });
  return { nodes, links };
}

function GraphCanvas({
  data,
  focus,
  highlight,
  height,
  onReady,
}: {
  data: { nodes: GNode[]; links: GLink[] };
  focus?: string;
  highlight?: Set<string>;
  height?: number;
  onReady?: (g: ForceGraph<GNode, GLink>) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraph<GNode, GLink> | null>(null);
  const hover = useRef<GNode | null>(null);
  const theme = useTheme().resolved;
  const hl = useRef<Set<string> | undefined>(highlight);
  hl.current = highlight;

  useEffect(() => {
    const el = host.current!;
    const colorOf = (c: string) => cssVar(c.startsWith("--") ? c : `--pal-${c}`);
    const text = cssVar("--text");
    const faint = cssVar("--muted"); // labels are text: muted keeps 4.5:1
    const line = cssVar("--border");
    const neighbours = new Map<string, Set<string>>();
    const g = new ForceGraph<GNode, GLink>(el)
      .backgroundColor("rgba(0,0,0,0)")
      .nodeId("id")
      .nodeLabel(() => "")
      .linkColor((l) => (l.kind === "part" ? colorOf("violet") + "66" : l.kind === "rel" ? colorOf("teal") + "66" : line))
      .linkWidth((l) => {
        const h = hover.current;
        if (!h) return 1;
        const s = (l.source as GNode).id, t = (l.target as GNode).id;
        return s === h.id || t === h.id ? 2 : 0.6;
      })
      .nodeCanvasObject((n, ctx, scale) => {
        const r = 2.5 + Math.sqrt(n.deg) * 1.6;
        const h = hover.current;
        const lit = hl.current;
        const dim = (h && h.id !== n.id && !neighbours.get(h.id)?.has(n.id)) || (lit && lit.size > 0 && !lit.has(n.id));
        ctx.globalAlpha = dim ? 0.18 : 1;
        ctx.beginPath();
        if (n.square) ctx.rect(n.x! - r * 0.85, n.y! - r * 0.85, r * 1.7, r * 1.7);
        else ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
        ctx.fillStyle = colorOf(n.color);
        ctx.fill();
        if (n.id === focus) {
          ctx.lineWidth = 2 / scale;
          ctx.strokeStyle = text;
          ctx.stroke();
        }
        const showLabel = n.id === focus || h?.id === n.id || (h && neighbours.get(h.id)?.has(n.id)) || scale > 2.2 || (scale > 1 && n.deg > 6) || (lit?.has(n.id) && lit.size < 30);
        if (showLabel && !dim) {
          const fs = Math.max(10 / scale, 2.5);
          ctx.font = `${n.id === focus || h?.id === n.id ? 600 : 400} ${fs}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = h?.id === n.id || n.id === focus ? text : faint;
          const label = n.title.length > 40 ? n.title.slice(0, 38) + "…" : n.title;
          ctx.fillText(label, n.x!, n.y! + r + 1.5);
        }
        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((n, color, ctx) => {
        const r = 4 + Math.sqrt(n.deg) * 1.6;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
        ctx.fill();
      })
      .onNodeHover((n) => {
        hover.current = n;
        el.style.cursor = n ? "pointer" : "default";
      })
      .onNodeClick((n) => go(`/i/${encodeURIComponent(n.id)}`))
      .cooldownTicks(200)
      .onEngineStop(() => {
        if (!(g as any).__fitted) {
          (g as any).__fitted = true;
          g.zoomToFit(400, 60);
        }
      });
    g.d3Force("charge")?.strength?.(-38);
    graph.current = g;
    const ro = new ResizeObserver(() => {
      g.width(el.clientWidth);
      g.height(height ?? el.clientHeight);
    });
    ro.observe(el);
    (g as any).__neighbours = neighbours;
    onReady?.(g);
    return () => {
      ro.disconnect();
      g._destructor();
    };
  }, [theme]); // colours are read once: drawn again when light/dark changes

  useEffect(() => {
    const g = graph.current!;
    const neighbours: Map<string, Set<string>> = (g as any).__neighbours;
    neighbours.clear();
    for (const l of data.links) {
      const s = typeof l.source === "string" ? l.source : l.source.id;
      const t = typeof l.target === "string" ? l.target : l.target.id;
      if (!neighbours.has(s)) neighbours.set(s, new Set());
      if (!neighbours.has(t)) neighbours.set(t, new Set());
      neighbours.get(s)!.add(t);
      neighbours.get(t)!.add(s);
    }
    // Keep positions of nodes that survive a data change.
    const old = new Map(g.graphData().nodes.map((n) => [n.id, n]));
    const nodes = data.nodes.map((n) => {
      const o = old.get(n.id);
      return o ? Object.assign(o, { title: n.title, color: n.color, deg: n.deg }) : { ...n };
    });
    g.graphData({ nodes, links: data.links.map((l) => ({ ...l })) });
    if (focus) setTimeout(() => g.zoomToFit(400, 30), 600);
    else (g as any).__fitted = false;
  }, [data]);

  // Highlight changes don't move nodes, so the paused canvas must be told to repaint.
  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    g.autoPauseRedraw(false);
    const t = setTimeout(() => g.autoPauseRedraw(true), 300);
    if (highlight?.size) g.zoomToFit(500, 80, (n) => highlight.has(n.id));
    return () => clearTimeout(t);
  }, [highlight]);

  return <div ref={host} style={height ? { height } : undefined} className={height ? "w-full" : "absolute inset-0"} />;
}

export function GraphView() {
  const r = useRepo();
  const { t } = useT();
  const ix = r.index();
  const types = [...ix.types.values()].sort((a, b) => a.schema!.name.localeCompare(b.schema!.name));
  // "" = without type, "#file" = files
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(["#file"]));
  const [kinds, setKinds] = useState<Set<EdgeKind>>(() => new Set<EdgeKind>(["link", "part", "rel"]));
  const [hideOrphans, setHideOrphans] = useState(true);
  const [hideDone, setHideDone] = useState(true);
  const [tag, setTag] = useState("");
  const [q, setQ] = useState("");
  const data = useMemo(() => {
    const key = (n: Item) => (n.kind === "datei" ? "#file" : (ix.typeOf(n) ?? ""));
    const items = ix.live.filter((n) => n.type !== META_TYPE && !hidden.has(key(n)) && (!tag || n.tags.includes(tag)) && (!hideDone || !isDone(n, ix.schemaOf(n))));
    const g = buildGraph(ix, items, kinds);
    if (!hideOrphans) return g;
    return { nodes: g.nodes.filter((n) => n.deg > 0), links: g.links };
  }, [r.version, hidden, kinds, hideOrphans, hideDone, tag]);
  const highlight = useMemo(() => {
    const lq = q.trim().toLowerCase();
    if (!lq) return undefined;
    const byTitle = ix.live.filter((n) => n.title.toLowerCase().includes(lq));
    return new Set((byTitle.length ? byTitle : r.search(q, 15)).map((n) => n.id));
  }, [q, r.version]);
  const tags = useMemo(() => ix.tags().slice(0, 80), [r.version]);
  const toggle = <T,>(set: Set<T>, v: T, put: (s: Set<T>) => void) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    put(next);
  };
  const chip = (on: boolean) => cx("flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs", on ? "bg-hover text-fg" : "text-muted");
  return (
    <div className="relative h-full">
      <GraphCanvas data={data} highlight={highlight} />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start gap-2 p-3">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl border border-line bg-surface/90 p-1 shadow-sm backdrop-blur">
          {types.map((tp) => (
            <button key={tp.id} onClick={() => toggle(hidden, tp.id, setHidden)} className={chip(!hidden.has(tp.id))} aria-pressed={!hidden.has(tp.id)}>
              <TypeGlyph schema={tp.schema} size={13} /> {tp.schema!.name}
            </button>
          ))}
          <button onClick={() => toggle(hidden, "", setHidden)} className={chip(!hidden.has(""))} aria-pressed={!hidden.has("")}>
            <NOTE_ICON size={13} /> {t("graph.untyped")}
          </button>
          <button onClick={() => toggle(hidden, "#file", setHidden)} className={chip(!hidden.has("#file"))} aria-pressed={!hidden.has("#file")}>
            <FILES_ICON size={13} /> {t("graph.files")}
          </button>
        </div>
        <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl border border-line bg-surface/90 p-1 shadow-sm backdrop-blur">
          {(["link", "part", "rel"] as EdgeKind[]).map((k) => (
            <button key={k} onClick={() => toggle(kinds, k, setKinds)} className={chip(kinds.has(k))} aria-pressed={kinds.has(k)}>
              {t("graph.edge." + k)}
            </button>
          ))}
        </div>
        <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface/90 px-2 py-1 shadow-sm backdrop-blur">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("graph.highlight")} className="w-32 bg-transparent text-xs outline-none" aria-label={t("graph.highlight")} />
          <select value={tag} onChange={(e) => setTag(e.target.value)} className="bg-transparent text-xs text-muted" aria-label={t("graph.tag")}>
            <option value="">{t("graph.allTags")}</option>
            {tags.map((x) => (
              <option key={x.tag} value={x.tag}>
                #{x.tag} ({x.count})
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={hideOrphans} onChange={(e) => setHideOrphans(e.target.checked)} /> {t("graph.hideUnlinked")}
          </label>
          <label className="flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> {t("graph.hideDone")}
          </label>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 text-xs text-muted">{t("graph.stats", { nodes: data.nodes.length, links: data.links.length })}</div>
    </div>
  );
}
