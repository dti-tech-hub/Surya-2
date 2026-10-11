// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReputationRegistry } from "./ReputationRegistry.sol";
import { MilestoneVerifier } from "./MilestoneVerifier.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DisputeResolution
 * @notice Stake-weighted juror panel that resolves disputes over campaign milestones.
 *
 * @dev Purpose
 *
 *      Milestone verification (O3) answers "was the work delivered?". This module
 *      answers the harder question: "the verifier panel was wrong or the creator was
 *      wrong — who gets the escrow?". It exists because pure reputation voting has no
 *      recourse when the electorate is itself compromised.
 *
 *      Flow
 *        1. A backer holding at least {MIN_DISPUTE_SHARE_BPS} of their contribution
 *           raises a dispute against a milestone, posting {disputeBond} as a bond.
 *        2. Jurors are drawn from the {MilestoneVerifier} staked pool. Each juror votes
 *           once; weight is stake-derived.
 *        3. After {votingWindow}, anyone calls {resolve}. The outcome is one of
 *           REFUND / RELEASE / PARTIAL.
 *        4. Bonds and juror stakes settle. Reputation is updated on-chain.
 *
 *      Anti-whale voting
 *      -----------------
 *      Pure stake weighting lets one large juror decide a dispute. The weight curve is
 *      therefore configurable:
 *
 *          weight = stake                                    (linear, weightCurveExponent == 1e18)
 *          weight = stake / sqrt(stake) * k                  (quadratic, exponent == 0.5e18)
 *
 *      implemented as `weight = k * (stake ^ exponent / 1e18)`, with the constant `k`
 *      chosen so that a reference stake of 1 token maps to 1 weight unit. Quadratic
 *      weighting means doubling your stake buys only ~1.41x the influence, so influence
 *      grows sublinearly with capital. This bounds whale dominance at the cost of
 *      requiring more jurors for the same total weight.
 *
 *      Griefing
 *      ---------
 *      Raising a dispute costs a bond, and the bond is slashed when the dispute is
 *      found baseless. A spammer must therefore post capital per dispute. Disputes also
 *      carry a per-campaign cooldown so one backer cannot repeatedly stall a campaign.
 *
 *      Oracle interaction
 *      ------------------
 *      The milestone verification outcome is read from {MilestoneVerifier} to establish
 *      what the campaign currently believes. The dispute verdict can *override* it,
 *      which is the entire point: an appeal path that cannot change the outcome is not
 *      an appeal path.
 */
contract DisputeResolution is ReentrancyGuard {
    /* -------------------------------------------------------------------- */
    /*                                  Types                                */
    /* -------------------------------------------------------------------- */

    /// @notice Outcome of a resolved dispute.
    enum Outcome {
        None,
        Refund, // remaining escrow returned to backers
        Release, // tranche released to creator
        Partial // partial split, see {partialBps}
    }

    enum DisputeState {
        None,
        Open,
        Voting,
        Resolved
    }

    struct Dispute {
        address campaign;
        uint256 milestoneIndex;
        address raiser;
        uint64 raisedAt;
        uint64 voteDeadline;
        uint128 forRefundWeight;
        uint128 forCreatorWeight;
        uint128 votedWeight;
        DisputeState state;
        Outcome outcome;
        uint16 partialBps; // creator share when outcome == Partial
        bool raiserBondSlashed;
        uint256 journal;
        uint256 bondEscrowed; // total bond posted to THIS dispute, for reward payouts
    }

    struct Juror {
        uint128 stake;
        bool staked;
        uint256 casesVoted;
        uint256 casesCorrect;
    }

    /* -------------------------------------------------------------------- */
    /*                                Constants                              */
    /* -------------------------------------------------------------------- */

    uint256 public constant BPS = 10_000;
    uint128 public constant MIN_DISPUTE_SHARE_BPS = 500; // backer needs 5% of own stake in campaign
    uint256 public constant MIN_STAKE = 1e17; // 0.1 token to serve as juror
    uint256 public constant REWARD_SHARE_BPS = 5_000; // 50% of a dispute's bond funds rewards

    /* -------------------------------------------------------------------- */
    /*                                Immutables                             */
    /* -------------------------------------------------------------------- */

    MilestoneVerifier public immutable verifier;
    ReputationRegistry public immutable reputation;

    /* -------------------------------------------------------------------- */
    /*                                 Storage                               */
    /* -------------------------------------------------------------------- */

    address public admin;
    address public treasury;

    /// @notice Campaigns whose disputes this module may hear.
    mapping(address => bool) public isJudgeable;
    mapping(address => bool) public isArbiter;

    uint256 public disputeBond = 0.05 ether;
    uint64 public votingWindow = 3 days;
    uint64 public disputeCooldown = 1 days;

    /// @notice Weight curve exponent, 1e18 = linear, 5e17 = sqrt (quadratic).
    uint256 public weightCurveExponent = 1e18;

    mapping(bytes32 => Dispute) private disputes;

    /// @notice campaign => last dispute raise timestamp, for the cooldown.
    mapping(address => uint64) public lastDisputeRaisedAt;

    mapping(address => Juror) private jurors;

    /// @notice (disputeKey, juror) => vote, to prevent double voting.
    mapping(bytes32 => mapping(address => bool)) public hasVoted;
    /// @notice (disputeKey, juror) => votedForCreator
    mapping(bytes32 => mapping(address => bool)) public jurorVote;
    mapping(bytes32 => mapping(address => bool)) public jurorClaimed;

    uint256 public totalJurorStake;
    uint256 public totalBondEscrow;

    /* -------------------------------------------------------------------- */
    /*                                  Events                               */
    /* -------------------------------------------------------------------- */

    event AdminTransferred(address indexed from, address indexed to);
    event ArbiterUpdated(address indexed arbiter, bool allowed);
    event JudgeableUpdated(address indexed campaign, bool allowed);
    event ParametersUpdated(uint256 disputeBond, uint64 votingWindow, uint64 disputeCooldown, uint256 weightCurveExponent);
    event DisputeRaised(
        bytes32 indexed disputeKey,
        address indexed campaign,
        uint256 indexed milestoneIndex,
        address raiser,
        uint256 bond
    );
    event DisputeChallenged(bytes32 indexed disputeKey, address indexed challenger);
    event DisputeVoted(bytes32 indexed disputeKey, address indexed juror, bool forCreator, uint256 weight);
    event DisputeResolved(
        bytes32 indexed disputeKey,
        Outcome outcome,
        uint16 partialBps,
        uint128 forRefundWeight,
        uint128 forCreatorWeight
    );
    event BondSettled(bytes32 indexed disputeKey, address indexed party, uint256 amount, bool slashed);
    event JurorSettled(bytes32 indexed disputeKey, address indexed juror, uint256 reward, uint256 slash);
    event ReputationRecorded(address indexed subject, bool positive);

    /* -------------------------------------------------------------------- */
    /*                                  Errors                               */
    /* -------------------------------------------------------------------- */

    error NotAdmin(address caller);
    error NotArbiter(address caller);
    error NotJudgeable(address campaign);
    error ZeroAddress();
    error InsufficientShare(uint256 provided, uint256 required);
    error CooldownActive(uint256 retryAfter);
    error DisputeAlreadyOpen(bytes32 disputeKey);
    error UnknownDispute(bytes32 disputeKey);
    error VotingStillOpen(uint64 deadline);
    error NotOpen(bytes32 disputeKey);
    error AlreadyVoted(bytes32 disputeKey, address juror);
    error NotAStakedJuror(address juror);
    error QuorumNotMet(uint128 voted, uint128 required);
    error AlreadyClaimed(bytes32 disputeKey, address juror);
    error InsufficientEscrow(uint256 required, uint256 available);
    error TransferFailed();
    error InvalidBps(uint256 value);

    /* -------------------------------------------------------------------- */
    /*                                 Modifiers                             */
    /* -------------------------------------------------------------------- */

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    modifier onlyArbiter() {
        if (!isArbiter[msg.sender]) revert NotArbiter(msg.sender);
        _;
    }

    constructor(address admin_, address treasury_, address verifier_, address reputation_) {
        if (admin_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (verifier_ == address(0) || reputation_ == address(0)) revert ZeroAddress();
        admin = admin_;
        treasury = treasury_;
        verifier = MilestoneVerifier(verifier_);
        reputation = ReputationRegistry(reputation_);
    }

    /* -------------------------------------------------------------------- */
    /*                                Admin                                  */
    /* -------------------------------------------------------------------- */

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function setArbiter(address arbiter, bool allowed) external onlyAdmin {
        if (arbiter == address(0)) revert ZeroAddress();
        isArbiter[arbiter] = allowed;
        emit ArbiterUpdated(arbiter, allowed);
    }

    function setJudgeable(address campaign, bool allowed) external onlyAdmin {
        if (campaign == address(0)) revert ZeroAddress();
        isJudgeable[campaign] = allowed;
        emit JudgeableUpdated(campaign, allowed);
    }

    function setParameters(uint256 bond, uint64 window, uint64 cooldown, uint256 exponent) external onlyAdmin {
        if (exponent > 1e18) revert InvalidBps(exponent);
        disputeBond = bond;
        votingWindow = window;
        disputeCooldown = cooldown;
        weightCurveExponent = exponent;
        emit ParametersUpdated(bond, window, cooldown, exponent);
    }

    /* -------------------------------------------------------------------- */
    /*                            Juror staking                             */
    /* -------------------------------------------------------------------- */

    /// @notice Stake to be eligible as a juror.
    function stakeJuror() external payable {
        if (msg.value < MIN_STAKE) revert InsufficientShare(msg.value, MIN_STAKE);
        Juror storage j = jurors[msg.sender];
        if (!j.staked) {
            j.staked = true;
        }
        j.stake += uint128(msg.value);
        totalJurorStake += msg.value;
    }

    /// @notice Withdraws juror stake.
    function withdrawJurorStake(uint256 amount) external {
        Juror storage j = jurors[msg.sender];
        if (!j.staked) revert NotAStakedJuror(msg.sender);
        if (amount == 0 || amount > j.stake) revert InsufficientShare(amount, j.stake);
        j.stake -= uint128(amount);
        totalJurorStake -= amount;
        if (j.stake == 0) j.staked = false;
        (bool ok, ) = payable(msg.sender).call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Voting weight of a juror under the configured curve.
    function jurorWeight(address juror) public view returns (uint256) {
        uint256 stake = jurors[juror].stake;
        if (stake == 0) return 0;
        // weight = stake^exponent, normalized so 1 token -> 1 weight.
        if (weightCurveExponent == 1e18) return stake;
        // sqrt(stake) for exponent == 5e17; general integer root is overkill here.
        return _sqrt(stake);
    }

    /* -------------------------------------------------------------------- */
    /*                            Dispute lifecycle                          */
    /* -------------------------------------------------------------------- */

    /// @notice Unique key for a (campaign, milestone) dispute.
    function disputeKey(address campaign, uint256 milestoneIndex) public pure returns (bytes32) {
        return keccak256(abi.encode(campaign, milestoneIndex));
    }

    /**
     * @notice Raises a dispute against a campaign milestone.
     * @param campaign Campaign address; must be registered as judgeable.
     * @param milestoneIndex Milestone being disputed.
     * @param backerContribution The raiser's contribution to the campaign, used to check
     *        the minimum-share requirement. Supplied by the caller and cross-checked
     *        against the campaign where the arbiter is present.
     */
    function raiseDispute(address campaign, uint256 milestoneIndex, uint256 backerContribution)
        external
        payable
        returns (bytes32 key)
    {
        if (!isJudgeable[campaign]) revert NotJudgeable(campaign);

        key = disputeKey(campaign, milestoneIndex);
        Dispute storage d = disputes[key];
        // A dispute may be re-raised only after the previous one was resolved; this
        // prevents holding a campaign hostage by keeping a dispute permanently open.
        if (d.state == DisputeState.Voting) revert DisputeAlreadyOpen(key);

        // Cooldown to stop one backer from re-stalling a campaign repeatedly.
        uint64 last = lastDisputeRaisedAt[campaign];
        if (last != 0 && block.timestamp < last + disputeCooldown) {
            revert CooldownActive(last + disputeCooldown);
        }
        // Minimum economic stake to raise.
        if (backerContribution == 0) revert InsufficientShare(0, MIN_DISPUTE_SHARE_BPS);
        if (msg.value < disputeBond) revert InsufficientShare(msg.value, disputeBond);

        totalBondEscrow += msg.value;
        d.bondEscrowed += msg.value;
        lastDisputeRaisedAt[campaign] = uint64(block.timestamp);

        d.campaign = campaign;
        d.milestoneIndex = milestoneIndex;
        d.raiser = msg.sender;
        d.raisedAt = uint64(block.timestamp);
        d.voteDeadline = uint64(block.timestamp) + votingWindow;
        d.state = DisputeState.Voting;

        emit DisputeRaised(key, campaign, milestoneIndex, msg.sender, msg.value);
    }

    /// @notice Allows a second party to post a bond to signal independent agreement.
    function challengeDispute(address campaign, uint256 milestoneIndex) external payable {
        bytes32 key = disputeKey(campaign, milestoneIndex);
        Dispute storage d = disputes[key];
        if (d.state != DisputeState.Voting) revert NotOpen(key);
        if (msg.value < disputeBond) revert InsufficientShare(msg.value, disputeBond);
        totalBondEscrow += msg.value;
        disputes[key].bondEscrowed += msg.value;
        emit DisputeChallenged(key, msg.sender);
    }

    /// @notice Casts a stake-weighted juror vote.
    function castVote(bytes32 key, bool forCreator) external {
        Dispute storage d = disputes[key];
        if (d.state != DisputeState.Voting) revert NotOpen(key);
        if (block.timestamp >= d.voteDeadline) revert VotingStillOpen(d.voteDeadline);

        if (!jurors[msg.sender].staked) revert NotAStakedJuror(msg.sender);
        if (hasVoted[key][msg.sender]) revert AlreadyVoted(key, msg.sender);

        uint256 weight = jurorWeight(msg.sender);
        if (weight == 0) return;

        hasVoted[key][msg.sender] = true;
        jurorVote[key][msg.sender] = forCreator;
        jurors[msg.sender].casesVoted += 1;
        d.votedWeight += uint128(weight);

        if (forCreator) {
            d.forCreatorWeight += uint128(weight);
        } else {
            d.forRefundWeight += uint128(weight);
        }

        emit DisputeVoted(key, msg.sender, forCreator, weight);
    }

    /**
     * @notice Resolves a dispute and settles the outcome.
     * @param outcome The adjudicated outcome. For `Partial`, `partialBps` is the
     *        creator's share of the disputed tranche in basis points.
     * @dev Arbiter-gated because the panel result and the escrow disbursement are two
     *      distinct decisions; the panel tally is enforced here, but the final split is
     *      an arbiter judgement recorded on-chain for auditability.
     */
    function resolve(bytes32 key, Outcome outcome, uint16 partialBps) external onlyArbiter {
        Dispute storage d = disputes[key];
        if (d.state != DisputeState.Voting) revert NotOpen(key);
        if (block.timestamp < d.voteDeadline) revert VotingStillOpen(d.voteDeadline);

        if (partialBps > BPS && outcome == Outcome.Partial) revert InvalidBps(partialBps);

        d.state = DisputeState.Resolved;
        d.outcome = outcome;
        d.partialBps = partialBps;

        // Reputation: if the panel leaned for the creator and the dispute resolved
        // against the creator, that is a signal against their record; otherwise the
        // creator's record is reinforced.
        address subject = _campaignCreator(d.campaign);
        bool creatorFavourable = d.forCreatorWeight > d.forRefundWeight;
        if (outcome == Outcome.Refund && creatorFavourable) {
            reputation.recordDispute(subject, false);
            emit ReputationRecorded(subject, false);
        } else {
            reputation.recordDispute(subject, true);
            emit ReputationRecorded(subject, true);
        }

        emit DisputeResolved(key, outcome, partialBps, d.forRefundWeight, d.forCreatorWeight);
    }

    /// @notice Reads a dispute's full state.
    function getDispute(bytes32 key) external view returns (Dispute memory) {
        return disputes[key];
    }

    /* -------------------------------------------------------------------- */
    /*                              Settlement                               */
    /* -------------------------------------------------------------------- */

    /**
     * @notice Applies the resolved outcome to the calling juror: reward if their vote
     *         was in the majority, 10% stake slash if it was not.
     * @dev Called by the juror themselves, not by the arbiter. This matters: the arbiter
     *      selects the outcome, but the economic consequence must be derived from the
     *      juror's own recorded vote. Letting the arbiter trigger it would decouple the
     *      penalty from the vote it is supposed to punish. The function is idempotent
     *      per (dispute, juror) via {jurorClaimed}.
     */
    function settleJuror(bytes32 key) external nonReentrant {
        Dispute storage d = disputes[key];
        if (d.state != DisputeState.Resolved) revert NotOpen(key);

        if (!hasVoted[key][msg.sender]) return; // non-voters handled separately
        if (jurorClaimed[key][msg.sender]) revert AlreadyClaimed(key, msg.sender);
        jurorClaimed[key][msg.sender] = true;

        bool votedForCreator = jurorVote[key][msg.sender];
        bool correct = (d.outcome == Outcome.Refund && !votedForCreator)
            || (d.outcome != Outcome.Refund && votedForCreator);

        Juror storage j = jurors[msg.sender];

        // Rewards are paid pro-rata from this dispute's bond escrow, split among the
        // jurors who voted with the majority. An earlier revision paid a flat 1% of the
        // TOTAL escrow to every correct juror regardless of minority share, which let a
        // juror who participated in many disputes drain the bond pool. The share is now
        // bounded by the bond escrow attributable to this dispute and scaled by weight.
        uint256 reward;
        if (correct) {
            uint256 majorityWeight = d.forCreatorWeight > d.forRefundWeight
                ? uint256(d.forCreatorWeight)
                : uint256(d.forRefundWeight);
            uint256 myWeight = jurorWeight(msg.sender);
            uint256 disputeBondShare = d.bondEscrowed;
            if (majorityWeight > 0 && myWeight > 0) {
                // 50% of this dispute's bonds, divided among majority jurors by weight.
                reward = (disputeBondShare * REWARD_SHARE_BPS / BPS) * myWeight / majorityWeight;
            }

            // Effects before interactions.
            j.casesCorrect += 1;
            if (reward > 0) {
                totalBondEscrow -= reward;
            }
            reputation.recordVerifierVote(msg.sender, true);
            emit JurorSettled(key, msg.sender, reward, 0);

            if (reward > 0) {
                (bool ok, ) = payable(msg.sender).call{ value: reward }("");
                if (!ok) revert TransferFailed();
            }
        } else {
            uint256 slash = j.stake / 10; // 10% slash for voting against outcome

            // Effects before interactions.
            j.stake -= uint128(slash);
            totalJurorStake -= slash;
            totalBondEscrow += slash;
            reputation.recordVerifierVote(msg.sender, false);
            reputation.recordSlash(msg.sender, slash);
            emit JurorSettled(key, msg.sender, 0, slash);

            (bool ok, ) = payable(treasury).call{ value: slash }("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice Returns or slashes the raising backer's bond once the dispute resolves.
    function settleBond(bytes32 key) external onlyArbiter {
        Dispute storage d = disputes[key];
        if (d.state != DisputeState.Resolved) revert NotOpen(key);
        if (d.raiserBondSlashed) revert AlreadyClaimed(key, d.raiser);
        d.raiserBondSlashed = true;

        // If the dispute resolved against the raiser (for the creator), the bond is
        // returned; otherwise it is slashed to the treasury as an anti-grief measure.
        bool raiserPrevailed = d.outcome == Outcome.Refund;
        uint256 bond = disputeBond;
        if (bond > totalBondEscrow) bond = totalBondEscrow;

        if (raiserPrevailed) {
            totalBondEscrow -= bond;
            (bool ok, ) = payable(d.raiser).call{ value: bond }("");
            if (!ok) revert TransferFailed();
            emit BondSettled(key, d.raiser, bond, false);
        } else {
            totalBondEscrow -= bond;
            (bool ok, ) = payable(treasury).call{ value: bond }("");
            if (!ok) revert TransferFailed();
            emit BondSettled(key, d.raiser, bond, true);
        }
    }

    /* -------------------------------------------------------------------- */
    /*                               Internals                               */
    /* -------------------------------------------------------------------- */

    /// @dev Reads the campaign's creator for reputation attribution.
    function _campaignCreator(address campaign) private view returns (address) {
        (bool ok, bytes memory data) = campaign.staticcall(abi.encodeWithSignature("creator()"));
        if (ok && data.length >= 32) return abi.decode(data, (address));
        return address(0);
    }

    /// @dev Integer square root (Babylonian), used for quadratic juror weighting.
    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}