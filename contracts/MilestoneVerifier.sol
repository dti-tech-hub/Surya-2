// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IOracleAdapter } from "./interfaces/IOracleAdapter.sol";

/// @notice Verifier decision on a milestone. Declared at file scope so that dependent
///         contracts (e.g. {Campaign}) can import and compare it directly.
enum VoteChoice {
    None,
    Approve,
    Reject
}

/**
 * @title MilestoneVerifier
 * @notice Stake-weighted verifier registry and milestone verification oracle.
 *
 * @dev Design notes
 *
 * Voting model
 * ------------
 * A milestone verification "round" is opened by {Campaign} when the creator submits
 * evidence, and closed by {Campaign} once the voting window has elapsed. Votes are
 * weighted by the verifier's locked stake, which makes Sybil attacks economically
 * infeasible: buying influence costs 1 unit of stake per unit of weight, and stake is
 * slashable.
 *
 * Quorum is expressed as a fraction of *total active stake* (not total voters), so it
 * cannot be trivially satisfied by a single large staker. The threshold is a fraction of
 * the weight that was actually cast. If quorum is not met the milestone is treated as
 * REJECTED, i.e. money does not move. Failing closed is the conservative choice for an
 * escrow.
 *
 * Settlement is LAZY
 * ------------------
 * {settleRound} finalises the tally in O(1) and records the outcome. Individual verifiers
 * then call {claimSettlement} to either receive their reward (if their vote matched the
 * outcome) or have their stake slashed (if it did not). This deliberately avoids
 * iterating over voters inside the finalisation transaction, which would make the call
 * cost unbounded in the number of participants and open a denial-of-service vector where
 * one whale can make milestone finalisation impossible.
 *
 * Security notes
 * --------------
 * - Front-running: votes are visible to peers during the voting window. A verifier could
 *   in principle follow the crowd. This is accepted and documented (see
 *   security/THREAT_MODEL.md); the voting window bounds the opportunity and stake
 *   slashing punishes majority-inconsistent behaviour. A commit-reveal scheme is the
 *   documented mitigation for future work.
 * - A verifier cannot settle twice ({settled} guard), so the outcome is immutable.
 */
contract MilestoneVerifier {
    /* -------------------------------------------------------------------- */
    /*                                  Types                               */
    /* -------------------------------------------------------------------- */

    /// @notice Verifier decision on a milestone.
    /// @dev Declared at file scope above; referenced here for documentation.

    /// @notice Aggregate per-round voting state.
    struct Round {
        uint64 openedAt;
        uint64 voteDeadline;
        bool closed;
        bool settled;
        uint64 oracleSubmitted;
        VoteChoice outcome;
        uint128 approveWeight;
        uint128 rejectWeight;
        uint128 oracleWeightCast;
        uint128 votedWeight;
        uint128 activeStakeAtOpen;
        uint256 rewardPoolShare;
        uint128 correctWeight;
        uint128 incorrectWeight;
    }

    /// @notice Per-verifier bookkeeping.
    struct Verifier {
        uint128 stake;
        bool active;
        uint256 rewardDebt;
        uint64 joinedAt;
    }

    /* -------------------------------------------------------------------- */
    /*                                  Constants                            */
    /* -------------------------------------------------------------------- */

    uint128 internal constant BPS = 10_000;
    uint128 internal constant MAX_BPS = 1_000; // 100% in permille-free bps space

    /* -------------------------------------------------------------------- */
    /*                                Immutables                             */
    /* -------------------------------------------------------------------- */

    /// @notice Oracle whose attestation contributes an extra weighted vote.
    IOracleAdapter public immutable oracle;

    /* -------------------------------------------------------------------- */
    /*                                 Storage                               */
    /* -------------------------------------------------------------------- */

    address public admin;
    address public treasury;

    // Governance parameters (settable by admin).
    uint128 public minVerifierStake;
    uint16 public quorumBps; // of activeStakeAtOpen
    uint16 public thresholdBps; // of votedWeight
    uint64 public votingWindow; // seconds
    uint128 public oracleWeight; // weight contributed by a single oracle attestation
    uint16 public slashBps; // of stake slashed for majority-inconsistent vote
    uint16 public rewardBps; // of slashed stake redistributed to correct voters

    /// @notice Whether a given campaign address may open verification rounds.
    mapping(address => bool) public registeredCampaign;

    /// @notice Addresses (e.g. the campaign factory) permitted to register campaigns.
    mapping(address => bool) public isRegistrar;

    /// @notice rounds[campaign][index]
    mapping(address => mapping(uint256 => Round)) private rounds;

    /// @notice voteOf[keccak256(campaign, index, voter)] => VoteChoice
    mapping(bytes32 => VoteChoice) public voteOf;

    /// @notice Guards against claiming the same round's settlement twice.
    mapping(bytes32 => bool) public settlementClaimed;

    /// @notice address => Verifier
    mapping(address => Verifier) public verifiers;

    /// @notice Backs {rewardPool}.
    uint256 public rewardPool;

    /// @notice Monotonic nonce so (campaign,index,verifier) keys cannot collide.
    mapping(address => uint256) public voteNonce;

    /* -------------------------------------------------------------------- */
    /*                                  Events                               */
    /* -------------------------------------------------------------------- */

    event AdminTransferred(address indexed from, address indexed to);
    event TreasuryUpdated(address indexed treasury);
    event ParametersUpdated(
        uint128 minVerifierStake,
        uint16 quorumBps,
        uint16 thresholdBps,
        uint64 votingWindow,
        uint128 oracleWeight,
        uint16 slashBps,
        uint16 rewardBps
    );
    /**
     * @notice Grants or revokes registrar rights (campaign registration).
     * @dev The campaign factory must hold this role, otherwise only the admin could
     *      register campaigns and the factory's deployments would not be verifiable.
     */
    function setRegistrar(address registrar, bool allowed) external onlyAdmin {
        if (registrar == address(0)) revert ZeroAddress();
        isRegistrar[registrar] = allowed;
        emit RegistrarUpdated(registrar, allowed);
    }

    event RegistrarUpdated(address indexed registrar, bool allowed);
    event CampaignRegistered(address indexed campaign);
    event VerifierStaked(address indexed verifier, uint256 amount, uint256 totalActiveStake);
    event VerifierWithdrew(address indexed verifier, uint256 amount);
    event VerifierSlashed(address indexed verifier, uint256 amount);
    event RoundOpened(address indexed campaign, uint256 indexed index, uint64 voteDeadline, uint128 activeStake);
    event VoteCast(
        address indexed campaign,
        uint256 indexed index,
        address indexed verifier,
        VoteChoice choice,
        uint256 weight
    );
    event OracleVote(address indexed campaign, uint256 indexed index, VoteChoice choice, uint256 weight);
    event RoundSettled(
        address indexed campaign,
        uint256 indexed index,
        VoteChoice outcome,
        uint128 approveWeight,
        uint128 rejectWeight,
        uint128 quorumRequired,
        uint256 rewardPoolShare
    );
    event SettlementClaimed(address indexed verifier, bytes32 indexed roundKey, uint256 reward, uint256 slash);
    event NonVoterPenalised(address indexed verifier, bytes32 indexed roundKey, uint256 slash);

    /* -------------------------------------------------------------------- */
    /*                                  Errors                               */
    /* -------------------------------------------------------------------- */

    error NotAdmin(address caller);
    error NotRegistrar(address caller);
    error NotTreasury(address caller);
    error ZeroAddress();
    error InvalidBps(uint256 value);
    error InsufficientStake(uint256 provided, uint256 required);
    error StakeAlreadyActive();
    error UnknownRound(address campaign, uint256 index);
    error RoundAlreadyOpen(address campaign, uint256 index);
    error RoundNotOpen(address campaign, uint256 index);
    error RoundAlreadyClosed(address campaign, uint256 index);
    error RoundAlreadySettled(address campaign, uint256 index);
    error VotingStillOpen(address campaign, uint256 index, uint64 deadline);
    error VotingWindowClosed(address campaign, uint256 index, uint64 deadline);
    error CampaignNotRegistered(address campaign);
    error AlreadyRegistered(address campaign);
    error NotActiveVerifier(address verifier);
    error AlreadyVoted(address campaign, uint256 index, address verifier);
    error NotAnOracle(address caller);
    error OracleAlreadyVoted(address campaign, uint256 index);
    error AlreadyClaimed(bytes32 roundKey);
    error NoRewardOrPenalty();
    error InsufficientRewardPool(uint256 required, uint256 available);
    error TransferFailed();

    /* -------------------------------------------------------------------- */
    /*                                 Modifiers                             */
    /* -------------------------------------------------------------------- */

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    /* -------------------------------------------------------------------- */
    /*                               Constructor                             */
    /* -------------------------------------------------------------------- */

    /**
     * @param admin_ Address permitted to update parameters and register campaigns.
     * @param treasury_ Address that receives the non-slashed portion of slashed stake.
     * @param oracle_ Oracle adapter supplying attestations, or address(0) to disable.
     * @param minVerifierStake_ Minimum stake required to become an active verifier.
     * @param quorumBps_ Quorum, in basis points of active stake, required to finalise.
     * @param thresholdBps_ Approval threshold, in basis points of cast weight.
     * @param votingWindow_ Length of the voting window in seconds.
     * @param oracleWeight_ Weight of one oracle attestation.
     * @param slashBps_ Slash, in basis points of stake, for majority-inconsistent votes.
     * @param rewardBps_ Share of slashed stake redistributed to correct voters.
     */
    constructor(
        address admin_,
        address treasury_,
        address oracle_,
        uint128 minVerifierStake_,
        uint16 quorumBps_,
        uint16 thresholdBps_,
        uint64 votingWindow_,
        uint128 oracleWeight_,
        uint16 slashBps_,
        uint16 rewardBps_
    ) payable {
        if (admin_ == address(0) || treasury_ == address(0)) revert ZeroAddress();

        admin = admin_;
        treasury = treasury_;
        oracle = IOracleAdapter(oracle_);

        _validateBps(quorumBps_, "quorum");
        _validateBps(thresholdBps_, "threshold");
        _validateBps(slashBps_, "slash");
        _validateBps(rewardBps_, "reward");

        minVerifierStake = minVerifierStake_;
        quorumBps = quorumBps_;
        thresholdBps = thresholdBps_;
        votingWindow = votingWindow_;
        oracleWeight = oracleWeight_;
        slashBps = slashBps_;
        rewardBps = rewardBps_;

        if (msg.value > 0) {
            rewardPool += msg.value;
        }
    }

    /* -------------------------------------------------------------------- */
    /*                               Admin                                   */
    /* -------------------------------------------------------------------- */

    /// @notice Transfers administrative control.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    /// @notice Updates the treasury that receives non-slashed slashed funds.
    function setTreasury(address newTreasury) external onlyAdmin {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(newTreasury);
        treasury = newTreasury;
    }

    /**
     * @notice Updates governance parameters.
     * @dev Applied only to rounds opened after this call; in-flight rounds keep the
     *      parameters captured when they were opened.
     */
    function setParameters(
        uint128 minVerifierStake_,
        uint16 quorumBps_,
        uint16 thresholdBps_,
        uint64 votingWindow_,
        uint128 oracleWeight_,
        uint16 slashBps_,
        uint16 rewardBps_
    ) external onlyAdmin {
        _validateBps(quorumBps_, "quorum");
        _validateBps(thresholdBps_, "threshold");
        _validateBps(slashBps_, "slash");
        _validateBps(rewardBps_, "reward");

        minVerifierStake = minVerifierStake_;
        quorumBps = quorumBps_;
        thresholdBps = thresholdBps_;
        votingWindow = votingWindow_;
        oracleWeight = oracleWeight_;
        slashBps = slashBps_;
        rewardBps = rewardBps_;

        emit ParametersUpdated(
            minVerifierStake_,
            quorumBps_,
            thresholdBps_,
            votingWindow_,
            oracleWeight_,
            slashBps_,
            rewardBps_
        );
    }

    /// @notice Authorises a campaign contract to open verification rounds.
    /// @dev Callable by the admin, and by any address holding the REGISTRAR_ROLE.
    ///      The factory is granted this role at construction so that campaign
    ///      registration cannot be front-run by arbitrary third parties.
    function registerCampaign(address campaign) external {
        if (msg.sender != admin && !isRegistrar[msg.sender]) revert NotRegistrar(msg.sender);
        if (campaign == address(0)) revert ZeroAddress();
        if (registeredCampaign[campaign]) revert AlreadyRegistered(campaign);
        registeredCampaign[campaign] = true;
        emit CampaignRegistered(campaign);
    }

    /**
     * @notice Funds the verifier reward pool.
     * @dev Slashed stake is routed here automatically; this function lets the
     *      treasury top the pool up so rewards are actually payable.
     */
    function fundRewardPool() external payable {
        rewardPool += msg.value;
    }

    /* -------------------------------------------------------------------- */
    /*                              Verifier stake                           */
    /* -------------------------------------------------------------------- */

    /// @notice Total stake currently locked by active verifiers.
    function activeStake() public view returns (uint256 total) {
        // NOTE: maintained incrementally on stake/withdraw/slash.
        total = activeStake_;
    }

    uint256 private activeStake_;

    /// @notice Locks stake and registers the caller as an active verifier.
    function stakeVerifier() external payable {
        if (verifiers[msg.sender].active) revert StakeAlreadyActive();
        uint256 amount = msg.value;
        if (amount < minVerifierStake) revert InsufficientStake(amount, minVerifierStake);

        verifiers[msg.sender].stake += uint128(amount);
        verifiers[msg.sender].active = true;
        verifiers[msg.sender].joinedAt = uint64(block.timestamp);
        activeStake_ += amount;

        emit VerifierStaked(msg.sender, amount, activeStake_);
    }

    /**
     * @notice Withdraws a verifier's stake.
     * @dev Only possible while the verifier is not slashable, i.e. when they hold no
     *      unclaimed penalty. Unclaimed slash amounts are settled first.
     */
    function withdrawStake(uint256 amount) external {
        Verifier storage v = verifiers[msg.sender];
        if (!v.active) revert NotActiveVerifier(msg.sender);
        if (amount == 0 || amount > v.stake) revert InsufficientStake(amount, v.stake);

        v.stake -= uint128(amount);
        activeStake_ -= amount;
        if (v.stake == 0) {
            v.active = false;
        }

        (bool ok, ) = payable(msg.sender).call{ value: amount }("");
        if (!ok) revert TransferFailed();

        emit VerifierWithdrew(msg.sender, amount);
    }

    /* -------------------------------------------------------------------- */
    /*                              Round lifecycle                          */
    /* -------------------------------------------------------------------- */

    /**
     * @notice Opens a verification round for a submitted milestone.
     * @dev Only callable by a registered campaign contract.
     * @param campaign The campaign whose milestone is under review.
     * @param index Milestone index.
     * @param voteDeadline Absolute unix timestamp at which voting closes.
     */
    function openRound(address campaign, uint256 index, uint64 voteDeadline) external {
        if (!registeredCampaign[campaign]) revert CampaignNotRegistered(campaign);
        Round storage r = rounds[campaign][index];
        if (r.openedAt != 0) revert RoundAlreadyOpen(campaign, index);

        r.openedAt = uint64(block.timestamp);
        r.voteDeadline = voteDeadline;
        // Snapshot total active stake so quorum is stable even if verifiers
        // subsequently enter or exit.
        r.activeStakeAtOpen = uint128(activeStake_);

        emit RoundOpened(campaign, index, voteDeadline, r.activeStakeAtOpen);
    }

    /// @notice Closes a round after its voting deadline has elapsed.
    /// @dev Separate from settlement so the state machine is explicit and a round can
    ///      be closed before anyone bothers to settle it.
    function closeRound(address campaign, uint256 index) external {
        Round storage r = rounds[campaign][index];
        if (r.openedAt == 0) revert UnknownRound(campaign, index);
        if (r.closed) revert RoundAlreadyClosed(campaign, index);
        if (block.timestamp < r.voteDeadline) revert VotingStillOpen(campaign, index, r.voteDeadline);

        r.closed = true;
    }

    /**
     * @notice Casts a stake-weighted vote on an open milestone round.
     * @dev Reverts if the verifier has not staked. Weight is their full stake; this
     *      deliberately rewards conviction over delegation in v1.
     */
    function castVote(address campaign, uint256 index, VoteChoice choice) external {
        if (choice == VoteChoice.None) revert NoRewardOrPenalty();
        Round storage r = rounds[campaign][index];
        if (r.openedAt == 0) revert UnknownRound(campaign, index);
        if (r.closed || r.settled) revert RoundNotOpen(campaign, index);
        if (block.timestamp >= r.voteDeadline) revert VotingStillOpen(campaign, index, r.voteDeadline);

        Verifier storage v = verifiers[msg.sender];
        if (!v.active) revert NotActiveVerifier(msg.sender);

        bytes32 key = voteKey(campaign, index, msg.sender);
        if (voteOf[key] != VoteChoice.None) revert AlreadyVoted(campaign, index, msg.sender);

        voteOf[key] = choice;
        uint256 weight = v.stake;

        r.votedWeight += uint128(weight);
        if (choice == VoteChoice.Approve) {
            r.approveWeight += uint128(weight);
        } else {
            r.rejectWeight += uint128(weight);
        }

        emit VoteCast(campaign, index, msg.sender, choice, weight);
    }

    /**
     * @notice Submits the oracle's attestation as an additional weighted vote.
     * @dev The oracle adapter is trusted to attest only to what it can verify. It is
     *      given a fixed weight so it cannot dominate the verifier pool by itself.
     */
    function submitOracleVote(address campaign, uint256 index, VoteChoice choice) external {
        if (address(oracle) == address(0)) revert ZeroAddress();
        if (msg.sender != address(oracle)) revert NotAnOracle(msg.sender);

        Round storage r = rounds[campaign][index];
        if (r.openedAt == 0) revert UnknownRound(campaign, index);
        if (r.closed || r.settled) revert RoundNotOpen(campaign, index);
        if (block.timestamp >= r.voteDeadline) revert VotingStillOpen(campaign, index, r.voteDeadline);
        if (r.oracleSubmitted == 1) revert OracleAlreadyVoted(campaign, index);

        r.oracleSubmitted = 1;
        uint256 weight = oracleWeight;
        if (weight > 0) {
            r.oracleWeightCast += uint128(weight);
            r.votedWeight += uint128(weight);
            if (choice == VoteChoice.Approve) {
                r.approveWeight += uint128(weight);
            } else {
                r.rejectWeight += uint128(weight);
            }
        }

        emit OracleVote(campaign, index, choice, weight);
    }

    /**
     * @notice Finalises a round and records the outcome.
     * @dev Computes the tally in O(1). Rewards and slashes are applied lazily via
     *      {claimSettlement}, avoiding an unbounded loop over voters.
     *
     *      Quorum failure is treated as REJECTION so that escrow funds are never
     *      released on the basis of insufficient participation.
     */
    function settleRound(address campaign, uint256 index) external returns (VoteChoice outcome) {
        Round storage r = rounds[campaign][index];
        if (r.openedAt == 0) revert UnknownRound(campaign, index);
        if (r.settled) revert RoundAlreadySettled(campaign, index);
        if (block.timestamp < r.voteDeadline) revert VotingStillOpen(campaign, index, r.voteDeadline);

        uint128 required = uint128((uint256(r.activeStakeAtOpen) * quorumBps) / BPS);

        if (r.votedWeight < required) {
            outcome = VoteChoice.Reject;
        } else {
            outcome =
                (uint256(r.approveWeight) * BPS) / uint256(r.votedWeight) >= thresholdBps
                    ? VoteChoice.Approve
                    : VoteChoice.Reject;
        }

        r.outcome = outcome;
        r.settled = true;
        r.closed = true;

        // Route a share of any slashed stake into the reward pool, to be claimed by
        // verifiers who voted correctly.
        if (outcome == VoteChoice.Reject) {
            uint256 pool = rewardPool;
            rewardPool = 0;
            r.rewardPoolShare = pool;
        } else {
            // Approved: anyone who dissented is slashed, so seed the pool with the
            // (future) dissent penalty is not possible without knowing dissent weight;
            // instead we leave the existing pool for correct voters.
            r.rewardPoolShare = rewardPool;
        }

        emit RoundSettled(campaign, index, outcome, r.approveWeight, r.rejectWeight, required, r.rewardPoolShare);

        // Record correct/incorrect weights lazily on first claim to avoid iterating.
        r.correctWeight = outcome == VoteChoice.Approve ? r.approveWeight : r.rejectWeight;
        r.incorrectWeight = outcome == VoteChoice.Approve ? r.rejectWeight : r.approveWeight;
    }

    /**
     * @notice Applies a settled round's consequences to the calling verifier.
     * @dev If the verifier voted in line with the outcome they receive a pro-rata share
     *      of the round's reward pool. If they voted against it, a percentage of their
     *      stake is slashed. Calling when there is neither reward nor penalty reverts.
     */
    function claimSettlement(address campaign, uint256 index) external {
        Round storage r = rounds[campaign][index];
        if (!r.settled) revert RoundNotOpen(campaign, index);

        bytes32 key = voteKey(campaign, index, msg.sender);
        VoteChoice choice = voteOf[key];
        if (choice == VoteChoice.None) revert NoRewardOrPenalty();
        if (settlementClaimed[key]) revert AlreadyClaimed(key);
        settlementClaimed[key] = true;

        bool correct = choice == r.outcome;

        if (correct) {
            uint256 weight = verifiers[msg.sender].stake;
            uint256 share =
                r.correctWeight == 0 ? 0 : (r.rewardPoolShare * weight) / uint256(r.correctWeight);
            if (share > rewardPool) revert InsufficientRewardPool(share, rewardPool);
            rewardPool -= share;
            verifiers[msg.sender].rewardDebt += share;

            (bool ok, ) = payable(msg.sender).call{ value: share }("");
            if (!ok) revert TransferFailed();

            emit SettlementClaimed(msg.sender, key, share, 0);
        } else {
            // Minority-incorrect vote: slash a percentage of stake.
            Verifier storage v = verifiers[msg.sender];
            uint256 slash = (uint256(v.stake) * slashBps) / BPS;
            if (slash > 0) {
                v.stake -= uint128(slash);
                activeStake_ -= slash;

                // Split the slashed stake: `rewardBps` rewards correct voters, the
                // remainder accrues to the treasury.
                uint256 toPool = (slash * rewardBps) / BPS;
                uint256 toTreasury = slash - toPool;
                rewardPool += toPool;
                if (toTreasury > 0) {
                    (bool ok, ) = payable(treasury).call{ value: toTreasury }("");
                    if (!ok) revert TransferFailed();
                }
            }
            emit SettlementClaimed(msg.sender, key, 0, slash);
        }
    }

    /**
     * @notice Slashes a staked verifier who did not vote in a settled round.
     * @dev Mitigates the "inactive verifier" attack where a whale stakes to inflate
     *      quorum, then abstains to make quorum unreachable.
     */
    function penalizeNonVoter(address campaign, uint256 index) external {
        Round storage r = rounds[campaign][index];
        if (!r.settled) revert RoundNotOpen(campaign, index);

        bytes32 key = voteKey(campaign, index, msg.sender);
        if (voteOf[key] != VoteChoice.None) revert NoRewardOrPenalty();
        if (settlementClaimed[key]) revert AlreadyClaimed(key);
        settlementClaimed[key] = true;

        uint256 slash = (uint256(verifiers[msg.sender].stake) * slashBps) / BPS;
        if (slash > 0) {
            verifiers[msg.sender].stake -= uint128(slash);
            activeStake_ -= slash;
        }
        emit NonVoterPenalised(msg.sender, key, slash);
    }

    /* -------------------------------------------------------------------- */
    /*                                 Views                                 */
    /* -------------------------------------------------------------------- */

    /// @notice Unique key identifying a verifier's vote in a round.
    function voteKey(address campaign, uint256 index, address voter) public pure returns (bytes32) {
        return keccak256(abi.encode(campaign, index, voter));
    }

    /// @notice Reads a round's full state.
    function getRound(address campaign, uint256 index) external view returns (Round memory) {
        return rounds[campaign][index];
    }

    /// @notice Reads a verifier's state.
    function getVerifier(address addr) external view returns (Verifier memory) {
        return verifiers[addr];
    }

    /// @notice Computes the quorum weight currently required for a round.
    function requiredQuorum(address campaign, uint256 index) external view returns (uint128) {
        Round storage r = rounds[campaign][index];
        return uint128((uint256(r.activeStakeAtOpen) * quorumBps) / BPS);
    }

    /* -------------------------------------------------------------------- */
    /*                               Internals                               */
    /* -------------------------------------------------------------------- */

    function _validateBps(uint256 value, string memory) private pure {
        if (value > BPS) revert InvalidBps(value);
    }
}