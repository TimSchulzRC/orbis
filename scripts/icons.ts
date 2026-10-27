// Renders the app icon (a tiny graph: three linked nodes) to PNG and SVG without dependencies.
//   bun run icons   → apps/web/public/
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BG = [22, 21, 29];
const LINE = [120, 116, 150];
const NODES: [number, number, number, number[]][] = [
  [0.34, 0.36, 0.115, [240, 176, 64]], // amber
  [0.68, 0.32, 0.085, [110, 150, 255]], // blue
  [0.56, 0.7, 0.13, [80, 200, 140]], // green
];
const EDGES = [[0, 1], [0, 2], [1, 2]];

function render(size: number, pad = 0) {
  const SS = 4;
  const px = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
          let c: number[] | null = null;
          // rounded square background (full bleed when pad = 0 for maskable)
          const r = 0.22, m = pad;
          const qx = Math.max(Math.abs(u - 0.5) - (0.5 - m - r), 0), qy = Math.max(Math.abs(v - 0.5) - (0.5 - m - r), 0);
          if (pad === 0 || Math.hypot(qx, qy) <= r) c = BG;
          if (c) {
            const s = 1 - 2 * pad, ux = (u - pad) / s, vy = (v - pad) / s;
            for (const [a, b] of EDGES) {
              const [x1, y1] = NODES[a!]!, [x2, y2] = NODES[b!]!;
              const dx = x2 - x1, dy = y2 - y1;
              const t = Math.max(0, Math.min(1, ((ux - x1) * dx + (vy - y1) * dy) / (dx * dx + dy * dy)));
              if (Math.hypot(ux - (x1 + t * dx), vy - (y1 + t * dy)) < 0.018) c = LINE;
            }
            for (const [nx, ny, nr, col] of NODES) if (Math.hypot(ux - nx, vy - ny) < nr) c = col;
          }
          if (c) (acc[0]! += c[0]!, acc[1]! += c[1]!, acc[2]! += c[2]!, acc[3]! += 255);
        }
      const i = (y * size + x) * 4;
      const n = SS * SS, a = acc[3]! / n;
      px[i] = a ? (acc[0]! / n) * (255 / a) : 0; px[i + 1] = a ? (acc[1]! / n) * (255 / a) : 0; px[i + 2] = a ? (acc[2]! / n) * (255 / a) : 0; px[i + 3] = a;
    }
  return png(size, px);
}

function png(size: number, px: Float32Array) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size * 4; x++) raw[y * (size * 4 + 1) + 1 + x] = Math.round(px[y * size * 4 + x]!);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const out = process.argv[2] ?? "apps/web/public";
writeFileSync(`${out}/icon-192.png`, render(192));
writeFileSync(`${out}/icon-512.png`, render(512));
writeFileSync(`${out}/apple-touch-icon.png`, render(180));
const circles = NODES.map(([x, y, r, c]) => `<circle cx="${x * 64}" cy="${y * 64}" r="${r * 64}" fill="rgb(${c})"/>`).join("");
const lines = EDGES.map(([a, b]) => `<line x1="${NODES[a!]![0] * 64}" y1="${NODES[a!]![1] * 64}" x2="${NODES[b!]![0] * 64}" y2="${NODES[b!]![1] * 64}" stroke="rgb(${LINE})" stroke-width="2.3"/>`).join("");
writeFileSync(`${out}/icon.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="rgb(${BG})"/>${lines}${circles}</svg>`);
console.log("icons written");
