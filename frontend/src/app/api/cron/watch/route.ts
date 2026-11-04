import { cronAuthorized } from "@/server/cron-auth";
import { runWalletWatch } from "@/server/wallet-watcher";

export const maxDuration = 60;

// Scans recent Monad blocks for risky events on Telegram-linked wallets and
// sends alerts. Read-only: it never signs or moves funds.
async function handle(request: Request): Promise<Response> {
  if (!cronAuthorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const summary = await runWalletWatch();
  return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
