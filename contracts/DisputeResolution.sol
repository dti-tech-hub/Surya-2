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
 *      Milestone verification answers "was the work delivered?". This module answers
 *      the harder question: "the verifier panel was wrong or the creator was wrong —
 *      who gets the escrow?". It exists because pure reputation voting has no recourse
 *      when the electorate is itself compromised.
 *
 *      Flow
 *        1. A backer with a non-zero contribution raises a dispute against a milestone,
 *           posting {disputeBond}. The campaign is queried on-chain for the caller's
 *           contribution; a caller-supplied number is no longer trusted.
 *        2. Jurors are drawn from the staked pool. Each juror votes once; the vote
 *           weight is stake-derived and snapshotted at vote time.
 *        3. After {votingWindow}, anyone calls {resolve}. The outcome is derived from
 *           the tally, not chosen by an administrator:
 *              refund weight > creator weight  -> REFUND
 *              creator weight > refund weight  -> RELEASE
 *              tie                              -> PARTIAL (50/50 split)
 *              no votes                         -> REFUND (fail closed for backers)
 *        4. {resolve} calls {Campaign.resolveDispute}, so the verdict actually moves
 *           escrow. An appeal path that cannot change the outcome is not an appeal.
 *        5. Bonds and juror stakes settle. Jurors must settle to unlock their stake.
 *
 *      Anti-whale voting
 *      -----------------
 *      Weight can be linear (exponent 1e18) or sublinear (exponent 0.5e18, i.e. square
 *      root). Doubling stake then buys only ~1.41x influence.
 *
 *      Griefing
 *      --------
 *      Raising a dispute costs a bond. A dispute with no votes is treated as a refund
 *      and the raiser's bond is slashed to the treasury, so spamming empty disputes is
 *      not free. A per-campaign cooldown bounds repeated stalling.
 *
 *      Known limitation
 *      ----------------
 *      There is no commit-reveal phase. Votes are visible in the mempool and jurors can
 *      follow the crowd; this is documented in security/THREAT_MODEL.md.
 */
contract DisputeResolution is ReentrancyGuard {
    /* -------------------------------------------------------------------- */
    /*                                  Types                                */
    /* -------------------------------------------------------------------- */

    /// @notice Outcome of a resolved dispute. Values are shared with {Campaign}.
    enum Outcome {
        None,
        Refund, // remaining escrow returned to backers
        Release, // tranche released to creator
        Partial // tie: split the disputed tranche 50/50
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
        uint256 bondEscrowed; // all bonds posted to THIS dispute
        uint256 raiserBond; // bond posted by the raiser specifically
        uint256 rewardPool; // bond share reserved for correct jurors
        bool bondsSettled;
    }

    struct Juror {
        uint128 stake;
        uint128 lockedStake;
        bool staked;
        uint256 casesVoted;
        uint256 casesCorrect;
    }

    /* -------------------------------------------------------------------- */
    /*                                Constants                              */
    /* -------------------------------------------------------------------- */

    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_STAKE = 1e17; // 0.1 token to serve as juror
    uint256 public constant REWARD_SHARE_BPS = 5_000; // 50% of a losing raiser bond
    uint16 public constant DEFAULT_JUROR_SLASH_BPS = 1_000; // 10% of vote-time stake

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

    mapping(address => bool) public isJudgeable;
    mapping(address => bool) public isRegistrar;

    uint256 public disputeBond = 0.05 ether;
    uint64 public votingWindow = 3 days;
    uint64 public disputeCooldown = 1 days;
    uint16 public jurorSlashBps = DEFAULT_JUROR_SLASH_BPS;

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
    /// @notice (disputeKey, juror) => weight snapshotted at vote time.
    mapping(bytes32 => mapping(address => uint256)) public jurorVoteWeight;
    /// @notice (disputeKey, juror) => stake snapshotted at vote time (for slashing).
    mapping(bytes32 => mapping(address => uint256)) public jurorVoteStake;
    mapping(bytes32 => mapping(address => bool)) public jurorClaimed;

    uint256 public totalJurorStake;
    uint256 public totalBondEscrow;

    /* -------------------------------------------------------------------- */
    /*                                  Events                               */
    /* -------------------------------------------------------------------- */

    event AdminTransferred(address indexed from, address indexed to);
    event RegistrarUpdated(address indexed registrar, bool allowed);
    event JudgeableUpdated(address indexed campaign, bool allowed);
    event ParametersUpdated(
        uint256 disputeBond,
        uint64 votingWindow,
        uint64 disputeCooldown,
        uint256 weightCurveExponent,
        uint16 jurorSlashBps
    );
    event DisputeRaised(
        bytes32 indexed disputeKey,
        address indexed campaign,
        uint256 indexed milestoneIndex,
        address raiser,
        uint256 bond
    );
    event DisputeChallenged(bytes32 indexed disputeKey, address indexed challenger, uint256 bond);
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
    error NotRegistrar(address caller);
    error NotJudgeable(address campaign);
    error ZeroAddress();
    error NotBacker(address caller);
    error InvalidMilestone(uint256 index);
    error CampaignNotDisputable(address campaign);
    error InsufficientShare(uint256 provided, uint256 required);
    error CooldownActive(uint256 retryAfter);
    error DisputeAlreadyOpen(bytes32 disputeKey);
    error UnknownDispute(bytes32 disputeKey);
    error VotingStillOpen(uint64 deadline);
    error NotOpen(bytes32 disputeKey);
    error AlreadyVoted(bytes32 disputeKey, address juror);
    error NotAStakedJuror(address juror);
    error AlreadyClaimed(bytes32 disputeKey, address juror);
    error InvalidBps(uint256 value);
    error TransferFailed();
    error EscrowUpdateFailed();
    error NoVotes(bytes32 disputeKey);

    /* -------------------------------------------------------------------- */
    /*                                 Modifiers                             */
    /* -------------------------------------------------------------------- */

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
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

    /// @notice Grants or revokes the right to register judgeable campaigns.
    function setRegistrar(address registrar, bool allowed) external onlyAdmin {
        if (registrar == address(0)) revert ZeroAddress();
        isRegistrar[registrar] = allowed;
        emit RegistrarUpdated(registrar, allowed);
    }

    function setJudgeable(address campaign, bool allowed) external onlyAdmin {
        if (campaign == address(0)) revert ZeroAddress();
        isJudgeable[campaign] = allowed;
        emit JudgeableUpdated(campaign, allowed);
    }

    /// @notice Registers a campaign deployed by the authorised factory.
    function registerCampaign(address campaign) external {
        if (msg.sender != admin && !isRegistrar[msg.sender]) revert NotRegistrar(msg.sender);
        if (campaign == address(0)) revert ZeroAddress();
        isJudgeable[campaign] = true;
        emit JudgeableUpdated(campaign, true);
    }

    function setParameters(
        uint256 bond,
        uint64 window,
        uint64 cooldown,
        uint256 exponent,
        uint16 slashBps
    ) public onlyAdmin {
        if (exponent > 1e18) revert InvalidBps(exponent);
        if (slashBps > BPS) revert InvalidBps(slashBps);
        disputeBond = bond;
        votingWindow = window;
        disputeCooldown = cooldown;
        weightCurveExponent = exponent;
        jurorSlashBps = slashBps;
        emit ParametersUpdated(bond, window, cooldown, exponent, slashBps);
    }

    /* -------------------------------------------------------------------- */
    /*                            Juror staking                             */
    /* -------------------------------------------------------------------- */

    /// @notice Stake to be eligible as a juror.
    function stakeJuror() external payable {
        if (msg.value < MIN_STAKE) revert InsufficientShare(msg.value, MIN_STAKE);
        Juror storage j = jurors[msg.sender];
        j.staked = true;
        j.stake += uint128(msg.value);
        totalJurorStake += msg.value;
    }

    /// @notice Withdraws unlocked juror stake.
    /// @dev Stake used in a live dispute is locked until that juror calls {settleJuror}.
    ///      This closes the vote-then-withdraw evasion where a juror could escape a
    ///      minority slash by draining their stake before settlement.
    function withdrawJurorStake(uint256 amount) external nonReentrant {
        Juror storage j = jurors[msg.sender];
        if (!j.staked) revert NotAStakedJuror(msg.sender);
        uint256 available = uint256(j.stake) - uint256(j.lockedStake);
        if (amount == 0 || amount > available) revert InsufficientShare(amount, available);

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
        if (weightCurveExponent == 1e18) return stake;
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
     * @dev The caller must be an on-chain backer of `campaign`; the contribution is
     *      read from the campaign, not supplied by the caller.
     */
    function raiseDispute(address campaign, uint256 milestoneIndex)
        external
        payable
        returns (bytes32 key)
    {
        if (!isJudgeable[campaign]) revert NotJudgeable(campaign);

        (bool stateOk, uint256 campaignState) = _staticUint(campaign, "state()");
        if (stateOk && campaignState >= 2) revert CampaignNotDisputable(campaign);

        (bool countOk, uint256 count) = _staticUint(campaign, "milestoneCount()");
        if (countOk && milestoneIndex >= count) revert InvalidMilestone(milestoneIndex);

        (bool contributionOk, uint256 contribution) =
            _staticUint(campaign, "contributionOf(address)", msg.sender);
        if (!contributionOk || contribution == 0) revert NotBacker(msg.sender);

        key = disputeKey(campaign, milestoneIndex);
        Dispute storage d = disputes[key];
        if (d.state == DisputeState.Voting) revert DisputeAlreadyOpen(key);

        uint64 last = lastDisputeRaisedAt[campaign];
        if (last != 0 && block.timestamp < last + disputeCooldown) {
            revert CooldownActive(last + disputeCooldown);
        }
        if (msg.value < disputeBond) revert InsufficientShare(msg.value, disputeBond);

        totalBondEscrow += msg.value;
        lastDisputeRaisedAt[campaign] = uint64(block.timestamp);

        d.campaign = campaign;
        d.milestoneIndex = milestoneIndex;
        d.raiser = msg.sender;
        d.raisedAt = uint64(block.timestamp);
        d.voteDeadline = uint64(block.timestamp) + votingWindow;
        d.state = DisputeState.Voting;
        d.outcome = Outcome.None;
        d.partialBps = 0;
        d.forRefundWeight = 0;
        d.forCreatorWeight = 0;
        d.votedWeight = 0;
        d.bondEscrowed = msg.value;
        d.raiserBond = msg.value;
        d.rewardPool = 0;
        d.bondsSettled = false;

        emit DisputeRaised(key, campaign, milestoneIndex, msg.sender, msg.value);
    }

    /// @notice Allows a second party to post an additional bond.
    /// @dev Challenge bonds are anti-grief deposits; they are not tied to a vote and are
    ///      routed to the treasury when the dispute resolves.
    function challengeDispute(address campaign, uint256 milestoneIndex) external payable {
        bytes32 key = disputeKey(campaign, milestoneIndex);
        Dispute storage d = disputes[key];
        if (d.state != DisputeState.Voting) revert NotOpen(key);
        if (msg.value < disputeBond) revert InsufficientShare(msg.value, disputeBond);
        totalBondEscrow += msg.value;
        d.bondEscrowed += msg.value;
        emit DisputeChallenged(key, msg.sender, msg.value);
    }

    /// @notice Casts a stake-weighted juror vote.
    function castVote(bytes32 key, bool forCreator) external {
        Dispute storage d = disputes[key];
        if (d.state != DisputeState.Voting) revert NotOpen(key);
        if (block.timestamp >= d.voteDeadline) revert VotingStillOpen(d.voteDeadline);

        Juror storage j = jurors[msg.sender];
        if (!j.staked) revert NotAStakedJuror(msg.sender);
        if (hasVoted[key][msg.sender]) revert AlreadyVoted(key, msg.sender);

        uint256 weight = jurorWeight(msg.sender);
        if (weight == 0) revert NotAStakedJuror(msg.sender);

        hasVoted[key][msg.sender] = true;
        jurorVote[key][msg.sender] = forCreator;
        jurorVoteWeight[key][msg.sender] = weight;
        jurorVoteStake[key][msg.sender] = j.stake;
        j.lockedStake += uint128(j.stake);
        j.casesVoted += 1;

        d.votedWeight += uint128(weight);
        if (forCreator) {
            d.forCreatorWeight += uint128(weight);
        } else {
            d.forRefundWeight += uint128(weight);
        }

        emit DisputeVoted(key, msg.sender, forCreator, weight);
    }

    /**
     * @notice Resolves a dispute from the recorded tally.
     * @dev Permissionless: no administrator chooses the outcome. The verdict is then
     *      pushed into the campaign, which applies the escrow effect.
     */
    function resolve(bytes32 key) external nonReentrant {
        Dispute storage d = disputes[key];
        if (d.state != DisputeState.Voting) revert NotOpen(key);
        if (block.timestamp < d.voteDeadline) revert VotingStillOpen(d.voteDeadline);

        bool noVotes = d.votedWeight == 0;
        Outcome outcome;
        uint16 partialBps;

        if (noVotes) {
            // Fail closed for backers: without a panel decision the creator does not
            // receive the tranche. The raiser's bond is slashed to deter empty disputes.
            outcome = Outcome.Refund;
        } else if (d.forRefundWeight > d.forCreatorWeight) {
            outcome = Outcome.Refund;
        } else if (d.forCreatorWeight > d.forRefundWeight) {
            outcome = Outcome.Release;
        } else {
            outcome = Outcome.Partial;
            partialBps = 5_000; // exact tie: 50/50
        }

        d.state = DisputeState.Resolved;
        d.outcome = outcome;
        d.partialBps = partialBps;

        _settleBonds(key, d, outcome, noVotes);

        // The whole point of the appeal: push the verdict into escrow.
        (bool ok, ) = d.campaign.call(
            abi.encodeWithSignature(
                "resolveDispute(uint256,uint8,uint16)",
                d.milestoneIndex,
                uint8(outcome),
                partialBps
            )
        );
        if (!ok) revert EscrowUpdateFailed();

        address subject = _campaignCreator(d.campaign);
        if (subject != address(0)) {
            bool creatorWon = outcome != Outcome.Refund;
            reputation.recordDispute(subject, creatorWon);
            emit ReputationRecorded(subject, creatorWon);
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

    /// @dev Returns or slashes the raiser bond and reserves the juror reward pool.
    function _settleBonds(bytes32 key, Dispute storage d, Outcome outcome, bool noVotes) private {
        uint256 escrow = d.bondEscrowed;
        uint256 raiserBond = d.raiserBond;
        d.bondsSettled = true;

        if (escrow == 0) return;
        totalBondEscrow -= escrow;
        d.bondEscrowed = 0;

        bool raiserPrevails = outcome == Outcome.Refund && !noVotes;
        uint256 toTreasury;

        if (raiserPrevails) {
            if (raiserBond > 0) {
                (bool ok, ) = payable(d.raiser).call{ value: raiserBond }("");
                if (!ok) revert TransferFailed();
                emit BondSettled(key, d.raiser, raiserBond, false);
            }
            toTreasury = escrow - raiserBond;
        } else {
            // Losing raiser: part of the bond funds correct jurors. With no votes at
            // all there is nobody to reward, so the entire bond goes to the treasury.
            uint256 reward = noVotes ? 0 : (raiserBond * REWARD_SHARE_BPS) / BPS;
            d.rewardPool = reward;
            toTreasury = escrow - reward;
            emit BondSettled(key, d.raiser, raiserBond, true);
        }

        if (toTreasury > 0) {
            (bool ok, ) = payable(treasury).call{ value: toTreasury }("");
            if (!ok) revert TransferFailed();
        }
    }

    /**
     * @notice Applies a resolved dispute's consequences to the calling juror: a reward
     *         if their vote matched the outcome, a stake slash if it did not. Also
     *         unlocks the stake snapshotted at vote time.
     */
    function settleJuror(bytes32 key) external nonReentrant {
        Dispute storage d = disputes[key];
        if (d.state != DisputeState.Resolved) revert NotOpen(key);

        if (!hasVoted[key][msg.sender]) return;
        if (jurorClaimed[key][msg.sender]) revert AlreadyClaimed(key, msg.sender);
        jurorClaimed[key][msg.sender] = true;

        Juror storage j = jurors[msg.sender];
        uint256 weight = jurorVoteWeight[key][msg.sender];
        uint256 voteStake = jurorVoteStake[key][msg.sender];

        // Unlock the stake that was reserved at vote time, whatever the outcome.
        if (j.lockedStake >= voteStake) {
            j.lockedStake -= uint128(voteStake);
        } else {
            j.lockedStake = 0;
        }

        bool votedForCreator = jurorVote[key][msg.sender];
        bool correct;
        if (d.outcome == Outcome.Refund) {
            correct = !votedForCreator;
        } else if (d.outcome == Outcome.Release) {
            correct = votedForCreator;
        } else {
            // A tie is not a clear repudiation of either side; reward all voters and
            // slash nobody.
            correct = true;
        }

        if (correct) {
            _settleCorrectJuror(key, d, j, weight);
        } else {
            _settleIncorrectJuror(key, j, voteStake);
        }
    }

    function _settleCorrectJuror(
        bytes32 key,
        Dispute storage d,
        Juror storage j,
        uint256 weight
    ) private {
        uint256 correctWeight = d.outcome == Outcome.Refund
            ? uint256(d.forRefundWeight)
            : uint256(d.forCreatorWeight);
        if (d.outcome == Outcome.Partial) {
            correctWeight = d.votedWeight; // everyone is correct in a tie
        }

        uint256 reward;
        if (d.rewardPool > 0 && correctWeight > 0 && weight > 0) {
            reward = (d.rewardPool * weight) / correctWeight;
            if (reward > d.rewardPool) reward = d.rewardPool;
            d.rewardPool -= reward;
        }

        j.casesCorrect += 1;
        reputation.recordVerifierVote(msg.sender, true);
        emit JurorSettled(key, msg.sender, reward, 0);

        if (reward > 0) {
            (bool ok, ) = payable(msg.sender).call{ value: reward }("");
            if (!ok) revert TransferFailed();
        }
    }

    function _settleIncorrectJuror(bytes32 key, Juror storage j, uint256 voteStake) private {
        uint256 staked = j.stake;
        uint256 base = voteStake < staked ? voteStake : staked;
        uint256 slash = (base * jurorSlashBps) / BPS;

        if (slash > 0) {
            j.stake -= uint128(slash);
            totalJurorStake -= slash;
            if (j.stake == 0) j.staked = false;
        }

        reputation.recordVerifierVote(msg.sender, false);
        if (slash > 0) {
            reputation.recordSlash(msg.sender, slash);
        }
        emit JurorSettled(key, msg.sender, 0, slash);

        if (slash > 0) {
            (bool ok, ) = payable(treasury).call{ value: slash }("");
            if (!ok) revert TransferFailed();
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

    /// @dev Static-calls a view returning one uint256, tolerating non-supporting targets.
    function _staticUint(address target, string memory signature)
        private
        view
        returns (bool ok, uint256 value)
    {
        bytes memory data;
        (ok, data) = target.staticcall(abi.encodeWithSignature(signature));
        if (ok && data.length >= 32) value = abi.decode(data, (uint256));
    }

    function _staticUint(address target, string memory signature, address arg)
        private
        view
        returns (bool ok, uint256 value)
    {
        bytes memory data;
        (ok, data) = target.staticcall(abi.encodeWithSignature(signature, arg));
        if (ok && data.length >= 32) value = abi.decode(data, (uint256));
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
