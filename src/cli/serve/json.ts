// cli/serve/json.ts — small JSON response helpers shared by router.ts and static.ts.
//
// Split out of router.ts (rather than duplicated in both) so a single place owns the
// spec's error envelope (FR-07: `{error:{code,message}}`) and the response-size safety
// cap (design §7 "cap de tamaño de respuesta") — both the API and the static-asset path
// go through the same guard.

import type { ServerResponse } from "node:http";

/** Hard cap on a single response body — a safety net against an oversized/misbehaving
 * project (huge tree/stats payload) exhausting server memory, not a normal-path limit. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > MAX_RESPONSE_BYTES) {
    const fallback = JSON.stringify({
      error: { code: "RESPONSE_TOO_LARGE", message: "response exceeds the server's size cap" },
    });
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(fallback);
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

/** FR-07: every error response — API or static — uses this envelope. */
export function sendApiError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}
