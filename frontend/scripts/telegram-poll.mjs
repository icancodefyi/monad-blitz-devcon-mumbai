// Local development bridge for Telegram.
//
// Telegram cannot reach localhost, and exposing a laptop through a public tunnel
// is unnecessary for testing. This script pulls updates from Telegram over an
// outbound connection (getUpdates) and forwards each one to the local webhook
// route with the same secret header Telegram would send in production.
//
// Usage: npm run telegram:poll   (with `npm run dev` running)
// Requires TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env.local.
// Do not run this while a production webhook is registered for the same bot:
// Telegram rejects getUpdates while a webhook is set.

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
const target = process.env.DONADS_LOCAL_WEBHOOK_URL ?? "http://localhost:3000/api/telegram/webhook";
const scheduleTarget = process.env.DONADS_LOCAL_SCHEDULE_URL ?? "http://localhost:3000/api/cron/schedules";
const cronSecret = process.env.CRON_SECRET?.trim();

if (!token || !secret) {
  console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set in .env.local.");
  process.exit(1);
}

const api = (method, payload) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
}).then((response) => response.json());

const info = await api("getWebhookInfo", {});
if (info.ok && info.result.url) {
  console.error(`A webhook is registered (${info.result.url}). Remove it before local polling, or test against that deployment instead.`);
  process.exit(1);
}

let offset = 0;
let stopping = false;
process.on("SIGINT", () => { stopping = true; console.log("\nStopping Telegram bridge."); process.exit(0); });
console.log(`Telegram bridge running: forwarding updates to ${target}`);

// Scheduled payments: in production Vercel Cron calls this endpoint; locally
// the bridge does, every 30 seconds. Each due run only prepares an intent that
// waits for Telegram approval and a wallet signature.
if (cronSecret && cronSecret.length >= 32) {
  const tick = async () => {
    try {
      const response = await fetch(scheduleTarget, { method: "POST", headers: { Authorization: `Bearer ${cronSecret}` } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) console.error(`${new Date().toISOString()} schedule tick -> ${response.status}`);
      else if (result.ran) console.log(`${new Date().toISOString()} scheduled runs: ${result.results.map((item) => item.outcome).join(", ")}`);
    } catch (error) {
      console.error(`${new Date().toISOString()} schedule tick error: ${error instanceof Error ? error.message : error}`);
    }
  };
  setInterval(tick, 30_000);
  console.log(`Scheduled payments: checking ${scheduleTarget} every 30 seconds`);
} else {
  console.log("Scheduled payments: disabled (set CRON_SECRET, 32+ characters, in .env.local)");
}

while (!stopping) {
  try {
    const result = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
    if (!result.ok) throw new Error(result.description ?? "getUpdates failed");
    for (const update of result.result) {
      offset = update.update_id + 1;
      const kind = update.callback_query ? "button tap" : update.message ? "message" : "update";
      const response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify(update),
      });
      console.log(`${new Date().toISOString()} ${kind} #${update.update_id} -> ${response.status}`);
    }
  } catch (error) {
    console.error(`${new Date().toISOString()} bridge error: ${error instanceof Error ? error.message : error}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}
