// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IWeb2Json} from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";
import {IFtsoV2Reader, IFdcProofVerifier} from "../FakturaHub.sol";

/// @dev Test double for FTSOv2 — settable FLR/USD rate.
contract MockFtsoV2 is IFtsoV2Reader {
    uint256 public value;
    int8 public dec;

    constructor(uint256 _value, int8 _dec) {
        value = _value;
        dec = _dec;
    }

    function set(uint256 _value, int8 _dec) external {
        value = _value;
        dec = _dec;
    }

    function getFeedById(bytes21)
        external
        view
        returns (uint256, int8, uint64)
    {
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
