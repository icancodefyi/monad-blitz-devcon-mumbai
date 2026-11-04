// Deploys DonadsPolicyVault to Monad MAINNET (chain 143). It deploys no funds
// and sends nothing else. Refuses to run unless the RPC reports chain 143 and
// you pass CONFIRM_MAINNET=yes. Usage (from contracts/):
//   CONFIRM_MAINNET=yes npm run deploy:mainnet
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.CONFIRM_MAINNET !== "yes") throw new Error("This deploys to Monad MAINNET with real MON. Re-run with CONFIRM_MAINNET=yes to continue.");
const envPath = join(root, ".env.mainnet");
if (!existsSync(envPath)) throw new Error("contracts/.env.mainnet is missing.");
const env = Object.fromEntries(readFileSync(envPath, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
if (!env.MAINNET_DEPLOYER_PRIVATE_KEY) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY is not set.");

const rpcUrl = env.MONAD_MAINNET_RPC_URL || "https://rpc.monad.xyz";
const mainnet = defineChain({ id: 143, name: "Monad Mainnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const account = privateKeyToAccount(env.MAINNET_DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: mainnet, transport: http(rpcUrl) });

const chainId = await publicClient.getChainId();
if (chainId !== 143) throw new Error(`Refusing to deploy: RPC reports chain ${chainId}, expected Monad Mainnet 143.`);

const artifact = JSON.parse(readFileSync(join(root, "hardhat-artifacts", "src", "DonadsPolicyVault.sol", "DonadsPolicyVault.json"), "utf8"));
const balance = await publicClient.getBalance({ address: account.address });
const gas = await publicClient.estimateGas({ account: account.address, data: artifact.bytecode });
const gasPrice = await publicClient.getGasPrice();
const needed = gas * gasPrice;
console.log(`Deployer ${account.address} balance ${formatEther(balance)} MON; deployment needs about ${formatEther(needed)} MON`);
if (balance < needed) throw new Error("Not enough MON for the deployment. Fund the deployer first.");

const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [] });
console.log(`Deployment submitted: ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deployment failed.");

const record = { network: "Monad Mainnet", chain_id: 143, deployer: account.address, deployed_at: new Date().toISOString(), contracts: { DonadsPolicyVault: { address: receipt.contractAddress, transaction_hash: hash, block_number: Number(receipt.blockNumber) } }, explorer: "https://monadscan.com" };
mkdirSync(join(root, "deployments"), { recursive: true });
writeFileSync(join(root, "deployments", "mainnet.json"), JSON.stringify(record, null, 2) + "\n");
console.log(`DonadsPolicyVault (mainnet): ${receipt.contractAddress}`);
console.log(`Explorer: https://monadscan.com/address/${receipt.contractAddress}`);
