"use client";

import { RainbowKitProvider, lightTheme, useConnectModal } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletCards } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAccount, WagmiProvider } from "wagmi";

import { registerWalletChooser } from "@/lib/wallet-provider";
import { wagmiConfig } from "@/lib/wallet-config";

export function WalletAppProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          modalSize="compact"
          theme={lightTheme({
            accentColor: "#402e25",
            accentColorForeground: "#ffffff",
            borderRadius: "medium",
            fontStack: "system",
            overlayBlur: "small",
          })}
        >
          <WalletChooserBridge />
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function WalletChooserBridge() {
  const { openConnectModal } = useConnectModal();

  useEffect(() => registerWalletChooser(openConnectModal), [openConnectModal]);
  return null;
}

export function WalletConnectControl({
  signedInWallet,
  signingIn,
  onConnected,
  onManage,
}: {
  signedInWallet: string | null;
  signingIn: boolean;
  onConnected: (address: string) => void;
  onManage: () => void;
}) {
  const { address, status } = useAccount();
  const { openConnectModal } = useConnectModal();
  const notifiedAddress = useRef<string | null>(null);
  const connected = status === "connected" && Boolean(address);

  useEffect(() => {
    if (!connected || !address) {
      notifiedAddress.current = null;
      return;
    }
    if (signedInWallet?.toLowerCase() === address.toLowerCase()) return;
    if (notifiedAddress.current === address.toLowerCase()) return;
    notifiedAddress.current = address.toLowerCase();
    onConnected(address);
  }, [address, connected, onConnected, signedInWallet]);

  const displayAddress = signedInWallet ?? address ?? null;
  const label = signingIn
    ? "Signing in…"
    : displayAddress
      ? `${displayAddress.slice(0, 6)}…${displayAddress.slice(-4)}`
      : "Connect wallet";

  return (
    <button
      type="button"
      aria-label={displayAddress ? "Manage connected wallet" : "Connect wallet"}
      aria-busy={signingIn}
      onClick={() => {
        if (signingIn) return;
        if (signedInWallet) onManage();
        else if (connected && address) onConnected(address);
        else openConnectModal?.();
      }}
      disabled={signingIn || (!connected && !openConnectModal)}
      className="grid size-10 shrink-0 place-items-center rounded-full border border-border text-xs font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-px disabled:opacity-60 sm:flex sm:w-auto sm:gap-2 sm:px-3"
    >
      <WalletCards className="size-4" aria-hidden="true" />
      <span className={displayAddress ? "hidden sm:inline" : "donads-wallet-label"}>{label}</span>
    </button>
  );
}
