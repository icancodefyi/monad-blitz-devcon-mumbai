import { beforeEach, describe, expect, it, vi } from "vitest";

const wagmiMocks = vi.hoisted(() => ({ disconnect: vi.fn(), getAccount: vi.fn(), switchChain: vi.fn() }));

vi.mock("@wagmi/core", () => ({
  disconnect: wagmiMocks.disconnect,
  getAccount: wagmiMocks.getAccount,
  switchChain: wagmiMocks.switchChain,
}));

vi.mock("@/lib/wallet-config", () => ({ wagmiConfig: {}, monadTestnet: { id: 10143 } }));

import { connectedAccounts, connectWalletProvider, disconnectWalletProvider, ensureMonadTestnet, openWalletChooser, registerWalletChooser, walletConnectionMessage } from "./wallet-provider";

describe("RainbowKit wallet lifecycle", () => {
  beforeEach(async () => {
    wagmiMocks.disconnect.mockReset().mockResolvedValue(undefined);
    wagmiMocks.getAccount.mockReset();
    await disconnectWalletProvider();
  });

  it("uses the EIP-1193 provider selected by the active Wagmi connector", async () => {
    const provider = { request: vi.fn(async () => []) };
    wagmiMocks.getAccount.mockReturnValue({ isConnected: true, connector: { getProvider: vi.fn(async () => provider) } });

    await expect(connectWalletProvider()).resolves.toBe(provider);
  });

  it("fails clearly when no RainbowKit wallet is connected", async () => {
    wagmiMocks.getAccount.mockReturnValue({ isConnected: false, connector: undefined });
    await expect(connectWalletProvider()).rejects.toThrow("Wallet connector is not connected");
  });

  it("opens the registered RainbowKit chooser without creating a QR lifecycle", () => {
    const open = vi.fn();
    const unregister = registerWalletChooser(open);

    openWalletChooser();
    expect(open).toHaveBeenCalledOnce();
    unregister();
  });

  it("disconnects through Wagmi and clears the selected provider", async () => {
    await disconnectWalletProvider();
    expect(wagmiMocks.disconnect).toHaveBeenCalled();
  });
});

describe("Monad network enforcement", () => {
  beforeEach(() => { wagmiMocks.switchChain.mockReset(); wagmiMocks.getAccount.mockReset(); });

  it("translates chain namespace errors into a recoverable Monad message", () => {
    expect(walletConnectionMessage(new Error("Missing or invalid request() chainId: eip155:10143"))).toMatch(/Monad-compatible wallet.*chain 10143/i);
  });

  it("does nothing when the wallet is already on Monad Testnet", async () => {
    wagmiMocks.getAccount.mockReturnValue({ chainId: 10143 });
    await expect(ensureMonadTestnet()).resolves.toBeUndefined();
    expect(wagmiMocks.switchChain).not.toHaveBeenCalled();
  });

  it("switches through wagmi, which adds the chain when the wallet lacks it", async () => {
    wagmiMocks.getAccount.mockReturnValue({ chainId: 1 });
    wagmiMocks.switchChain.mockResolvedValueOnce(undefined);
    await expect(ensureMonadTestnet()).resolves.toBeUndefined();
    expect(wagmiMocks.switchChain).toHaveBeenCalledWith({}, { chainId: 10143 });
  });

  it("explains when the wallet did not switch to Monad Testnet", async () => {
    wagmiMocks.getAccount.mockReturnValue({ chainId: 1 });
    wagmiMocks.switchChain.mockRejectedValueOnce(new Error("Unsupported chain"));
    await expect(ensureMonadTestnet()).rejects.toThrow("did not switch to Monad Testnet");
  });

  it("preserves an explicit user rejection", async () => {
    wagmiMocks.getAccount.mockReturnValue({ chainId: 1 });
    wagmiMocks.switchChain.mockRejectedValueOnce(new Error("User rejected the request."));
    await expect(ensureMonadTestnet()).rejects.toThrow("Wallet approval was declined");
  });
});

describe("connected accounts", () => {
  it("returns the account wagmi reports as connected", async () => {
    wagmiMocks.getAccount.mockReturnValue({ address: "0x1111111111111111111111111111111111111111" });
    await expect(connectedAccounts()).resolves.toEqual(["0x1111111111111111111111111111111111111111"]);
  });

  it("returns no accounts when nothing is connected", async () => {
    wagmiMocks.getAccount.mockReturnValue({ address: undefined });
    await expect(connectedAccounts()).resolves.toEqual([]);
  });
});
