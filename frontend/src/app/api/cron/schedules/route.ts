import { cronAuthorized } from "@/server/cron-auth";
import { runDueSchedules } from "@/server/schedules";

export const maxDuration = 60;

// Triggered by Vercel Cron in production and by `npm run telegram:poll` in
// local development. Each due run only prepares a Flow intent that waits for
// the owner's Telegram approval and wallet signature.
async function handle(request: Request): Promise<Response> {
  if (!cronAuthorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const results = await runDueSchedules();
  return Response.json({ ran: results.length, results }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
