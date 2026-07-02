// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IWeb2Json} from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";

/// @dev Minimal view interface over Flare FTSOv2 (TestFtsoV2Interface shape).
interface IFtsoV2Reader {
    function getFeedById(
        bytes21 _feedId
    ) external view returns (uint256 value, int8 decimals, uint64 timestamp);
}

/// @dev Minimal interface over Flare FdcVerification for Web2Json proofs.
interface IFdcProofVerifier {
    function verifyWeb2Json(IWeb2Json.Proof calldata _proof) external view returns (bool);
}

/// @dev Invoice facts attested by the Flare Data Connector (Web2Json) from the
/// supplier's system of record. Field order must match the `abiSignature`
/// used in the attestation request.
struct InvoiceFacts {
    string invoiceNumber;
    string debtorTag;
    string docHash;
    uint256 amountUsdCents;
    uint256 dueTs; // unix seconds
}

/// @title FakturaHub — the autonomous invoice-financing desk on Flare.
/// @notice One hub combining:
///  - an RWA registry of USD-denominated receivables whose registration is
///    gated by an FDC Web2Json attestation (the AI agent cannot invent
///    invoices: every one must be provably read from an external system of
///    record through Flare's enshrined data protocol);
///  - a native-FLR liquidity pool that funds invoices at an AI-priced
///    discount, converting USD face values to FLR at the live FTSOv2
///    FLR/USD rate at both funding and settlement;
///  - an agent permission layer (underwriter / collector keys);
///  - an on-chain attestation log anchoring the hash of every AI decision
///    memo, making autonomous underwriting auditable.
contract FakturaHub {
    // ------------------------------------------------------------------
    // Roles & config
    // ------------------------------------------------------------------
    address public admin;
    address public agent;
    address public collector;

    IFtsoV2Reader public ftso;
    IFdcProofVerifier public fdcVerifier;
    bytes21 public feedId; // FLR/USD
    uint64 public graceSeconds;
    /// @notice FDC gating is always on in production; the admin toggle exists
    /// so the demo survives testnet attestation outages (state is public and
    /// every toggle is evented for transparency).
    bool public fdcEnforced = true;

    // ------------------------------------------------------------------
    // Invoices
    // ------------------------------------------------------------------
    enum State {
        None,
        Listed,
        Funded,
        Settled,
        Defaulted
    }

    struct Invoice {
        uint64 id;
        address supplier;
        string invoiceNumber;
        string debtorTag;
        string docHash;
        uint256 faceUsdCents;
        uint64 dueTs;
        uint16 riskScore; // 0-100, AI
        uint16 discountBps; // AI-priced pool fee
        string decisionHash; // sha256 of the AI decision memo
        State state;
        uint256 advanceFlrWei; // paid to supplier at funding
        uint256 fundRateValue; // FTSO snapshot at funding
        int8 fundRateDecimals;
        uint256 settledFlrWei;
        uint64 registeredTs;
        uint64 fundedTs;
        uint64 closedTs;
    }

    uint64 public invoiceCount;
    mapping(uint64 => Invoice) private _invoices;
    mapping(bytes32 => bool) public usedDocHashes;

    // ------------------------------------------------------------------
    // Liquidity pool (native FLR)
    // ------------------------------------------------------------------
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    uint256 public liquid; // un-deployed FLR
    uint256 public deployedCapital; // FLR locked in funded invoices
    uint256 public totalFundedFlr;
    uint256 public totalSettledFlr;
    uint256 public totalDefaultedFlr;

    // ------------------------------------------------------------------
    // Agent attestations
    // ------------------------------------------------------------------
    struct AgentAttestation {
        uint64 id;
        address actor;
        string kind; // e.g. UNDERWRITE_APPROVE / UNDERWRITE_REJECT / DEFAULT_FLAG
        uint64 subjectId;
        string payloadHash;
        string model;
        uint64 ts;
    }

    uint64 public attestationCount;
    mapping(uint64 => AgentAttestation) private _attestations;

    // ------------------------------------------------------------------
    // Events & errors
    // ------------------------------------------------------------------
    event Deposited(address indexed investor, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed investor, uint256 amount, uint256 sharesBurned);
    event InvoiceRegistered(
        uint64 indexed id,
        address indexed supplier,
        string invoiceNumber,
        uint256 faceUsdCents,
        uint16 riskScore,
        uint16 discountBps,
        string decisionHash
    );
    event InvoiceFunded(
        uint64 indexed id,
        uint256 advanceFlrWei,
        uint256 rateValue,
        int8 rateDecimals
    );
    event InvoiceSettled(uint64 indexed id, uint256 paidFlrWei, int256 poolYieldFlrWei);
    event InvoiceDefaulted(uint64 indexed id, uint256 lossFlrWei);
    event AgentAttested(
        uint64 indexed id,
        address indexed actor,
        string kind,
        uint64 subjectId,
        string payloadHash
    );
    event FdcEnforcementSet(bool enforced);
    event AgentsRotated(address agent, address collector);

    error NotAdmin();
    error NotAgent();
    error NotCollector();
    error InvalidProof();
    error DuplicateDocument();
    error InvalidState();
    error InvalidParams();
    error InsufficientLiquidity();
    error InsufficientShares();
    error PaymentTooLow();
    error NotDueYet();
    error StaleRate();
    error ZeroAmount();

    // ------------------------------------------------------------------

    constructor(
        address _agent,
        IFtsoV2Reader _ftso,
        IFdcProofVerifier _fdcVerifier,
        bytes21 _feedId,
        uint64 _graceSeconds
    ) {
        admin = msg.sender;
        agent = _agent;
        collector = _agent;
        ftso = _ftso;
        fdcVerifier = _fdcVerifier;
        feedId = _feedId;
        graceSeconds = _graceSeconds;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }
    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }
    modifier onlyCollector() {
        if (msg.sender != collector) revert NotCollector();
        _;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setAgents(address _agent, address _collector) external onlyAdmin {
        if (_agent == address(0) || _collector == address(0)) revert InvalidParams();
        agent = _agent;
        collector = _collector;
        emit AgentsRotated(_agent, _collector);
    }

    function setFdcEnforced(bool _enforced) external onlyAdmin {
        fdcEnforced = _enforced;
        emit FdcEnforcementSet(_enforced);
    }

    // ------------------------------------------------------------------
    // Liquidity pool
    // ------------------------------------------------------------------

    /// @notice Pool value in FLR wei (liquid + capital at work).
    function poolValue() public view returns (uint256) {
        return liquid + deployedCapital;
    }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        uint256 pv = poolValue();
        uint256 minted = (totalShares == 0 || pv == 0)
            ? msg.value
            : (msg.value * totalShares) / pv;
        shares[msg.sender] += minted;
        totalShares += minted;
        liquid += msg.value;
        emit Deposited(msg.sender, msg.value, minted);
    }

    function withdraw(uint256 shareAmount) external {
        if (shareAmount == 0) revert ZeroAmount();
        uint256 owned = shares[msg.sender];
        if (owned < shareAmount) revert InsufficientShares();
        uint256 amount = (shareAmount * poolValue()) / totalShares;
        if (amount > liquid) revert InsufficientLiquidity();
        shares[msg.sender] = owned - shareAmount;
        totalShares -= shareAmount;
        liquid -= amount;
        emit Withdrawn(msg.sender, amount, shareAmount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }

    // ------------------------------------------------------------------
    // Invoice lifecycle
    // ------------------------------------------------------------------

    /// @notice Registers an invoice whose facts are attested by the Flare
    /// Data Connector. The AI agent supplies its pricing decision alongside;
    /// the receivable's facts (amount, tenor, identifiers) come from the
    /// attested system-of-record response, not from the agent.
    function registerInvoice(
        IWeb2Json.Proof calldata proof,
        address supplier,
        uint16 riskScore,
        uint16 discountBps,
        string calldata decisionHash
    ) external onlyAgent returns (uint64 id) {
        if (fdcEnforced && !fdcVerifier.verifyWeb2Json(proof)) revert InvalidProof();

        InvoiceFacts memory facts = abi.decode(
            proof.data.responseBody.abiEncodedData,
            (InvoiceFacts)
        );

        if (supplier == address(0) || riskScore > 100 || discountBps >= 10_000)
            revert InvalidParams();
        if (facts.amountUsdCents == 0) revert ZeroAmount();
        if (facts.dueTs <= block.timestamp) revert InvalidParams();

        bytes32 docKey = keccak256(bytes(facts.docHash));
        if (usedDocHashes[docKey]) revert DuplicateDocument();
        usedDocHashes[docKey] = true;

        id = ++invoiceCount;
        Invoice storage inv = _invoices[id];
        inv.id = id;
        inv.supplier = supplier;
        inv.invoiceNumber = facts.invoiceNumber;
        inv.debtorTag = facts.debtorTag;
        inv.docHash = facts.docHash;
        inv.faceUsdCents = facts.amountUsdCents;
        inv.dueTs = uint64(facts.dueTs);
        inv.riskScore = riskScore;
        inv.discountBps = discountBps;
        inv.decisionHash = decisionHash;
        inv.state = State.Listed;
        inv.registeredTs = uint64(block.timestamp);

        emit InvoiceRegistered(
            id,
            supplier,
            facts.invoiceNumber,
            facts.amountUsdCents,
            riskScore,
            discountBps,
            decisionHash
        );
    }

    /// @notice Funds a listed invoice: converts the USD advance to FLR at the
    /// live FTSOv2 rate and streams it to the supplier from the pool.
    function fundInvoice(uint64 id) external onlyAgent {
        Invoice storage inv = _loadInvoice(id);
        if (inv.state != State.Listed) revert InvalidState();

        uint256 advanceUsdCents = (inv.faceUsdCents * (10_000 - inv.discountBps)) / 10_000;
        (uint256 rate, int8 dec, ) = _readRate();
        uint256 advanceWei = usdCentsToFlrWei(advanceUsdCents, rate, dec);

        if (advanceWei > liquid) revert InsufficientLiquidity();
        liquid -= advanceWei;
        deployedCapital += advanceWei;
        totalFundedFlr += advanceWei;

        inv.state = State.Funded;
        inv.advanceFlrWei = advanceWei;
        inv.fundRateValue = rate;
        inv.fundRateDecimals = dec;
        inv.fundedTs = uint64(block.timestamp);

        emit InvoiceFunded(id, advanceWei, rate, dec);
        (bool ok, ) = inv.supplier.call{value: advanceWei}("");
        require(ok, "advance transfer failed");
    }

    /// @notice Settles an invoice: the debtor pays the USD face value in FLR
    /// at the current FTSOv2 rate. Overpayment is kept as pool yield.
    function settleInvoice(uint64 id) external payable {
        Invoice storage inv = _loadInvoice(id);
        if (inv.state != State.Funded) revert InvalidState();

        uint256 requiredWei = quoteUsdCentsInFlrWei(inv.faceUsdCents);
        if (msg.value < requiredWei) revert PaymentTooLow();

        deployedCapital -= inv.advanceFlrWei;
        liquid += msg.value;
        totalSettledFlr += msg.value;

        inv.state = State.Settled;
        inv.settledFlrWei = msg.value;
        inv.closedTs = uint64(block.timestamp);

        emit InvoiceSettled(
            id,
            msg.value,
            int256(msg.value) - int256(inv.advanceFlrWei)
        );
    }

    /// @notice Writes off a funded invoice past due + grace. Collector only.
    function markDefault(uint64 id) external onlyCollector {
        Invoice storage inv = _loadInvoice(id);
        if (inv.state != State.Funded) revert InvalidState();
        if (block.timestamp <= uint256(inv.dueTs) + graceSeconds) revert NotDueYet();

        deployedCapital -= inv.advanceFlrWei;
        totalDefaultedFlr += inv.advanceFlrWei;

        inv.state = State.Defaulted;
        inv.closedTs = uint64(block.timestamp);
        emit InvoiceDefaulted(id, inv.advanceFlrWei);
    }

    /// @notice Anchors the hash of an agent decision memo on-chain.
    function attest(
        string calldata kind,
        uint64 subjectId,
        string calldata payloadHash,
        string calldata model
    ) external returns (uint64 id) {
        if (msg.sender != agent && msg.sender != collector) revert NotAgent();
        id = ++attestationCount;
        _attestations[id] = AgentAttestation({
            id: id,
            actor: msg.sender,
            kind: kind,
            subjectId: subjectId,
            payloadHash: payloadHash,
            model: model,
            ts: uint64(block.timestamp)
        });
        emit AgentAttested(id, msg.sender, kind, subjectId, payloadHash);
    }

    // ------------------------------------------------------------------
    // Views & helpers
    // ------------------------------------------------------------------

    function getInvoice(uint64 id) external view returns (Invoice memory) {
        return _invoices[id];
    }

    function listInvoices(uint64 from, uint64 count) external view returns (Invoice[] memory out) {
        if (from == 0) from = 1;
        uint64 last = invoiceCount;
        uint64 n = 0;
        for (uint64 i = from; i <= last && n < count; i++) n++;
        out = new Invoice[](n);
        for (uint64 i = 0; i < n; i++) out[i] = _invoices[from + i];
    }

    function getAttestation(uint64 id) external view returns (AgentAttestation memory) {
        return _attestations[id];
    }

    struct Stats {
        uint256 liquid;
        uint256 deployedCapital;
        uint256 totalShares;
        uint256 totalFundedFlr;
        uint256 totalSettledFlr;
        uint256 totalDefaultedFlr;
        uint64 invoiceCount;
        uint64 attestationCount;
    }

    function stats() external view returns (Stats memory) {
        return
            Stats(
                liquid,
                deployedCapital,
                totalShares,
                totalFundedFlr,
                totalSettledFlr,
                totalDefaultedFlr,
                invoiceCount,
                attestationCount
            );
    }

    /// @notice Quotes how much FLR (wei) `usdCents` is worth at the live
    /// FTSOv2 rate — used by debtors to size settlement payments.
    function quoteUsdCentsInFlrWei(uint256 usdCents) public view returns (uint256) {
        (uint256 rate, int8 dec, ) = _readRate();
        return usdCentsToFlrWei(usdCents, rate, dec);
    }

    /// @dev flrWei = usd * 1e18 / price, usd = cents/100, price = rate/10^dec
    ///      => flrWei = cents * 1e16 * 10^dec / rate
    function usdCentsToFlrWei(
        uint256 usdCents,
        uint256 rate,
        int8 dec
    ) public pure returns (uint256) {
        if (rate == 0 || dec < 0 || dec > 30) revert StaleRate();
        return (usdCents * 1e16 * (10 ** uint8(dec))) / rate;
    }

    /// @dev Type helper so tooling can extract the InvoiceFacts ABI shape.
    function abiSignatureHack(InvoiceFacts calldata) external pure {}

    function _readRate() internal view returns (uint256 rate, int8 dec, uint64 ts) {
        (rate, dec, ts) = ftso.getFeedById(feedId);
        if (rate == 0) revert StaleRate();
    }

    function _loadInvoice(uint64 id) internal view returns (Invoice storage inv) {
        inv = _invoices[id];
        if (inv.state == State.None) revert InvalidState();
    }
}
