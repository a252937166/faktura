import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

function personaKey(name: string): string | undefined {
  const p = path.join(__dirname, "..", "keys", `${name}.key`);
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
}

const accounts = ["agent", "investor", "debtor"]
  .map(personaKey)
  .filter((k): k is string => Boolean(k));

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.25",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    coston2: {
      url: process.env.COSTON2_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc",
      chainId: 114,
      accounts,
    },
  },
  etherscan: {
    apiKey: { coston2: "coston2" },
    customChains: [
      {
        network: "coston2",
        chainId: 114,
        urls: {
          apiURL: "https://coston2-explorer.flare.network/api",
          browserURL: "https://coston2-explorer.flare.network",
        },
      },
    ],
  },
  sourcify: { enabled: false },
};

export default config;
