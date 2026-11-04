import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
} from "viem";

const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export async function monadRpc(method: string, params: unknown[]): Promise<unknown> {
  const endpoint = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Monad RPC returned HTTP ${response.status}.`);
  const payload = await response.json() as { result?: unknown; error?: { message?: string } };
  if (payload.error) throw new Error(payload.error.message ?? "Monad RPC rejected the request.");
  return payload.result;
}

async function call(contract: string, data: `0x${string}`): Promise<`0x${string}`> {
  return String(await monadRpc("eth_call", [{ to: contract, data }, "latest"])) as `0x${string}`;
}

export type Erc20Metadata = {
  contract: string;
  symbol: string;
  decimals: number;
};

export async function readErc20Metadata(contract: string): Promise<Erc20Metadata> {
  if (!isAddress(contract)) throw new Error("Token contract must be a valid EVM address.");
  const normalized = getAddress(contract).toLowerCase();
  const code = String(await monadRpc("eth_getCode", [normalized, "latest"]));
  if (!code || code === "0x" || code === "0x0") throw new Error("Token address has no contract code on Monad Testnet.");
  const [symbolResult, decimalsResult] = await Promise.all([
    call(normalized, encodeFunctionData({ abi: erc20Abi, functionName: "symbol" })),
    call(normalized, encodeFunctionData({ abi: erc20Abi, functionName: "decimals" })),
  ]);
  const symbol = decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data: symbolResult }).trim();
  const decimals = Number(decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: decimalsResult }));
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(symbol)) throw new Error("Token symbol is missing or unsafe to display.");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Token decimals are outside the supported range 0–36.");
  return { contract: normalized, symbol, decimals };
}

export async function readErc20Balance(contract: string, account: string): Promise<bigint> {
  if (!isAddress(contract) || !isAddress(account)) throw new Error("Token balance requires valid contract and wallet addresses.");
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(account)] });
  const result = await call(getAddress(contract), data);
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result });
}

export async function readErc20Allowance(contract: string, owner: string, spender: string): Promise<bigint> {
  if (!isAddress(contract) || !isAddress(owner) || !isAddress(spender)) throw new Error("Token allowance requires valid contract and wallet addresses.");
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [getAddress(owner), getAddress(spender)] });
  const result = await call(getAddress(contract), data);
  return decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: result });
}

export function tokenAmountToAtomic(amount: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error("Token amount must be a positive decimal.");
  const fraction = amount.split(".")[1] ?? "";
  if (fraction.length > decimals) throw new Error(`Token amount supports at most ${decimals} decimal places.`);
  return parseUnits(amount, decimals);
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals);
}

export function encodeErc20Transfer(recipient: string, amountAtomic: bigint): `0x${string}` {
  if (!isAddress(recipient) || amountAtomic <= BigInt(0)) throw new Error("ERC-20 transfer values are invalid.");
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(recipient), amountAtomic] });
}

export function encodeErc20Approval(spender: string, amountAtomic: bigint): `0x${string}` {
  if (!isAddress(spender) || amountAtomic <= BigInt(0)) throw new Error("ERC-20 approval values are invalid.");
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(spender), amountAtomic] });
}
