// Answers of the API: JSON, errors as { error }.
import type { ErrorBody } from "@obtion/core/api";

export const json = <T = unknown>(x: T, status = 200) => Response.json(x, { status });
export const fail = (status: number, error: string) => json<ErrorBody>({ error }, status);

/** A request's JSON body, or null when it is not JSON (wrong content type, broken, empty). */
export async function body<T>(req: Request): Promise<T | null> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return null;
  return (await req.json().catch(() => null)) as T | null;
}
