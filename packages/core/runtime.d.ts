// What the shared packages (@obtion/core, @obtion/sync) may use of their environment: only
// what every target has – browsers, Electron, Bun, React Native (Hermes; crypto.getRandomValues
// there needs react-native-get-random-values). No DOM, no Node, no Bun: their typecheck fails
// on anything else (see tsconfig.json here and in packages/sync).

declare var console: { log(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
declare function setTimeout(fn: () => void, ms?: number): number;
declare function clearTimeout(id: number | undefined): void;
declare function setInterval(fn: () => void, ms?: number): number;
declare function clearInterval(id: number | undefined): void;
declare function queueMicrotask(fn: () => void): void;
declare function btoa(s: string): string;
declare function atob(s: string): string;
declare var crypto: { getRandomValues<T extends Uint8Array>(a: T): T };
declare class TextEncoder {
  encode(s: string): Uint8Array<ArrayBuffer>;
}
