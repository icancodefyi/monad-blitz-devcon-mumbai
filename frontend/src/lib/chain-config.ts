export const MONAD_TESTNET = {
  name: "Monad Testnet",
  chainId: 10_143,
  chainIdHex: "0x279f",
  symbol: "MON",
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorerUrl: "https://testnet.monadscan.com",
} as const;

export function testnetTransactionUrl(hash: string): string {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error("A valid Monad transaction hash is required.");
  return `${MONAD_TESTNET.explorerUrl}/tx/${hash.toLowerCase()}`;
}
