import { ethers, network } from "hardhat";

/**
 * Deploys FakturaHub to Coston2 with live Flare protocol addresses resolved
 * from the FlareContractRegistry (same address on every Flare network).
 *
 *   npx hardhat run scripts/deploy.ts --network coston2
 */
const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const FLR_USD_FEED_ID = "0x01464c522f55534400000000000000000000000000";
const GRACE_SECONDS = Number(process.env.FAKTURA_GRACE_SECONDS ?? 120);

const REGISTRY_ABI = [
  "function getContractAddressByName(string _name) external view returns (address)",
];

async function main() {
  const [agent] = await ethers.getSigners();
  console.log(`network: ${network.name}, deployer/agent: ${agent.address}`);
  console.log(`balance: ${ethers.formatEther(await ethers.provider.getBalance(agent.address))} C2FLR`);

  const registry = new ethers.Contract(FLARE_CONTRACT_REGISTRY, REGISTRY_ABI, agent);
  const ftsoV2 = await registry.getContractAddressByName("FtsoV2");
  const fdcVerification = await registry.getContractAddressByName("FdcVerification");
  console.log(`FtsoV2:          ${ftsoV2}`);
  console.log(`FdcVerification: ${fdcVerification}`);

  const Hub = await ethers.getContractFactory("FakturaHub");
  const hub = await Hub.deploy(agent.address, ftsoV2, fdcVerification, FLR_USD_FEED_ID, GRACE_SECONDS);
  await hub.waitForDeployment();
  const address = await hub.getAddress();
  console.log(`FakturaHub deployed: ${address}`);

  // Smoke: read the live FTSO rate through the hub.
  const oneUsdInFlr = await hub.quoteUsdCentsInFlrWei(100);
  console.log(`FTSOv2 live: $1.00 = ${ethers.formatEther(oneUsdInFlr)} FLR`);

  console.log(`\nSet in .env:\nFAKTURA_CONTRACT=${address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
