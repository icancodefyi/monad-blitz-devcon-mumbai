// Deploys DONADS contracts to Monad Testnet with a dedicated testnet deployer.
// Usage (from contracts/): npm run deploy:testnet
// Requires DEPLOYER_PRIVATE_KEY in contracts/.env (git-ignored). Testnet only:
// this script refuses to run against any chain except 10143.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const envPath = join(root, ".env");
if (!existsSync(envPath)) throw new Error("contracts/.env is missing. Create it with DEPLOYER_PRIVATE_KEY.");
const env = Object.fromEntries(readFileSync(envPath, "utf8").split("\n").filter((line) => line.includes("=") && !line.startsWith("#")).map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]));
if (!env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY is not set in contracts/.env.");

const rpcUrl = env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz";
const monadTestnet = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: monadTestnet, transport: http(rpcUrl) });

const chainId = await publicClient.getChainId();
if (chainId !== 10143) throw new Error(`Refusing to deploy: RPC reports chain ${chainId}, expected Monad Testnet 10143.`);

const artifactDir = join(root, "hardhat-artifacts", "src");
function artifact(name) {
  const dir = join(artifactDir, `${name}.sol`);
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`Missing ${file}. Run npm run compile first.`);
  return JSON.parse(readFileSync(file, "utf8"));
}

const balance = await publicClient.getBalance({ address: account.address });
console.log(`Deployer ${account.address} balance: ${formatEther(balance)} MON`);
if (balance === 0n) throw new Error("Deployer has no MON. Fund it from the Monad Testnet faucet first.");

const vault = artifact("DonadsPolicyVault");
const hash = await walletClient.deployContract({ abi: vault.abi, bytecode: vault.bytecode, args: [] });
console.log(`Policy vault deployment submitted: ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Policy vault deployment failed.");

const deployment = {
  network: "Monad Testnet",
  chain_id: 10143,
  deployer: account.address,
  deployed_at: new Date().toISOString(),
  contracts: {
    DonadsPolicyVault: { address: receipt.contractAddress, transaction_hash: hash, block_number: Number(receipt.blockNumber) },
  },
  explorer: "https://testnet.monadscan.com",
};
const outDir = join(root, "deployments");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "testnet.json"), JSON.stringify(deployment, null, 2) + "\n");
console.log(`DonadsPolicyVault: ${receipt.contractAddress}`);
console.log(`Explorer: https://testnet.monadscan.com/address/${receipt.contractAddress}`);
console.log("Saved to contracts/deployments/testnet.json");
