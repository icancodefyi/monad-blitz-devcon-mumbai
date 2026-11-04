import { randomUUID } from "node:crypto";
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress } from "viem";

import { encodeErc20Approval, formatTokenAmount, monadRpc, readErc20Balance, readErc20Metadata, tokenAmountToAtomic } from "@/server/monad";

export const MONAD_TESTNET_UNISWAP = {
  quoterV2: "0x1b4e313fef15630af3e6f2de550dbf4cc9d3081d",
  swapRouter02: "0x4c4eabd5fb1d1a7234a48692551eaecff8194ca7",
  source: "https://developers.uniswap.org/deployments.json",
} as const;

const feeTiers = [100, 500, 3_000, 10_000] as const;

const quoterAbi = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" }, { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }],
}] as const;

const routerAbi = [{
  type: "function", name: "exactInputSingle", stateMutability: "payable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }], outputs: [{ name: "amountOut", type: "uint256" }],
}] as const;

type RawQuote = { amountOut: bigint; fee: number; gasEstimate: bigint };

export async function assertUniswapAdapterDeployed(): Promise<void> {
  const [quoterCode, routerCode] = await Promise.all([
    monadRpc("eth_getCode", [MONAD_TESTNET_UNISWAP.quoterV2, "latest"]),
    monadRpc("eth_getCode", [MONAD_TESTNET_UNISWAP.swapRouter02, "latest"]),
  ]);
  if (!quoterCode || quoterCode === "0x" || !routerCode || routerCode === "0x") {
    throw new Error("Uniswap’s official Monad Testnet addresses have no bytecode on the current testnet state. The DEX adapter is disabled until the official deployment feed and chain state agree.");
  }
}

async function quoteAtFee(tokenIn: string, tokenOut: string, amountIn: bigint, fee: number): Promise<RawQuote | null> {
  const data = encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: tokenIn as `0x${string}`, tokenOut: tokenOut as `0x${string}`, amountIn, fee, sqrtPriceLimitX96: BigInt(0) }] });
  try {
    const result = String(await monadRpc("eth_call", [{ to: MONAD_TESTNET_UNISWAP.quoterV2, data }, "latest"])) as `0x${string}`;
    const decoded = decodeFunctionResult({ abi: quoterAbi, functionName: "quoteExactInputSingle", data: result });
    return { amountOut: decoded[0], fee, gasEstimate: decoded[3] };
  } catch {
    return null;
  }
}

async function bestQuote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<RawQuote> {
  const quotes = (await Promise.all(feeTiers.map((fee) => quoteAtFee(tokenIn, tokenOut, amountIn, fee)))).filter((quote): quote is RawQuote => quote !== null && quote.amountOut > BigInt(0));
  quotes.sort((left, right) => left.amountOut > right.amountOut ? -1 : left.amountOut < right.amountOut ? 1 : 0);
  if (!quotes[0]) throw new Error("No active Uniswap v3 pool returned a quote for this token pair on Monad Testnet.");
  return quotes[0];
}

export function minimumOutput(amountOut: bigint, slippageBps: number): bigint {
  return amountOut * BigInt(10_000 - slippageBps) / BigInt(10_000);
}

export function priceImpactBps(amountOut: bigint, referenceOut: bigint, amountIn: bigint, referenceIn: bigint): number {
  if (amountOut <= BigInt(0) || referenceOut <= BigInt(0) || amountIn <= BigInt(0) || referenceIn <= BigInt(0)) return 10_000;
  const scaledReference = referenceOut * amountIn / referenceIn;
  if (scaledReference <= amountOut) return 0;
  return Number((scaledReference - amountOut) * BigInt(10_000) / scaledReference);
}

export type UniswapQuote = {
  adapter: "uniswap-v3";
  chain_id: 10143;
  token_in: { contract: string; symbol: string; decimals: number; amount: string; amount_atomic: string };
  token_out: { contract: string; symbol: string; decimals: number; quoted_amount: string; quoted_amount_atomic: string; minimum_amount: string; minimum_amount_atomic: string };
  fee: number;
  slippage_bps: number;
  estimated_price_impact_bps: number;
  gas_estimate: string;
  quoter: string;
  router: string;
  approval_calldata: string;
  swap_calldata: string;
  simulation: "quoted";
  blocked: boolean;
  blocked_reason: string | null;
  source: string;
  quote_id: string;
  quoted_at_ms: number;
  expires_at_ms: number;
  input_balance_before_atomic: string;
  output_balance_before_atomic: string;
  execution?: { approval_transaction_hash: string; swap_transaction_hash: string; block_number: number; output_amount_atomic: string; confirmed_at_ms: number };
};

export async function quoteUniswapSwap(input: { tokenIn: string; tokenOut: string; amount: string; recipient: string; slippageBps: number; maxPriceImpactBps: number }): Promise<UniswapQuote> {
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 200) throw new Error("Maximum slippage must be between 0.01% and 2.00%.");
  if (!Number.isInteger(input.maxPriceImpactBps) || input.maxPriceImpactBps < 1 || input.maxPriceImpactBps > 500) throw new Error("Maximum price impact must be between 0.01% and 5.00%.");
  if (!isAddress(input.recipient)) throw new Error("Swap recipient must be a valid EVM address.");
  await assertUniswapAdapterDeployed();
  const [tokenIn, tokenOut] = await Promise.all([readErc20Metadata(input.tokenIn), readErc20Metadata(input.tokenOut)]);
  if (tokenIn.contract === tokenOut.contract) throw new Error("Input and output tokens must differ.");
  const amountIn = tokenAmountToAtomic(input.amount, tokenIn.decimals);
  const [quote, inputBalanceBefore, outputBalanceBefore] = await Promise.all([
    bestQuote(tokenIn.contract, tokenOut.contract, amountIn),
    readErc20Balance(tokenIn.contract, input.recipient),
    readErc20Balance(tokenOut.contract, input.recipient),
  ]);
  if (inputBalanceBefore < amountIn) throw new Error(`Wallet has insufficient ${tokenIn.symbol} for this swap.`);
  const referenceIn = amountIn / BigInt(100) > BigInt(0) ? amountIn / BigInt(100) : amountIn;
  const reference = await quoteAtFee(tokenIn.contract, tokenOut.contract, referenceIn, quote.fee) ?? quote;
  const impact = priceImpactBps(quote.amountOut, reference.amountOut, amountIn, referenceIn);
  const minOut = minimumOutput(quote.amountOut, input.slippageBps);
  const blocked = impact > input.maxPriceImpactBps;
  const blockedReason = blocked ? `Blocked because estimated price impact is ${(impact / 100).toFixed(2)}%, above your ${(input.maxPriceImpactBps / 100).toFixed(2)}% policy.` : null;
  const swapCalldata = encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: tokenIn.contract as `0x${string}`, tokenOut: tokenOut.contract as `0x${string}`, fee: quote.fee, recipient: getAddress(input.recipient), amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: BigInt(0) }] });
  const quotedAt = Date.now();
  return {
    adapter: "uniswap-v3", chain_id: 10143,
    token_in: { ...tokenIn, amount: input.amount, amount_atomic: amountIn.toString() },
    token_out: { ...tokenOut, quoted_amount: formatTokenAmount(quote.amountOut, tokenOut.decimals), quoted_amount_atomic: quote.amountOut.toString(), minimum_amount: formatTokenAmount(minOut, tokenOut.decimals), minimum_amount_atomic: minOut.toString() },
    fee: quote.fee, slippage_bps: input.slippageBps, estimated_price_impact_bps: impact, gas_estimate: quote.gasEstimate.toString(),
    quoter: MONAD_TESTNET_UNISWAP.quoterV2, router: MONAD_TESTNET_UNISWAP.swapRouter02,
    approval_calldata: encodeErc20Approval(MONAD_TESTNET_UNISWAP.swapRouter02, amountIn),
    swap_calldata: swapCalldata, simulation: "quoted", blocked, blocked_reason: blockedReason, source: MONAD_TESTNET_UNISWAP.source,
    quote_id: randomUUID(), quoted_at_ms: quotedAt, expires_at_ms: quotedAt + 10 * 60 * 1_000,
    input_balance_before_atomic: inputBalanceBefore.toString(), output_balance_before_atomic: outputBalanceBefore.toString(),
  };
}
