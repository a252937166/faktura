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

/// @dev Minimal ERC-20 surface used for the interoperable settlement leg
/// (FXRP / stablecoins). Kept tiny on purpose.
interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
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
    /// @dev The supplier's payout wallet as recorded in the system of record.
    /// While FDC enforcement is on, advances are paid to THIS attested
    /// address — the agent cannot redirect them.
    address supplierWallet;
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

    /// @notice When set, FDC-attested registrations must read their facts from
    /// a URL starting with this prefix — the pinned supplier system of record.
    /// A compromised agent key can then only register receivables that the
    /// pinned ERP actually served (and FDC attested), not ones it invented.
    string public erpUrlPrefix;

    /// @notice Maximum accepted age of an FTSOv2 feed value. Funding,
    /// settlement quoting and reserve valuation revert on staler data.
    uint64 public maxFeedAgeSeconds = 3600;

    /// @notice Hard underwriting limits enforced on-chain. The AI agent
    /// proposes risk/pricing, but registrations and fundings outside these
    /// bounds revert regardless of what the agent (or its stolen key) says.
    struct RiskPolicy {
        uint16 maxRiskScore; // reject riskier registrations
        uint16 minDiscountBps; // pricing floor
        uint16 maxDiscountBps; // pricing ceiling
        uint16 maxAdvanceBpsOfLiquid; // single-invoice exposure cap vs liquid
        uint64 maxTenorSeconds; // longest allowed time to due date
    }

    RiskPolicy public riskPolicy =
        RiskPolicy({
            maxRiskScore: 65,
            minDiscountBps: 50,
            maxDiscountBps: 2500,
            maxAdvanceBpsOfLiquid: 6000,
            maxTenorSeconds: 120 days
        });

    // ------------------------------------------------------------------
    // Interoperable settlement leg (FXRP / FAssets / stablecoins)
    // ------------------------------------------------------------------
    /// @notice Optional ERC-20 settlement asset (e.g. FXRP). Debtors can pay
    /// the USD face value in this token at the live FTSOv2 cross rate; the
    /// pool carries the reserve and values it through the oracle.
    IERC20Minimal public settlementToken;
    bytes21 public settlementTokenFeedId; // e.g. XRP/USD
    uint8 public settlementTokenDecimals;
    uint256 public settlementTokenReserve; // token units held by the pool

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
    event InvoiceSettledInToken(
        uint64 indexed id,
        address indexed token,
        uint256 tokenAmount,
        uint256 flrEquivalentWei
    );
    event InvoiceDefaulted(uint64 indexed id, uint256 lossFlrWei);
    event RiskPolicySet(
        uint16 maxRiskScore,
        uint16 minDiscountBps,
        uint16 maxDiscountBps,
        uint16 maxAdvanceBpsOfLiquid,
        uint64 maxTenorSeconds
    );
    event TokenSettlementConfigured(address token, bytes21 feedId, uint8 decimals);
    event ErpUrlPrefixSet(string prefix);
    event MaxFeedAgeSet(uint64 maxFeedAgeSeconds);
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
    error UntrustedSource();
    error DuplicateDocument();
    error InvalidState();
    error InvalidParams();
    error PolicyViolation();
    error ExposureCapExceeded();
    error TokenSettlementDisabled();
    error TokenTransferFailed();
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

    /// @notice Pins the supplier system-of-record URL prefix for FDC-attested
    /// registrations. Empty string disables the check.
    function setErpUrlPrefix(string calldata _prefix) external onlyAdmin {
        erpUrlPrefix = _prefix;
        emit ErpUrlPrefixSet(_prefix);
    }

    /// @notice Bounds how old an FTSOv2 feed value may be before pricing
    /// operations revert with StaleRate.
    function setMaxFeedAge(uint64 _seconds) external onlyAdmin {
        if (_seconds == 0) revert InvalidParams();
        maxFeedAgeSeconds = _seconds;
        emit MaxFeedAgeSet(_seconds);
    }

    /// @notice Updates the on-chain underwriting limits.
    function setRiskPolicy(RiskPolicy calldata p) external onlyAdmin {
        if (
            p.maxRiskScore > 100 ||
            p.minDiscountBps > p.maxDiscountBps ||
            p.maxDiscountBps >= 10_000 ||
            p.maxAdvanceBpsOfLiquid == 0 ||
            p.maxAdvanceBpsOfLiquid > 10_000 ||
            p.maxTenorSeconds == 0
        ) revert InvalidParams();
        riskPolicy = p;
        emit RiskPolicySet(
            p.maxRiskScore,
            p.minDiscountBps,
            p.maxDiscountBps,
            p.maxAdvanceBpsOfLiquid,
            p.maxTenorSeconds
        );
    }

    /// @notice Enables settlement in an ERC-20 asset (e.g. FXRP) priced by a
    /// second FTSOv2 feed (e.g. XRP/USD). Zero address disables it.
    function configureTokenSettlement(
        address token,
        bytes21 tokenFeedId,
        uint8 tokenDecimals
    ) external onlyAdmin {
        if (token != address(0) && tokenDecimals > 30) revert InvalidParams();
        settlementToken = IERC20Minimal(token);
        settlementTokenFeedId = tokenFeedId;
        settlementTokenDecimals = tokenDecimals;
        emit TokenSettlementConfigured(token, tokenFeedId, tokenDecimals);
    }

    // ------------------------------------------------------------------
    // Liquidity pool
    // ------------------------------------------------------------------

    /// @notice Pool value in FLR wei: liquid + capital at work + the FLR
    /// value of the ERC-20 settlement reserve (priced through FTSOv2).
    function poolValue() public view returns (uint256) {
        return liquid + deployedCapital + settlementReserveFlrValue();
    }

    /// @notice FLR-wei value of the pool's settlement-token reserve, priced
    /// via token/USD and FLR/USD FTSOv2 feeds. Zero when the leg is unused.
    function settlementReserveFlrValue() public view returns (uint256) {
        uint256 reserve = settlementTokenReserve;
        if (reserve == 0) return 0;
        (uint256 tokenRate, int8 tokenDec, ) = _readFeed(settlementTokenFeedId);
        (uint256 flrRate, int8 flrDec, ) = _readFeed(feedId);
        if (tokenDec < 0 || tokenDec > 30 || flrDec < 0 || flrDec > 30) revert StaleRate();
        // flrWei = reserve/10^tokUnits * (tokenRate/10^tokenDec) / (flrRate/10^flrDec) * 1e18
        return
            (reserve * tokenRate * (10 ** uint8(flrDec)) * 1e18) /
            ((10 ** settlementTokenDecimals) * (10 ** uint8(tokenDec)) * flrRate);
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
    /// the receivable's facts (amount, tenor, identifiers, payout wallet)
    /// come from the attested system-of-record response, not from the agent.
    /// While FDC enforcement is on, `supplier` is ignored in favour of the
    /// attested `supplierWallet` — a compromised agent key cannot redirect
    /// advances to itself.
    function registerInvoice(
        IWeb2Json.Proof calldata proof,
        address supplier,
        uint16 riskScore,
        uint16 discountBps,
        string calldata decisionHash
    ) external onlyAgent returns (uint64 id) {
        if (fdcEnforced) {
            if (!fdcVerifier.verifyWeb2Json(proof)) revert InvalidProof();
            // Provenance pinning: attested facts must come from the approved
            // supplier system of record, not any URL of the agent's choosing.
            if (
                bytes(erpUrlPrefix).length > 0 &&
                !_hasPrefix(proof.data.requestBody.url, erpUrlPrefix)
            ) revert UntrustedSource();
        }

        InvoiceFacts memory facts = abi.decode(
            proof.data.responseBody.abiEncodedData,
            (InvoiceFacts)
        );

        if (fdcEnforced) {
            // The payout beneficiary is a system-of-record fact, not an
            // agent-chosen parameter.
            if (facts.supplierWallet == address(0)) revert UntrustedSource();
            supplier = facts.supplierWallet;
        }

        if (supplier == address(0) || riskScore > 100 || discountBps >= 10_000)
            revert InvalidParams();
        if (facts.amountUsdCents == 0) revert ZeroAmount();
        if (facts.dueTs <= block.timestamp) revert InvalidParams();

        // On-chain underwriting limits: the agent's pricing must sit inside
        // the admin-set policy envelope no matter what the model proposed.
        RiskPolicy memory pol = riskPolicy;
        if (
            riskScore > pol.maxRiskScore ||
            discountBps < pol.minDiscountBps ||
            discountBps > pol.maxDiscountBps ||
            facts.dueTs > block.timestamp + pol.maxTenorSeconds
        ) revert PolicyViolation();

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
        // Single-invoice exposure cap, enforced on-chain against liquid capital.
        if (advanceWei * 10_000 > liquid * riskPolicy.maxAdvanceBpsOfLiquid)
            revert ExposureCapExceeded();
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

    /// @notice Settles an invoice in the configured ERC-20 settlement asset
    /// (e.g. FXRP): the debtor pays the USD face value in tokens at the live
    /// FTSOv2 token/USD rate. The pool holds the tokens as an oracle-priced
    /// reserve. Caller must approve at least the quoted amount first.
    function settleInvoiceInToken(uint64 id) external {
        if (address(settlementToken) == address(0)) revert TokenSettlementDisabled();
        Invoice storage inv = _loadInvoice(id);
        if (inv.state != State.Funded) revert InvalidState();

        uint256 tokenAmount = quoteUsdCentsInToken(inv.faceUsdCents);
        if (tokenAmount == 0) revert PaymentTooLow();
        if (!settlementToken.transferFrom(msg.sender, address(this), tokenAmount))
            revert TokenTransferFailed();

        uint256 flrEquivalent = quoteUsdCentsInFlrWei(inv.faceUsdCents);
        deployedCapital -= inv.advanceFlrWei;
        settlementTokenReserve += tokenAmount;
        totalSettledFlr += flrEquivalent;

        inv.state = State.Settled;
        inv.settledFlrWei = flrEquivalent;
        inv.closedTs = uint64(block.timestamp);

        emit InvoiceSettledInToken(id, address(settlementToken), tokenAmount, flrEquivalent);
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
        uint256 settlementTokenReserve;
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
                attestationCount,
                settlementTokenReserve
            );
    }

    /// @notice Quotes how much FLR (wei) `usdCents` is worth at the live
    /// FTSOv2 rate — used by debtors to size settlement payments.
    function quoteUsdCentsInFlrWei(uint256 usdCents) public view returns (uint256) {
        (uint256 rate, int8 dec, ) = _readRate();
        return usdCentsToFlrWei(usdCents, rate, dec);
    }

    /// @notice Quotes how much of the settlement token (smallest units)
    /// `usdCents` is worth at the live token/USD FTSOv2 rate. Rounds up so
    /// token settlements can never underpay the pool by truncation.
    function quoteUsdCentsInToken(uint256 usdCents) public view returns (uint256) {
        if (address(settlementToken) == address(0)) revert TokenSettlementDisabled();
        (uint256 rate, int8 dec, ) = _readFeed(settlementTokenFeedId);
        if (rate == 0 || dec < 0 || dec > 30) revert StaleRate();
        // tokens = usd / price = (cents/100) / (rate/10^dec), in 10^tokenDec units
        uint256 numerator = usdCents * (10 ** uint8(dec)) * (10 ** settlementTokenDecimals);
        uint256 denominator = 100 * rate;
        return (numerator + denominator - 1) / denominator;
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
        return _readFeed(feedId);
    }

    function _readFeed(bytes21 _feedId) internal view returns (uint256 rate, int8 dec, uint64 ts) {
        (rate, dec, ts) = ftso.getFeedById(_feedId);
        // Freshness guard: reject zero rates and values older than the
        // admin-set bound — funding, settlement quoting and reserve
        // valuation all pass through here.
        if (rate == 0 || ts + maxFeedAgeSeconds < block.timestamp) revert StaleRate();
    }

    /// @dev True when `str` starts with `prefix`.
    function _hasPrefix(string memory str, string memory prefix) internal pure returns (bool) {
        bytes memory s = bytes(str);
        bytes memory p = bytes(prefix);
        if (p.length > s.length) return false;
        for (uint256 i = 0; i < p.length; i++) {
            if (s[i] != p[i]) return false;
        }
        return true;
    }

    function _loadInvoice(uint64 id) internal view returns (Invoice storage inv) {
        inv = _invoices[id];
        if (inv.state == State.None) revert InvalidState();
    }
}
