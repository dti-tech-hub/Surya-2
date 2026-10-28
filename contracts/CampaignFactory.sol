// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Campaign } from "./Campaign.sol";
import { MilestoneVerifier } from "./MilestoneVerifier.sol";
import { ReputationRegistry } from "./ReputationRegistry.sol";
import { IDisputeModule } from "./interfaces/IDisputeModule.sol";

/**
 * @title CampaignFactory
 * @notice Deploys {Campaign} instances and registers them with the {MilestoneVerifier}.
 *
 * @dev The factory is the only address permitted to register campaigns, which removes
 *      the need for the verifier to trust arbitrary caller-supplied addresses: a round
 *      can only be opened by a contract this factory actually deployed.
 *
 *      Deploying one contract per campaign costs more gas than clones but gives each
 *      campaign an isolated, immutable storage layout and lets the campaign hold a
 *      distinct immutable verifier/factory reference. For production scale this is the
 *      natural target for the OpenZeppelin Clones pattern; see docs/DECISIONS.md.
 */
contract CampaignFactory {
    /// @notice Milestone escrow campaigns created by this factory.
    Campaign[] private campaigns;

    /// @notice Campaign address => whether this factory deployed it.
    mapping(address => bool) public isCampaign;

    MilestoneVerifier public immutable verifier;
    ReputationRegistry public immutable reputation;

    /// @notice Dispute module new campaigns are bound to. Zero disables appeals.
    address public disputeModule;

    address public admin;
    address public immutable treasury;

    event CampaignDeployed(
        address indexed campaign,
        address indexed creatorAddress,
        uint256 indexed campaignIndex,
        uint256 goalAmount,
        uint64 fundingDeadline,
        uint256 milestoneCount
    );
    event AdminTransferred(address indexed from, address indexed to);
    event DisputeModuleUpdated(address indexed previous, address indexed current);

    error ZeroAddress();
    error NotAdmin(address caller);
    error MilestoneArrayLengthMismatch();
    error InvalidTrancheSum(uint256 provided, uint256 expected);

    /// @notice Campaign creation parameters, grouped to keep the stack within bounds
    ///         and to give callers a self-documenting ABI.
    struct CampaignParams {
        uint256 goal;
        uint64 fundingDeadline;
        uint16[] trancheBps;
        bytes32[] descriptionHashes;
        string[] specificationCIDs;
        uint64[] milestoneDeadlines;
        /// @notice Dust/fee destination for the campaign. Defaults to the factory
        ///         treasury when left as address(0).
        address treasury;
    }

    uint256 internal constant BPS = 10_000;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    /**
     * @param verifier_ Verification registry every deployed campaign reports to.
     * @param reputation_ Reputation registry every deployed campaign writes to.
     * @param admin_ Administrative owner of the factory.
     * @param treasury_ Default recipient for campaign-level fees and dust.
     */
    constructor(address verifier_, address reputation_, address admin_, address treasury_) {
        if (
            verifier_ == address(0) ||
            reputation_ == address(0) ||
            admin_ == address(0) ||
            treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        verifier = MilestoneVerifier(verifier_);
        reputation = ReputationRegistry(reputation_);
        admin = admin_;
        treasury = treasury_;
    }

    /**
     * @notice Sets the dispute module that newly deployed campaigns are bound to.
     * @dev Applies to campaigns created after this call. Existing campaigns are
     *      immutable by design.
     */
    function setDisputeModule(address module) external onlyAdmin {
        emit DisputeModuleUpdated(disputeModule, module);
        disputeModule = module;
    }

    /**
     * @notice Deploys a new campaign and registers it with the verifier.
     * @param params Funding goal, deadline, release schedule and milestone descriptors.
     * @return campaignAddress Address of the freshly deployed campaign.
     */
    function createCampaign(CampaignParams calldata params) external returns (address campaignAddress) {
        uint256 n = params.trancheBps.length;
        if (n == 0) revert MilestoneArrayLengthMismatch();
        if (
            params.descriptionHashes.length != n ||
            params.specificationCIDs.length != n ||
            params.milestoneDeadlines.length != n
        ) {
            revert MilestoneArrayLengthMismatch();
        }

        uint256 trancheSum;
        for (uint256 i = 0; i < n; ++i) {
            trancheSum += params.trancheBps[i];
        }
        if (trancheSum != BPS) revert InvalidTrancheSum(trancheSum, BPS);

        Campaign campaign = new Campaign(
            msg.sender,
            address(verifier),
            address(reputation),
            params.treasury == address(0) ? treasury : params.treasury,
            params.goal,
            params.fundingDeadline,
            params.trancheBps,
            params.descriptionHashes,
            params.specificationCIDs,
            params.milestoneDeadlines
        );

        campaignAddress = address(campaign);
        isCampaign[campaignAddress] = true;
        campaigns.push(campaign);

        // Only this factory may register campaigns, so this call cannot be spoofed.
        verifier.registerCampaign(campaignAddress);

        // Let the campaign write its own milestone/campaign outcomes to reputation.
        reputation.registerWriter(campaignAddress);

        // Bind the campaign to the dispute module and make it judgeable. Both calls
        // are permissioned to this factory, so a creator cannot substitute a malicious
        // resolver or register an arbitrary contract.
        if (disputeModule != address(0)) {
            campaign.setDisputeModule(disputeModule);
            IDisputeModule(disputeModule).registerCampaign(campaignAddress);
        }

        emit CampaignDeployed(
            campaignAddress,
            msg.sender,
            campaigns.length - 1,
            params.goal,
            params.fundingDeadline,
            n
        );
    }

    /// @notice Total number of campaigns deployed by this factory.
    function campaignCount() external view returns (uint256) {
        return campaigns.length;
    }

    /// @notice Reads a deployed campaign by index.
    function campaignAt(uint256 index) external view returns (address) {
        if (index >= campaigns.length) revert MilestoneArrayLengthMismatch();
        return address(campaigns[index]);
    }

    /// @notice Transfers administrative control.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }
}