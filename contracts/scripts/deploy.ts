import { ethers, network } from "hardhat";

/**
 * Deploys FakturaHub to Coston2 with live Flare protocol addresses resolved
 * from the FlareContractRegistry (same address on every Flare network), plus
 * the DemoFXRP settlement token wired to the live XRP/USD FTSOv2 feed.
 *
 *   npx hardhat run scripts/deploy.ts --network coston2
 *
 * On mainnet, point configureTokenSettlement at canonical FXRP instead of
 * deploying DemoFXRP.
 */
const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const FLR_USD_FEED_ID = "0x01464c522f55534400000000000000000000000000";
const XRP_USD_FEED_ID = "0x015852502f55534400000000000000000000000000";
const GRACE_SECONDS = Number(process.env.FAKTURA_GRACE_SECONDS ?? 120);
/**
 * Pinned supplier system-of-record prefix for FDC-attested registrations.
 * Served by GitHub Pages (docs/ → https://a252937166.github.io/faktura/):
 * the FDC Web2Json verifier requires Content-Type application/json, which
 * Pages provides and raw.githubusercontent.com does not.
 */
const ERP_URL_PREFIX =
  process.env.FAKTURA_ERP_URL_PREFIX ?? "https://a252937166.github.io/faktura/erp/";

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

  // Interoperable settlement leg: DemoFXRP priced by the live XRP/USD feed.
  // Reuse an existing token (FAKTURA_FXRP) so several hubs share one asset.
  let fxrpAddress = process.env.FAKTURA_FXRP ?? "";
  if (fxrpAddress) {
    console.log(`DemoFXRP reused:    ${fxrpAddress}`);
  } else {
    const Fxrp = await ethers.getContractFactory("DemoFXRP");
    const fxrp = await Fxrp.deploy();
    await fxrp.waitForDeployment();
    fxrpAddress = await fxrp.getAddress();
    console.log(`DemoFXRP deployed:  ${fxrpAddress}`);
  }
  await (await hub.configureTokenSettlement(fxrpAddress, XRP_USD_FEED_ID, 6)).wait();

  // Pin FDC-attested registrations to the supplier system of record.
  await (await hub.setErpUrlPrefix(ERP_URL_PREFIX)).wait();
  console.log(`erpUrlPrefix:       ${ERP_URL_PREFIX}`);

  // Smoke: read both live FTSO feeds through the hub.
  const oneUsdInFlr = await hub.quoteUsdCentsInFlrWei(100);
  console.log(`FTSOv2 live: $1.00 = ${ethers.formatEther(oneUsdInFlr)} FLR`);
  const oneUsdInFxrp = await hub.quoteUsdCentsInToken(100);
  console.log(`FTSOv2 live: $1.00 = ${ethers.formatUnits(oneUsdInFxrp, 6)} FXRP`);

  console.log(`maxFeedAgeSeconds:  ${await hub.maxFeedAgeSeconds()} (FTSOv2 freshness guard)`);
  const policy = await hub.riskPolicy();
  console.log(
    `on-chain risk policy: maxRisk ${policy.maxRiskScore}, discount ${policy.minDiscountBps}-${policy.maxDiscountBps} bps, ` +
      `exposure ${policy.maxAdvanceBpsOfLiquid} bps of liquid, tenor ≤ ${Number(policy.maxTenorSeconds) / 86400}d`,
  );

  console.log(`\nSet in .env:\nFAKTURA_CONTRACT=${address}\nFAKTURA_FXRP=${fxrpAddress}`);
  console.log(
    `\nVerify sources on the explorer:\n` +
      `npx hardhat verify --network coston2 ${address} ${agent.address} ${ftsoV2} ${fdcVerification} ${FLR_USD_FEED_ID} ${GRACE_SECONDS}\n` +
      `npx hardhat verify --network coston2 ${fxrpAddress}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
