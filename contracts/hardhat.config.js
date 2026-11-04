import { defineConfig } from "hardhat/config";

export default defineConfig({
  paths: {
    sources: "./src",
    tests: {
      solidity: "./test",
    },
    cache: "./hardhat-cache",
    artifacts: "./hardhat-artifacts",
  },
  solidity: {
    version: "0.8.24",
    preferWasm: true,
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  test: {
    solidity: {
      isolate: true,
    },
  },
});
