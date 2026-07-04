// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IWeb2Json} from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";
import {IFtsoV2Reader, IFdcProofVerifier} from "../FakturaHub.sol";

/// @dev Test double for FTSOv2 — settable default rate plus optional
/// per-feed overrides (for two-feed tests like FXRP settlement).
contract MockFtsoV2 is IFtsoV2Reader {
    uint256 public value;
    int8 public dec;

    struct FeedRate {
        uint256 value;
        int8 dec;
        bool set;
    }
    mapping(bytes21 => FeedRate) public feeds;

    constructor(uint256 _value, int8 _dec) {
        value = _value;
        dec = _dec;
    }

    function set(uint256 _value, int8 _dec) external {
        value = _value;
        dec = _dec;
    }

    function setFeed(bytes21 _feedId, uint256 _value, int8 _dec) external {
        feeds[_feedId] = FeedRate(_value, _dec, true);
    }

    function getFeedById(bytes21 _feedId)
        external
        view
        returns (uint256, int8, uint64)
    {
        FeedRate memory f = feeds[_feedId];
        if (f.set) return (f.value, f.dec, uint64(block.timestamp));
        return (value, dec, uint64(block.timestamp));
    }
}

/// @dev Test double for FdcVerification — toggleable verdict.
contract MockFdcVerifier is IFdcProofVerifier {
    bool public verdict = true;

    function set(bool _verdict) external {
        verdict = _verdict;
    }

    function verifyWeb2Json(IWeb2Json.Proof calldata)
        external
        view
        returns (bool)
    {
        return verdict;
    }
}

/// @dev Minimal ERC-20 standing in for FXRP on tests and the Coston2 demo
/// (real deployments point `configureTokenSettlement` at canonical FXRP).
contract DemoFXRP {
    string public name = "Demo FXRP";
    string public symbol = "dFXRP";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
