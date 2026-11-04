import { timingSafeEqual } from "node:crypto";

import { runDueSchedules } from "@/server/schedules";

export const maxDuration = 60;

// Triggered by Vercel Cron in production and by `npm run telegram:poll` in
// local development. Each due run only prepares a Flow intent that waits for
// the owner's Telegram approval and wallet signature.
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  const header = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !header.startsWith("Bearer ")) return false;
  const left = Buffer.from(header.slice(7)); const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function handle(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const results = await runDueSchedules();
  return Response.json({ ran: results.length, results }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
