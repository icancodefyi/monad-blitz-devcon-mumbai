const MAX_JSON_BODY_BYTES = 55 * 1024 * 1024;

export class PublicApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "PublicApiError";
  }
}
export function assertTrustedOrigin(request: Request): void {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const forwardedProtocol = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const allowed = new Set([`${forwardedProtocol}://${forwardedHost}`, url.origin]);
  for (const configured of (process.env.DONADS_ALLOWED_ORIGINS ?? "").split(",")) {
    if (configured.trim()) allowed.add(configured.trim());
  }
  if (!allowed.has(origin)) throw new PublicApiError(403, "ORIGIN_REJECTED", "This request did not originate from DONADS.");
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new PublicApiError(413, "PAYLOAD_TOO_LARGE", "The request is larger than the supported attachment limit.");
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new PublicApiError(400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicApiError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function safeFailure(cause: unknown): { status: number; code: string; message: string } {
  if (cause instanceof PublicApiError) return { status: cause.status, code: cause.code, message: cause.message };
  const message = cause instanceof Error ? cause.message : "";
  if (message === "AUTH_REQUIRED") return { status: 401, code: "AUTH_REQUIRED", message: "Sign in with your wallet to continue." };
  if (/not found/i.test(message)) return { status: 404, code: "NOT_FOUND", message };
  if (/DATABASE_URL/.test(message)) return { status: 503, code: "STORAGE_UNAVAILABLE", message: "Persistent storage is not connected to this deployment." };
  if (/too many|rate limit/i.test(message)) return { status: 429, code: "RATE_LIMITED", message };
  if (/password|secret|private key|api key|postgres|database|sql|stack trace/i.test(message)) {
    return { status: 500, code: "INTERNAL_ERROR", message: "DONADS could not complete this request. Retry once; if it continues, check the Mission timeline." };
  }
  const expected = /required|invalid|expired|already|does not match|must |unsupported|not been mined|reverted|blocked|exceeds|configured|available|approve|authorized|rejected|insufficient|no bytecode/i;
  if (expected.test(message) && message.length <= 300) return { status: 400, code: "REQUEST_REJECTED", message };
  return { status: 500, code: "INTERNAL_ERROR", message: "DONADS could not complete this request. Retry once; if it continues, check the Mission timeline." };
}
