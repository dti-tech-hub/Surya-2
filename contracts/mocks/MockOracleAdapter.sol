// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IOracleAdapter } from "../interfaces/IOracleAdapter.sol";

/**
 * @title MockOracleAdapter
 * @notice Test double for {IOracleAdapter}.
 * @dev MOCK ONLY. Every attestation returns a pre-configured boolean and performs no
 *      external data lookup whatsoever. It exists so that the oracle code path in
 *      {MilestoneVerifier} can be exercised and benchmarked. Deploying this against
 *      real campaigns would mean the "oracle" is simply a hardcoded constant, so it must
 *      never be used outside tests and benchmarks.
 */
contract MockOracleAdapter is IOracleAdapter {
    bool private verdict_;
    string private description_;

    constructor(bool verdict, string memory description) {
        verdict_ = verdict;
        description_ = description;
    }

    function attest(address, uint256, bytes32) external view returns (bool) {
        return verdict_;
    }

    function sourceDescription() external view returns (string memory) {
        return description_;
    }

    /// @notice Test helper to flip the configured verdict.
    function setVerdict(bool verdict) external {
        verdict_ = verdict;
    }
}