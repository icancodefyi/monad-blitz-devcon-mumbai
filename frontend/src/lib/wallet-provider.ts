import { encodeFunctionData, getAddress } from "viem";
import { disconnect, getAccount, switchChain } from "@wagmi/core";

import { monadTestnet, wagmiConfig } from "@/lib/wallet-config";

export type WalletProvider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  disconnect?: () => Promise<void>;
};

let activeProvider: WalletProvider | null = null;
let walletChooser: (() => void) | undefined;

export function walletConnectionMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/missing or invalid request\(\) chainid|eip155:10143|unsupported chain|unsupported network|chain.?id/i.test(message)) {
    return "This wallet cannot use Monad Testnet yet. Choose a Monad-compatible wallet, or add Monad Testnet (chain 10143) before trying the transaction again.";
  }
  if (/user rejected|user denied|request rejected|rejected by user/i.test(message)) return "Wallet approval was declined. Nothing was signed or sent.";
  if (/not connected|connector.*not connected/i.test(message)) return "Connect MetaMask, Phantom, or another installed EVM wallet first.";
  return message;
}

export function registerWalletChooser(opener: (() => void) | undefined): () => void {
  walletChooser = opener;
  return () => {
    if (walletChooser === opener) walletChooser = undefined;
  };
}

export function openWalletChooser(): void {
  if (!walletChooser) throw new Error("The wallet chooser is still loading. Try again in a moment.");
  walletChooser();
}

export function monToWeiHex(value: string): string {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(value.trim());
  if (!match) throw new Error("MON amount must be a positive decimal with at most 18 decimal places.");
  const fraction = (match[2] ?? "").padEnd(18, "0");
  const wei = BigInt(match[1]) * BigInt(10) ** BigInt(18) + BigInt(fraction || "0");
  if (wei <= BigInt(0)) throw new Error("MON amount must be greater than zero.");
  return `0x${wei.toString(16)}`;
}

export function erc20TransferData(recipient: string, amountAtomic: string): `0x${string}` {
  return encodeFunctionData({
    abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
    functionName: "transfer",
    args: [getAddress(recipient), BigInt(amountAtomic)],
  });
}

// Chain and account changes go through wagmi, which adds Monad Testnet to the
// wallet when it is missing. The app does not send raw wallet_*Chain requests.
export async function ensureMonadTestnet(): Promise<void> {
  if (getAccount(wagmiConfig).chainId === monadTestnet.id) return;
  try {
    await switchChain(wagmiConfig, { chainId: monadTestnet.id });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (/user rejected|user denied|rejected/i.test(message)) throw new Error("Wallet approval was declined. Nothing was signed or sent.");
    throw new Error("This wallet did not switch to Monad Testnet. Add Monad Testnet (chain 10143) in MetaMask, reconnect, and try again.");
  }
}

// A wallet signature can wait on a popup the user never sees. Fail with a clear
// message instead of leaving the sign-in spinner running forever.
export const WALLET_SIGNATURE_TIMEOUT_MS = 120_000;

export async function withWalletTimeout<T>(pending: Promise<T>, message: string, ms = WALLET_SIGNATURE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  try { return await Promise.race([pending, timeout]); }
  finally { clearTimeout(timer); }
}

export async function connectedAccounts(): Promise<string[]> {
  const { address } = getAccount(wagmiConfig);
  return address ? [address] : [];
}

export async function connectWalletProvider(): Promise<WalletProvider> {
  if (activeProvider) return activeProvider;
  const account = getAccount(wagmiConfig);
  if (!account.isConnected || !account.connector) throw new Error("Wallet connector is not connected.");
  const provider = await account.connector.getProvider();
  if (!provider || typeof provider !== "object" || !("request" in provider) || typeof provider.request !== "function") {
    throw new Error("The connected wallet did not expose an EVM provider.");
  }
  activeProvider = provider as WalletProvider;
  return activeProvider;
}

export function getConnectedWalletProvider(): WalletProvider | null {
  return activeProvider;
}

export async function disconnectWalletProvider(): Promise<void> {
  activeProvider = null;
  await disconnect(wagmiConfig);
}
