import { handleTelegramUpdate, telegramWebhookAuthorized } from "@/server/telegram";

export const maxDuration = 15;

export async function POST(request: Request): Promise<Response> {
  if (!telegramWebhookAuthorized(request.headers.get("x-telegram-bot-api-secret-token"))) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) {
    return Response.json({ error: "Payload too large." }, { status: 413, headers: { "Cache-Control": "no-store" } });
  }
  let update: unknown;
  try { update = await request.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  await handleTelegramUpdate(update);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
