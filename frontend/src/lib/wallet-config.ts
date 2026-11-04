import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { metaMaskWallet } from "@rainbow-me/rainbowkit/wallets";
import { defineChain, http } from "viem";
import { mainnet } from "wagmi/chains";

import { MONAD_TESTNET } from "@/lib/chain-config";

export const monadTestnet = defineChain({
  id: MONAD_TESTNET.chainId,
  name: MONAD_TESTNET.name,
  nativeCurrency: { name: "Monad", symbol: MONAD_TESTNET.symbol, decimals: 18 },
  rpcUrls: {
    default: { http: [MONAD_TESTNET.rpcUrl] },
  },
  blockExplorers: {
    default: { name: "MonadScan", url: MONAD_TESTNET.explorerUrl },
  },
  testnet: true,
});

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "donads-rainbowkit-not-configured";

export const wagmiConfig = getDefaultConfig({
  appName: "DONADS",
  appDescription: "Approval-gated autonomous work on Monad",
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "https://donads.vercel.app",
  appIcon: "/brand/donads-mascot-tile.png",
  projectId,
  // Identity is chain-agnostic. Let a wallet connect on its normal EVM chain;
  // financial actions still switch to and verify Monad Testnet explicitly.
  chains: [mainnet, monadTestnet],
  transports: {
    [mainnet.id]: http("https://cloudflare-eth.com"),
    [monadTestnet.id]: http(MONAD_TESTNET.rpcUrl),
  },
  wallets: [
    {
      groupName: "Available wallets",
      // MetaMask only. No QR/WalletConnect and no other wallets.
      wallets: [metaMaskWallet],
    },
  ],
  ssr: true,
});
