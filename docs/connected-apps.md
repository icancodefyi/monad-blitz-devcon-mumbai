# Connected applications

Connected apps extend Mission input and delivery. They never inherit wallet
authority and never approve a financial checkpoint.

| Connector | Initial use | Minimum permission model |
|---|---|---|
| Google Workspace | Read selected purchase receipts; export reports to Drive | Gmail read-only and Drive app-created files |
| Slack | Start non-financial Missions and receive status | Explicit channel access and bot messages |
| GitHub | Read issue context and draft task updates | Selected repositories only |
| Telegram | Mobile status and approval deep links | User-linked chat only |

## Activation requirements

1. Register the application with the provider.
2. Add the production and preview callback URLs.
3. Put client secrets in Vercel server-only environment variables.
4. Generate a 32-byte connector encryption key in a secret manager.
5. Implement and test OAuth state, PKCE where supported, callback replay
   protection, encrypted refresh-token storage and revocation.
6. Validate inbound webhook signatures and timestamps.
7. Record every connector read/write as a Mission event.
8. Complete disconnect and data-deletion tests.

The public product does not expose placeholder connector cards. Telegram becomes
visible only when all server-side bot and webhook settings are configured. Live
OAuth activation remains deliberately unavailable until the callback and encrypted
token tests are implemented for the selected provider.

## Telegram activation

1. Create the bot with BotFather and disable group use unless it is explicitly needed.
2. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, a random 32-byte
   `TELEGRAM_WEBHOOK_SECRET`, and the HTTPS `DONADS_PUBLIC_APP_URL` in Vercel.
3. Register `https://YOUR_DOMAIN/api/telegram/webhook` with Telegram `setWebhook`,
   passing the same secret as `secret_token`.
4. Redeploy, connect a wallet, open Action needed, and select Connect Telegram.
5. Complete the one-time `/start` link inside the bot and verify that a waiting
   checkpoint arrives with a Review in DONADS button.

Link codes expire after ten minutes and are single-use. Telegram receives only a
checkpoint title, short summary, and DONADS deep-link. It cannot approve, sign, or
receive wallet secrets. Duplicate Telegram updates are rejected by persisted update ID.
