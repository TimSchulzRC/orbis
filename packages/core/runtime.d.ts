// The only globals @obtion/core and @obtion/sync may use: what browsers, Electron, Bun and React
// Native (Hermes) all have. No DOM, Node or Bun types. On Hermes, crypto.getRandomValues needs
// react-native-get-random-values.

declare var console: {
	log(...a: unknown[]): void;
	warn(...a: unknown[]): void;
	error(...a: unknown[]): void;
};
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
