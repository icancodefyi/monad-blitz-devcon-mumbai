// Wallet watcher. Reads recent Monad Testnet logs for Telegram-linked wallets
// and alerts on risky events. It is read-only and never signs or moves funds.
//
// Alerts:
// - An unlimited ERC-20 approval granted by the wallet
// - An "approve all" (ApprovalForAll) grant for an NFT collection
// - A token or NFT arriving from a contract the wallet has not seen before,
//   a common phishing pattern (unsolicited tokens that lure an approval)

import { MONAD_TESTNET } from "@/lib/chain-config";
import { getWatchState, listTelegramOwners, putWatchState } from "@/server/database";
import { monadRpc } from "@/server/monad";
import { sendTelegramAlert } from "@/server/telegram";

export const TOPICS = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  approvalForAll: "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31",
} as const;

/** The testnet RPC rejects log queries wider than a few hundred blocks. */
export const BLOCK_WINDOW = 100;
export const MAX_WINDOWS_PER_RUN = 5;
const MAX_ALERTS_PER_OWNER = 5;
const UNLIMITED_THRESHOLD = BigInt(2) ** BigInt(255);

export type RawLog = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string };

export type WatchAlert =
  | { kind: "unlimited_approval"; token: string; spender: string; transaction_hash: string; block: number }
  | { kind: "approval_for_all"; collection: string; operator: string; transaction_hash: string; block: number }
  | { kind: "unknown_token_in"; contract: string; from: string; nft: boolean; transaction_hash: string; block: number };

export function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function topicAddress(topic: string | undefined): string {
  return `0x${(topic ?? "").slice(-40)}`.toLowerCase();
}

/** Turns raw logs into alerts. `seen` is updated with every contract encountered. */
export function classifyLogs(owner: string, logs: RawLog[], seen: Set<string>): WatchAlert[] {
  const wallet = owner.toLowerCase();
  const alerts: WatchAlert[] = [];
  for (const log of logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    const contract = log.address.toLowerCase();
    const block = Number(BigInt(log.blockNumber));
    if (topic0 === TOPICS.approval && topicAddress(log.topics[1]) === wallet) {
      const value = log.data && log.data !== "0x" ? BigInt(log.data) : BigInt(0);
      if (value >= UNLIMITED_THRESHOLD) alerts.push({ kind: "unlimited_approval", token: contract, spender: topicAddress(log.topics[2]), transaction_hash: log.transactionHash, block });
    } else if (topic0 === TOPICS.approvalForAll && topicAddress(log.topics[1]) === wallet) {
      const approved = log.data && log.data !== "0x" ? BigInt(log.data) !== BigInt(0) : false;
      if (approved) alerts.push({ kind: "approval_for_all", collection: contract, operator: topicAddress(log.topics[2]), transaction_hash: log.transactionHash, block });
    } else if (topic0 === TOPICS.transfer && topicAddress(log.topics[2]) === wallet) {
      if (!seen.has(contract)) alerts.push({ kind: "unknown_token_in", contract, from: topicAddress(log.topics[1]), nft: log.topics.length === 4, transaction_hash: log.transactionHash, block });
    }
    seen.add(contract);
  }
  return alerts;
}

function short(address: string): string { return `${address.slice(0, 6)}…${address.slice(-4)}`; }

export function alertMessage(alert: WatchAlert): string {
  if (alert.kind === "unlimited_approval") {
    return `⚠️ DONADS wallet watch\n\nYour wallet gave ${alert.spender} UNLIMITED permission to spend token ${alert.token}.\n\nIf you did not mean to, revoke this approval now. DONADS never asks for unlimited approvals.`;
  }
  if (alert.kind === "approval_for_all") {
    return `⚠️ DONADS wallet watch\n\nYour wallet let ${alert.operator} move ALL of your NFTs in collection ${alert.collection}.\n\nIf you did not mean to, revoke it now.`;
  }
  return `⚠️ DONADS wallet watch\n\nYour wallet received ${alert.nft ? "an NFT" : "a token"} from ${alert.contract}, a contract it has not dealt with before (sent by ${short(alert.from)}).\n\nUnsolicited tokens are a common phishing lure. Do not approve anything it asks for or visit links attached to it.`;
}

async function getLogs(filter: { fromBlock: number; toBlock: number; topics: Array<string | null> }): Promise<RawLog[]> {
  const result = await monadRpc("eth_getLogs", [{ fromBlock: `0x${filter.fromBlock.toString(16)}`, toBlock: `0x${filter.toBlock.toString(16)}`, topics: filter.topics }]);
  return Array.isArray(result) ? result as RawLog[] : [];
}

/** Fetches the three event kinds for one wallet across a block window. */
export async function walletLogs(owner: string, fromBlock: number, toBlock: number): Promise<RawLog[]> {
  const me = addressTopic(owner);
  const [approvals, approvalsForAll, incoming] = await Promise.all([
    getLogs({ fromBlock, toBlock, topics: [TOPICS.approval, me] }),
    getLogs({ fromBlock, toBlock, topics: [TOPICS.approvalForAll, me] }),
    getLogs({ fromBlock, toBlock, topics: [TOPICS.transfer, null, me] }),
  ]);
  return [...approvals, ...approvalsForAll, ...incoming].sort((left, right) => Number(BigInt(left.blockNumber) - BigInt(right.blockNumber)));
}

export type WatchSummary = { owners: number; scanned_blocks: number; alerts: number; errors: number };

export async function runWalletWatch(): Promise<WatchSummary> {
  const head = Number(BigInt(await monadRpc("eth_blockNumber", []) as string));
  const owners = await listTelegramOwners();
  const summary: WatchSummary = { owners: owners.length, scanned_blocks: 0, alerts: 0, errors: 0 };
  for (const owner of owners) {
    try {
      const state = await getWatchState(owner);
      // Start watching from now on first sight, so old history does not flood alerts.
      if (!state) { await putWatchState(owner, { last_block: head, seen_contracts: [] }); continue; }
      const seen = new Set(state.seen_contracts);
      let from = state.last_block + 1;
      const until = Math.min(head, state.last_block + BLOCK_WINDOW * MAX_WINDOWS_PER_RUN);
      const alerts: WatchAlert[] = [];
      while (from <= until) {
        const to = Math.min(until, from + BLOCK_WINDOW - 1);
        alerts.push(...classifyLogs(owner, await walletLogs(owner, from, to), seen));
        summary.scanned_blocks += to - from + 1;
        from = to + 1;
      }
      for (const alert of alerts.slice(0, MAX_ALERTS_PER_OWNER)) {
        if (await sendTelegramAlert(owner, alertMessage(alert), { label: "View on explorer", url: `${MONAD_TESTNET.explorerUrl}/tx/${alert.transaction_hash}` })) summary.alerts += 1;
      }
      await putWatchState(owner, { last_block: Math.max(state.last_block, until), seen_contracts: [...seen] });
    } catch (cause) {
      summary.errors += 1;
      console.error("DONADS wallet watch failed for an owner", cause instanceof Error ? cause.message : cause);
    }
  }
  return summary;
}
