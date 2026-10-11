// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IOracleAdapter
 * @notice Interface for a trusted data source whose attestation contributes one extra
 *         weighted vote to a milestone verification round.
 * @dev An oracle adapter bridges an off-chain attestation (for example a shipment
 *      tracking API, an academic registry, or a court/public-record lookup) into the
 *      on-chain voting process.
 *
 *      IMPORTANT (honesty note): the shipped {MockOracleAdapter} is a *mock*. It does not
 *      consult any real-world data source and must not be used in production. It exists
 *      so the voting path and its gas cost can be measured. See docs/DECISIONS.md.
 *
 *      Security assumption: a production adapter must authenticate its upstream data
 *      source, since anyone able to make the adapter emit an arbitrary verdict could buy
 *      influence equal to `oracleWeight` in every round at no stake cost.
 */
interface IOracleAdapter {
    /**
     * @notice Returns the oracle's verdict for a given milestone.
     * @param campaign Address of the campaign being reviewed.
     * @param milestoneIndex Index of the milestone under review.
     * @param evidenceHash keccak256 hash of the evidence the oracle is attesting to.
     * @return verdict `true` if the oracle attests the milestone is complete.
     */
    function attest(address campaign, uint256 milestoneIndex, bytes32 evidenceHash)
        external
        view
        returns (bool verdict);

    /// @notice Human-readable identifier of the upstream data source.
    function sourceDescription() external view returns (string memory);
}