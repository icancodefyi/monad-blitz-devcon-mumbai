# DONADS

**The AI agent that moves your money on Monad, and can't be talked into stealing it.**

![DONADS mascot](frontend/public/brand/donads-mascot-tile.png)

| | |
|---|---|
| Live app | https://donads.vercel.app |
| Network | Monad Testnet (chain id 10143) |
| `DonadsPolicyVault` | [`0x18efC2BbE6eeF8B3B97795Abc2a0562787a61a41`](https://testnet.monadscan.com/address/0x18efC2BbE6eeF8B3B97795Abc2a0562787a61a41) |
| Source verification | [Sourcify exact match](https://sourcify.dev/#/lookup/0x18efC2BbE6eeF8B3B97795Abc2a0562787a61a41) |
| Deployment transaction | [`0xdbc72466…daebe5`](https://testnet.monadscan.com/tx/0xdbc7246660bb7094b36200738f841764ebfb9ab87ac7980b89051a707fdaebe5) |
| `DonadsEscrow` | Deployed once per deal from the chat; each escrow is its own contract |
| Telegram bot | [@doonads_bot](https://t.me/doonads_bot) |

Deployment details are recorded in [`contracts/deployments/testnet.json`](contracts/deployments/testnet.json).

## The problem

AI agents are being given wallets, and they can be tricked. In May 2026 an attacker sent Grok a message in Morse code, and the Bankr-connected wallet behind it sent out roughly $150,000–$216,000 ([Cointelegraph](https://cointelegraph.com/magazine/grok-bankr-wallet-free-nft-prompt-injection), [OECD AI incident log](https://oecd.ai/en/incidents/2026-05-04-4a73)). The AI held the power to move money, so tricking the AI meant taking the money.

## How DONADS works

DONADS separates thinking from moving money:

1. **The AI can't set an amount or an address.** Plain code reads them from what you typed. Requests that carry hidden instructions are refused.
2. **Nothing moves without you.** You approve the exact transfer in Telegram, then sign it in MetaMask.
3. **Nothing is "done" until Monad says so.** DONADS checks the mined receipt (sender, recipient, amount, calldata) before it reports success.

DONADS never holds your keys. The server cannot sign a transaction.

## What you can do

Type these in the DONADS chat after connecting MetaMask.

| Feature | Example | What happens |
|---|---|---|
| Transfer | `Send 0.01 MON to 0x…` | Exact intent, Telegram approval, wallet signature, receipt check |
| Batch | `Send 0.01 MON to each of 0xA, 0xB, 0xC` | Up to 10 recipients in one reviewed batch |
| Token transfer | `Send 10 USDC token 0xTOKEN to 0xRECIPIENT` | Reads the token contract, checks balances, verifies the balance change |
| Telegram approvals | (automatic) | Full addresses, amounts and total in Telegram with ✅ Approve / ❌ Reject |
| Best-offer finder | `Find the best offer for a logo design under 0.05 MON` | Ranks offers by price, then delivery, then completed deals; sends the top one to Telegram; **Go** opens the escrow for you to sign |
| Escrow | `Create escrow 0.05 MON for 0xSELLER with arbiter 0xARBITER refund after 24 hours terms Logo delivered` | Deploys a funded escrow; `Release escrow 0x…`, `Timeout refund escrow 0x…`, `Dispute escrow 0x… evidence …` |
| Scheduled payments | `Pay 0.01 MON to each of 0xA, 0xB every 2 minutes` | Each run prepares the exact batch and asks in Telegram; skipped while the last run is still waiting. `Stop my scheduled payments` |
| Wallet watch | (automatic for Telegram-linked wallets) | Telegram alerts for unlimited token approvals, approve-all NFT grants, and tokens from unknown contracts |
| Lookalike block | (automatic) | Stops a transfer to an address that imitates one you have paid before (address poisoning) |
| Scam checks | (automatic) | Sentinel screens links, seed-phrase requests and dangerous approvals before anything runs |
| Research | `Compare these docs https://…` | Scout reads the pages you give it and returns cited findings, flagging hidden instructions |
| Policy vault | `Deploy my policy vault` | Deploys an owner-controlled vault for future bounded sessions |

The best-offer finder uses three clearly labelled **test sellers** on Monad Testnet.

## Attack replay

[`frontend/src/server/attack-replay.test.ts`](frontend/src/server/attack-replay.test.ts) feeds attacker text through every input path and checks that no transfer intent is created and no task changes:

- **Chat:** Morse, base64, hidden HTML comments, "ignore previous instructions", role hijacks, invisible characters
- **AI planner:** the model returning a payment or inventing source URLs
- **Scout:** a web page instructing a MON transfer
- **Telegram:** free-text transfer requests and forged or malformed button payloads

Run it with `npm test -- attack-replay` in `frontend/`.

## Architecture

```text
Browser (Next.js + wagmi/RainbowKit, MetaMask)
  -> /api/v1 (wallet-signed session)
       -> Neon Postgres (tasks, approvals, schedules, offers, watch state)
       -> Gemini (optional, routing only; payment requests skip the model)
       -> Monad Testnet JSON-RPC (balances, receipts, logs)
  -> /api/telegram/webhook  <- Telegram (approvals, Go/Skip)
  -> /api/cron/schedules, /api/cron/watch  <- Vercel Cron or the local bridge
  -> MetaMask signs every transaction
```

## Run it yourself

You need Node.js 22 or newer, a free [Neon](https://neon.tech) Postgres database, and MetaMask with some [Monad Testnet MON](https://docs.monad.xyz).

```bash
git clone https://github.com/Aditya-linux/donadss.git
cd donadss/frontend
cp .env.example .env.local
```

Edit `frontend/.env.local`:

- `DATABASE_URL`: your Neon connection string. Tables are created automatically on first use.
- `NEXT_PUBLIC_REOWN_PROJECT_ID`: a free project id from [cloud.reown.com](https://cloud.reown.com).
- `DONADS_ALLOWED_ORIGINS=http://localhost:3000`

Then:

```bash
npm ci
npm run dev
```

Open http://localhost:3000, connect MetaMask and sign in.

### Telegram (for approvals, offers, schedules and alerts)

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. In `.env.local` set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`), `CRON_SECRET` (`openssl rand -hex 32`), `TELEGRAM_DELIVERY=polling`, and `DONADS_PUBLIC_APP_URL` to any public https URL of the app (Telegram does not accept localhost links).
3. In a second terminal run `npm run telegram:poll`. It forwards Telegram updates to the local app and triggers scheduled payments and wallet watch every 30 seconds. Nothing on your machine is exposed to the internet.
4. In DONADS open the bell icon, choose **Connect** under Telegram approvals, and press Start in the bot.

### Checks

```bash
npm test        # unit, security and attack replay tests
npm run lint
npm run build
```

### Contracts

```bash
cd ../contracts
npm ci
npm run compile
npm test                 # Solidity unit, fuzz and invariant tests
npm run deploy:testnet   # needs DEPLOYER_PRIVATE_KEY in contracts/.env; refuses any chain except 10143
```

## Limitations

- **Testnet only.** Mainnet stays off until the contracts are audited.
- **Offers come from test sellers.** No real marketplace is connected.
- **Swaps are disabled** until official Uniswap contracts are live on Monad Testnet.
- **The policy vault does not spend on its own yet.** Delegated execution needs exact action binding and a review.
- **The lookalike check** compares the first and last four characters with addresses you have already paid through DONADS.

## More documentation

- [Product definition](PROJECT.md)
- [Current state](docs/architecture/current-state.md) and [decisions](docs/architecture/decisions.md)
- [Acceptance matrix](docs/acceptance-matrix.md)
- [Mainnet runbook](docs/mainnet-runbook.md)
- [Contract fuzz and invariant evidence](docs/security/contract-fuzz-invariants-2026-11-03.md)
