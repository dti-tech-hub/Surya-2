// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ReputationRegistry
 * @notice On-chain reputation scores for creators, backers and verifiers.
 *
 * @dev Scoring model (this is the normative definition; `ml-service/reputation.py`
 *      implements the identical formula for off-chain display, and the two are checked
 *      against each other by `test/ReputationRegistry.parity.test.ts`).
 *
 *      1. Component ratios, each clamped to [0, 1]:
 *           delivery    = milestonesOnTime / milestonesTotal        (campaign behaviour)
 *           completion  = completedCampaigns / (completed + failed)(campaign outcome)
 *           dispute     = disputeWins / (disputeWins + disputeLosses)
 *           integrity   = votesCorrect / votesTotal                (verifier behaviour)
 *
 *      2. Weighted average. Each ratio is expressed in basis points and multiplied by
 *           its weight, then the total is divided by the sum of weights. This yields a
 *           score directly on the 0..BPS scale (10000 == perfect record):
 *           raw = (W_DELIVERY*delivery + W_COMPLETION*completion
 *                + W_DISPUTE*dispute + W_INTEGRITY*integrity) / WEIGHT_SUM
 *
 *         where delivery/completion/dispute/integrity are each ratios in [0, BPS] and
 *         WEIGHT_SUM = W_DELIVERY + W_COMPLETION + W_DISPUTE + W_INTEGRITY = 10 000.
 *
 *      3. Slashing penalty, capped at 5000 bps (50 points):
 *           raw -= min(slashedAmount * SLASH_PER_TOKEN / 1e18, 5000)
 *
 *      4. Time decay. Scores fade toward zero for inactivity, with a linear decay that
 *           needs no transcendental op:
 *           decay  = HALF_LIFE / (HALF_LIFE + (now - lastUpdated))
 *           score  = raw * decay / BPS
 *
 *      Rationale for step 4: an attacker who builds reputation and then abandons the
 *      platform should not retain it indefinitely. Linear (rather than exponential)
 *      decay is used because `exp` is not available in the EVM and an approximation
 *      would make the off-chain Python reimplementation diverge from the on-chain
 *      result. The formula is exactly reproducible in both languages.
 *
 *      Design properties:
 *      - Scores are computed lazily in `view` functions; they are never written on read,
 *        so reading a score is free and cannot be used as a gas griefing vector.
 *      - Only whitelisted system contracts may write. A random address cannot inflate
 *        anyone's score, including their own.
 *      - Components that have no observations are treated as neutral (ratio 0) and the
 *        corresponding weight is simply not earned. A brand-new address scores low but
 *        is not penalised relative to others with no history.
 */
contract ReputationRegistry {
    /* -------------------------------------------------------------------- */
    /*                                  Types                                */
    /* -------------------------------------------------------------------- */

    /// @notice Reputation tiers, ordered by increasing standing.
    enum Tier {
        Unrated,
        Bronze,
        Silver,
        Gold,
        Platinum
    }

    /// @notice Raw per-subject counters. All are monotonically increasing.
    struct Profile {
        uint128 milestonesOnTime;
        uint128 milestonesTotal;
        uint128 campaignsCompleted;
        uint128 campaignsFailed;
        uint128 disputeWins;
        uint128 disputeLosses;
        uint128 votesCorrect;
        uint128 votesTotal;
        uint128 slashedWei;
        uint64 lastUpdated;
    }

    /* -------------------------------------------------------------------- */
    /*                                Constants                              */
    /* -------------------------------------------------------------------- */

    uint256 public constant BPS = 10_000;
    uint256 public constant W_DELIVERY = 4_000;
    uint256 public constant W_COMPLETION = 3_000;
    uint256 public constant W_DISPUTE = 2_000;
    uint256 public constant W_INTEGRITY = 1_000;
    uint256 public constant WEIGHT_SUM = W_DELIVERY + W_COMPLETION + W_DISPUTE + W_INTEGRITY;
    uint256 public constant MAX_SLASH_BPS = 5_000;
    uint256 public constant SLASH_PER_TOKEN = 50; // bps per whole token slashed
    uint256 public constant HALF_LIFE = 180 days;

    uint256 public constant TIER_BRONZE = 2_000;
    uint256 public constant TIER_SILVER = 4_000;
    uint256 public constant TIER_GOLD = 6_500;
    uint256 public constant TIER_PLATINUM = 8_000;

    /* -------------------------------------------------------------------- */
    /*                                 Storage                               */
    /* -------------------------------------------------------------------- */

    address public admin;

    /// @notice system contracts permitted to write reputation events.
    mapping(address => bool) public isWriter;

    mapping(address => Profile) private profiles;

    /* -------------------------------------------------------------------- */
    /*                                  Events                               */
    /* -------------------------------------------------------------------- */

    event AdminTransferred(address indexed from, address indexed to);
    event WriterUpdated(address indexed writer, bool allowed);
    event MilestoneRecorded(address indexed subject, bool onTime, uint256 scoreAfter);
    event CampaignRecorded(address indexed subject, bool completed, uint256 scoreAfter);
    event DisputeRecorded(address indexed subject, bool won, uint256 scoreAfter);
    event VerifierVoteRecorded(address indexed subject, bool correct, uint256 scoreAfter);
    event SlashRecorded(address indexed subject, uint256 amount, uint256 scoreAfter);

    /* -------------------------------------------------------------------- */
    /*                                  Errors                               */
    /* -------------------------------------------------------------------- */

    error NotAdmin(address caller);
    error NotWriter(address caller);
    error ZeroAddress();

    /* -------------------------------------------------------------------- */
    /*                                 Modifiers                             */
    /* -------------------------------------------------------------------- */

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    modifier onlyWriter() {
        if (!isWriter[msg.sender]) revert NotWriter(msg.sender);
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    /* -------------------------------------------------------------------- */
    /*                                Admin                                  */
    /* -------------------------------------------------------------------- */

    /// @notice Transfers administrative control.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    /// @notice Grants or revokes write permission for a system contract.
    function setWriter(address writer, bool allowed) external onlyAdmin {
        if (writer == address(0)) revert ZeroAddress();
        isWriter[writer] = allowed;
        emit WriterUpdated(writer, allowed);
    }

    /* -------------------------------------------------------------------- */
    /*                              Write API                                */
    /* -------------------------------------------------------------------- */

    /// @notice Records whether a creator hit a milestone on time.
    function recordMilestone(address subject, bool onTime) external onlyWriter {
        Profile storage p = _touch(subject);
        p.milestonesTotal += 1;
        if (onTime) p.milestonesOnTime += 1;
        emit MilestoneRecorded(subject, onTime, scoreOf(subject));
    }

    /// @notice Records a campaign outcome for a creator.
    function recordCampaign(address subject, bool completed) external onlyWriter {
        Profile storage p = _touch(subject);
        if (completed) {
            p.campaignsCompleted += 1;
        } else {
            p.campaignsFailed += 1;
        }
        emit CampaignRecorded(subject, completed, scoreOf(subject));
    }

    /// @notice Records a dispute outcome for a creator.
    function recordDispute(address subject, bool won) external onlyWriter {
        Profile storage p = _touch(subject);
        if (won) {
            p.disputeWins += 1;
        } else {
            p.disputeLosses += 1;
        }
        emit DisputeRecorded(subject, won, scoreOf(subject));
    }

    /// @notice Records whether a verifier's vote matched the settled outcome.
    function recordVerifierVote(address subject, bool correct) external onlyWriter {
        Profile storage p = _touch(subject);
        p.votesTotal += 1;
        if (correct) p.votesCorrect += 1;
        emit VerifierVoteRecorded(subject, correct, scoreOf(subject));
    }

    /**
     * @notice Applies a slashing penalty to a subject's score.
     * @param amountWei Native-token amount slashed; converted to a capped bps penalty.
     */
    function recordSlash(address subject, uint256 amountWei) external onlyWriter {
        Profile storage p = _touch(subject);
        p.slashedWei += uint128(amountWei);
        emit SlashRecorded(subject, amountWei, scoreOf(subject));
    }

    /* -------------------------------------------------------------------- */
    /*                                  Views                                */
    /* -------------------------------------------------------------------- */

    /// @notice Reads a subject's raw counters.
    function getProfile(address subject) external view returns (Profile memory) {
        return profiles[subject];
    }

    /**
     * @notice Current decayed reputation score for `subject`, in basis points (0..10000).
     * @dev Pure function of storage and `block.timestamp`; performs no writes.
     */
    function scoreOf(address subject) public view returns (uint256) {
        Profile storage p = profiles[subject];
        if (p.lastUpdated == 0) return 0;

        uint256 delivery = _ratio(p.milestonesOnTime, p.milestonesTotal);
        uint256 completion = _ratio(p.campaignsCompleted, p.campaignsCompleted + p.campaignsFailed);
        uint256 dispute = _ratio(p.disputeWins, p.disputeWins + p.disputeLosses);
        uint256 integrity = _ratio(p.votesCorrect, p.votesTotal);

        uint256 raw =
            (W_DELIVERY * delivery + W_COMPLETION * completion + W_DISPUTE * dispute + W_INTEGRITY * integrity)
            / WEIGHT_SUM;

        uint256 penalty = (uint256(p.slashedWei) / 1e18) * SLASH_PER_TOKEN;
        if (penalty > MAX_SLASH_BPS) penalty = MAX_SLASH_BPS;
        if (raw > penalty) raw -= penalty;

        uint256 age = block.timestamp - p.lastUpdated;
        return (raw * HALF_LIFE) / (HALF_LIFE + age);
    }

    /// @notice Tier corresponding to the subject's current score.
    function tierOf(address subject) external view returns (Tier) {
        uint256 s = scoreOf(subject);
        if (s >= TIER_PLATINUM) return Tier.Platinum;
        if (s >= TIER_GOLD) return Tier.Gold;
        if (s >= TIER_SILVER) return Tier.Silver;
        if (s >= TIER_BRONZE) return Tier.Bronze;
        return Tier.Unrated;
    }

    /// @notice Score expressed on a 0..100 scale, for display.
    function scorePercent(address subject) external view returns (uint256) {
        return scoreOf(subject) / 100;
    }

    /* -------------------------------------------------------------------- */
    /*                               Internals                               */
    /* -------------------------------------------------------------------- */

    /**
     * @dev Returns the subject's profile, initialising the decay clock on first sight.
     *      Stamping `lastUpdated` on first interaction (rather than at construction)
     *      means an address that never participates scores 0 rather than decaying from
     *      a non-zero initial value.
     */
    function _touch(address subject) private returns (Profile storage) {
        Profile storage p = profiles[subject];
        if (p.lastUpdated == 0) p.lastUpdated = uint64(block.timestamp);
        return p;
    }

    /// @dev a/b in basis points, or 0 when b is 0 (no observations yet).
    function _ratio(uint256 a, uint256 b) private pure returns (uint256) {
        if (b == 0) return 0;
        return (a * BPS) / b;
    }
}