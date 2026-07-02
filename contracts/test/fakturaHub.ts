import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Signer } from "ethers";

const FEED_ID = "0x01464c522f55534400000000000000000000000000";
const abi = ethers.AbiCoder.defaultAbiCoder();

// FLR/USD = 0.02 USD (value 20000, decimals 6)
const RATE = 20_000n;
const DEC = 6;
const GRACE = 120; // seconds

const CENTS_100 = 100n; // $1.00
const FLR = 10n ** 18n;

function encodeFacts(f: {
  invoiceNumber: string;
  debtorTag: string;
  docHash: string;
  amountUsdCents: bigint;
  dueTs: number | bigint;
}) {
  return abi.encode(
    ["tuple(string,string,string,uint256,uint256)"],
    [[f.invoiceNumber, f.debtorTag, f.docHash, f.amountUsdCents, f.dueTs]],
  );
}

function proofFor(encoded: string) {
  return {
    merkleProof: [],
    data: {
      attestationType: ethers.encodeBytes32String("Web2Json"),
      sourceId: ethers.encodeBytes32String("PublicWeb2"),
      votingRound: 0,
      lowestUsedTimestamp: 0,
      requestBody: {
        url: "https://erp.example/invoice",
        httpMethod: "GET",
        headers: "{}",
        queryParams: "{}",
        body: "{}",
        postProcessJq: ".",
        abiSignature: "sig",
      },
      responseBody: { abiEncodedData: encoded },
    },
  };
}

async function now(): Promise<number> {
  const b = await ethers.provider.getBlock("latest");
  return b!.timestamp;
}

describe("FakturaHub", () => {
  let hub: any;
  let ftso: any;
  let fdc: any;
  let admin: Signer, investor: Signer, debtor: Signer, supplier: Signer, rando: Signer;

  beforeEach(async () => {
    [admin, investor, debtor, supplier, rando] = await ethers.getSigners();
    ftso = await (await ethers.getContractFactory("MockFtsoV2")).deploy(RATE, DEC);
    fdc = await (await ethers.getContractFactory("MockFdcVerifier")).deploy();
    hub = await (
      await ethers.getContractFactory("FakturaHub")
    ).deploy(await admin.getAddress(), ftso.target, fdc.target, FEED_ID, GRACE);
  });

  async function registerInvoice(over: Partial<Record<string, unknown>> = {}) {
    const due = (await now()) + 30 * 24 * 3600;
    const facts = {
      invoiceNumber: "INV-1",
      debtorTag: "debtor:acme",
      docHash: `sha256:${Math.random()}`,
      amountUsdCents: CENTS_100,
      dueTs: due,
      ...over,
    };
    const tx = await hub.registerInvoice(
      proofFor(encodeFacts(facts as any)),
      await supplier.getAddress(),
      35,
      300, // 3%
      "memo:beef",
    );
    await tx.wait();
    return Number(await hub.invoiceCount());
  }

  it("full lifecycle: deposit -> register -> fund -> settle -> LP exit with yield", async () => {
    await hub.connect(investor).deposit({ value: 200n * FLR });
    expect(await hub.liquid()).to.equal(200n * FLR);

    const id = await registerInvoice();
    // $1.00 face, 3% discount -> $0.97 advance -> 48.5 FLR at $0.02
    const supplierBefore = await ethers.provider.getBalance(await supplier.getAddress());
    await hub.fundInvoice(id);
    const advance = (97n * FLR) / 2n; // 48.5
    expect(await ethers.provider.getBalance(await supplier.getAddress())).to.equal(
      supplierBefore + advance,
    );
    expect(await hub.deployedCapital()).to.equal(advance);

    // settle at same rate: $1.00 = 50 FLR
    const required = await hub.quoteUsdCentsInFlrWei(100);
    expect(required).to.equal(50n * FLR);
    await hub.connect(debtor).settleInvoice(id, { value: required });

    expect(await hub.deployedCapital()).to.equal(0);
    expect(await hub.liquid()).to.equal(200n * FLR - advance + 50n * FLR);

    // LP exits with principal + 1.5 FLR yield
    const balBefore = await ethers.provider.getBalance(await investor.getAddress());
    const tx = await hub.connect(investor).withdraw(await hub.shares(await investor.getAddress()));
    const rc = await tx.wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    expect(await ethers.provider.getBalance(await investor.getAddress())).to.equal(
      balBefore + 200n * FLR + (3n * FLR) / 2n - gas,
    );
  });

  it("registration is FDC-gated and rejects duplicates", async () => {
    await fdc.set(false);
    const due = (await now()) + 3600;
    await expect(
      hub.registerInvoice(
        proofFor(encodeFacts({ invoiceNumber: "X", debtorTag: "d", docHash: "h", amountUsdCents: 1n, dueTs: due })),
        await supplier.getAddress(),
        10,
        100,
        "m",
      ),
    ).to.be.revertedWithCustomError(hub, "InvalidProof");

    await fdc.set(true);
    await registerInvoice({ docHash: "dup" });
    await expect(registerInvoice({ docHash: "dup" })).to.be.revertedWithCustomError(
      hub,
      "DuplicateDocument",
    );
  });

  it("uses the live FTSO rate at settlement time (FX repricing)", async () => {
    await hub.connect(investor).deposit({ value: 200n * FLR });
    const id = await registerInvoice();
    await hub.fundInvoice(id);

    // price doubles: $0.04/FLR -> $1.00 = 25 FLR
    await ftso.set(40_000n, DEC);
    expect(await hub.quoteUsdCentsInFlrWei(100)).to.equal(25n * FLR);
    await expect(
      hub.connect(debtor).settleInvoice(id, { value: 24n * FLR }),
    ).to.be.revertedWithCustomError(hub, "PaymentTooLow");
    await hub.connect(debtor).settleInvoice(id, { value: 25n * FLR });
    expect((await hub.getInvoice(id)).state).to.equal(3n); // Settled
  });

  it("collector defaults overdue invoices after grace, pool absorbs loss", async () => {
    await hub.connect(investor).deposit({ value: 100n * FLR });
    const due = (await now()) + 600;
    const id = await registerInvoice({ dueTs: due });
    await hub.fundInvoice(id);

    await expect(hub.markDefault(id)).to.be.revertedWithCustomError(hub, "NotDueYet");
    await network.provider.send("evm_increaseTime", [600 + GRACE + 1]);
    await network.provider.send("evm_mine");
    await hub.markDefault(id);

    expect((await hub.getInvoice(id)).state).to.equal(4n); // Defaulted
    expect(await hub.totalDefaultedFlr()).to.equal((97n * FLR) / 2n);
    expect(await hub.poolValue()).to.equal(100n * FLR - (97n * FLR) / 2n);
  });

  it("share price appreciates for late LPs", async () => {
    await hub.connect(investor).deposit({ value: 100n * FLR });
    const id = await registerInvoice({ amountUsdCents: 100n });
    await hub.fundInvoice(id);
    await hub.connect(debtor).settleInvoice(id, { value: await hub.quoteUsdCentsInFlrWei(100) });

    // pool now 101.5 FLR backed by 100 shares; 101.5 FLR mints 100 shares
    await hub.connect(rando).deposit({ value: (203n * FLR) / 2n });
    expect(await hub.shares(await rando.getAddress())).to.equal(100n * FLR);
  });

  it("enforces access control", async () => {
    const due = (await now()) + 3600;
    const proof = proofFor(
      encodeFacts({ invoiceNumber: "X", debtorTag: "d", docHash: "h2", amountUsdCents: 1n, dueTs: due }),
    );
    await expect(
      hub.connect(rando).registerInvoice(proof, await supplier.getAddress(), 1, 1, "m"),
    ).to.be.revertedWithCustomError(hub, "NotAgent");
    await expect(hub.connect(rando).fundInvoice(1)).to.be.revertedWithCustomError(hub, "NotAgent");
    await expect(hub.connect(rando).markDefault(1)).to.be.revertedWithCustomError(hub, "NotCollector");
    await expect(hub.connect(rando).attest("K", 0, "h", "m")).to.be.revertedWithCustomError(hub, "NotAgent");
    await expect(hub.connect(rando).setAgents(await rando.getAddress(), await rando.getAddress()))
      .to.be.revertedWithCustomError(hub, "NotAdmin");
  });

  it("withdrawals are limited to liquid capital", async () => {
    await hub.connect(investor).deposit({ value: 100n * FLR });
    const id = await registerInvoice();
    await hub.fundInvoice(id);
    await expect(
      hub.connect(investor).withdraw(await hub.shares(await investor.getAddress())),
    ).to.be.revertedWithCustomError(hub, "InsufficientLiquidity");
    await hub.connect(investor).withdraw(2n * FLR);
  });

  it("records attestations", async () => {
    await hub.attest("UNDERWRITE_REJECT", 0, "sha256:x", "claude-sonnet-4-5");
    const a = await hub.getAttestation(1);
    expect(a.kind).to.equal("UNDERWRITE_REJECT");
    expect(await hub.attestationCount()).to.equal(1n);
  });
});
