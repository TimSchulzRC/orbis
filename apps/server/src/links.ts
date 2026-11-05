// Links to one file content for places that can't send a header (img, audio, video, the PDF
// viewer, a download link). Never a session or MCP token in a URL: a link names the workspace,
// the content's hash and the member it was made for, is signed with the server's secret and runs
// out after LINK_SECONDS. It reads that one content only, and only while the person is a member.
import { createHmac, timingSafeEqual } from "node:crypto";

export const LINK_SECONDS = 10 * 60;

const b64url = (s: string) => Buffer.from(s).toString("base64url");

export class BlobLinks {
  private key: Buffer;

  constructor(secret: string) {
    // its own key, so a link's signature never doubles as anything else signed with the secret
    this.key = createHmac("sha256", secret).update("obtion blob link").digest();
  }

  private mac(workspace: string, hash: string, user: string, expires: number) {
    return createHmac("sha256", this.key).update(`${workspace}\n${hash}\n${user}\n${expires}`).digest("base64url");
  }

  /** The `s` query parameter, and when it runs out (ms). */
  sign(workspace: string, hash: string, user: string, now = Date.now()): { s: string; expires: number } {
    const expires = Math.floor(now / 1000) + LINK_SECONDS;
    return { s: `${expires}.${b64url(user)}.${this.mac(workspace, hash, user, expires)}`, expires: expires * 1000 };
  }

  /** The member the link was made for, or undefined: forged, for another content or workspace, run out. */
  verify(s: string, workspace: string, hash: string, now = Date.now()): string | undefined {
    const [exp, user64, mac, extra] = s.split(".");
    if (!exp || !user64 || !mac || extra !== undefined || !/^\d{1,12}$/.test(exp)) return undefined;
    const expires = Number(exp);
    const seconds = now / 1000;
    if (expires <= seconds || expires > seconds + LINK_SECONDS + 60) return undefined;
    const user = Buffer.from(user64, "base64url").toString();
    const want = Buffer.from(this.mac(workspace, hash, user, expires));
    const got = Buffer.from(mac);
    return want.length === got.length && timingSafeEqual(want, got) ? user : undefined;
  }
}
