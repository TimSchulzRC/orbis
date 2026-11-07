// A passkey in software, for tests: an ES256 key that answers registration and sign-in the way a
// browser hands it to the server (attestation "none").

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const sha256 = async (data: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : (data as BufferSource)));

/** Just enough CBOR: unsigned and negative integers, byte and text strings, maps. */
function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number) => {
    if (n < 24) return new Uint8Array([(major << 5) | n]);
    if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
    return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Map) return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
  throw new Error(`no CBOR for ${typeof value}`);
}

/** WebCrypto signs as r || s; WebAuthn wants DER. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    return v[0]! & 0x80 ? concat(new Uint8Array([0]), v) : v;
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  const body = concat(new Uint8Array([2, r.length]), r, new Uint8Array([2, s.length]), s);
  return concat(new Uint8Array([0x30, body.length]), body);
}

export interface SoftPasskey {
  id: Uint8Array;
  keys: CryptoKeyPair;
  userHandle: string;
  counter: number;
}

/** Answers generate-register-options; the second value is the passkey for later sign-ins. */
export async function register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string): Promise<[unknown, SoftPasskey]> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))]]));
  const id = crypto.getRandomValues(new Uint8Array(16));
  const rpId = options.rp.id ?? new URL(origin).hostname;
  // flags: user present, user verified, attested credential data
  const authData = concat(await sha256(rpId), new Uint8Array([0x45, 0, 0, 0, 0]), new Uint8Array(16), new Uint8Array([0, id.length]), id, cose);
  const clientData = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false });
  const response = {
    id: b64url(id),
    rawId: b64url(id),
    type: "public-key",
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    response: { clientDataJSON: b64url(new TextEncoder().encode(clientData)), attestationObject: b64url(cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))), transports: ["internal"] },
  };
  return [response, { id, keys, userHandle: options.user.id, counter: 0 }];
}

/** Answers generate-authenticate-options with the passkey. */
export async function authenticate(options: { challenge: string; rpId?: string }, origin: string, key: SoftPasskey): Promise<unknown> {
  key.counter++;
  const authData = concat(await sha256(options.rpId ?? new URL(origin).hostname), new Uint8Array([0x05, 0, 0, 0, key.counter]));
  const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.keys.privateKey, concat(authData, await sha256(clientData))));
  return {
    id: b64url(key.id),
    rawId: b64url(key.id),
    type: "public-key",
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(der(signature)), userHandle: key.userHandle },
  };
}
