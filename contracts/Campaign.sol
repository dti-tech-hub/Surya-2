// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { MilestoneVerifier, VoteChoice } from "./MilestoneVerifier.sol";
import { ReputationRegistry } from "./ReputationRegistry.sol";

/**
 * @title Campaign
 * @notice Milestone-based escrow for a single crowdfunding campaign.
 *
 * @dev Lifecycle
 *
 *   Funding ──(deadline, goal met)──> Active ──(all milestones verified)──> Completed
 *      │                                │                                      │
 *      │(deadline, goal NOT met)        │(milestone rejected & campaign fails) │
 *      └──> Failed ──> Refunded        └──> Failed ──> Refunded
 *
 * Funds only ever move when a milestone's verification resolves to Approve. Nothing
 * else releases the escrow.
 *
 * Accounting model
 * ----------------
 * - `totalContributed`  : wei received from backers during Funding.
 * - `totalReleased`      : wei already transferred to the creator.
 * - `releasedBps`        : cumulative basis points of the goal released so far.
 * - The escrow balance is `totalContributed - totalReleased - totalRefunded`; the
 *   remaining balance is what backers are entitled to if the campaign fails.
 *
 * Refundable pot is computed as `totalContributed - totalReleased`, and each backer's
 * share is `contribution * pot / totalContributed`. Because the sum of all
 * contributions equals `totalContributed`, no backer's share can exceed the pot, so a
 * claim can never overdraw the escrow. Integer division may leave dust behind; it is
 * recoverable via {sweepDust} once every backer has claimed.
 *
 * Pull over push
 * --------------
 * Neither the creator nor the backers are paid automatically. Funds accumulate as
 * balances and are withdrawn with explicit claims ({claimCreatorBalance},
 * {claimRefund}). This keeps a malicious or reverting recipient from blocking progress
 * for everyone else, and keeps gas cost independent of the number of participants.
 *
 * PII
 * ---
 * No personal data is stored on-chain. Evidence is referenced by IPFS CID plus a
 * keccak256 digest of the file contents; the digest is what verifiers check, so a
 * creator cannot swap the document after submission.
 */
contract Campaign is ReentrancyGuard {
    /* -------------------------------------------------------------------- */
    /*                                  Types                                */
    /* -------------------------------------------------------------------- */

    enum State {
        Funding,
        Active,
        Failed,
        Completed,
        Cancelled
    }

    enum MilestoneState {
        Pending,
        Submitted,
        Verified,
        Rejected
    }

    struct Milestone {
        bytes32 descriptionHash;
        string specificationCID;
        uint16 trancheBps;
        uint64 deadline;
        MilestoneState state;
        bytes32 evidenceHash;
        string evidenceCID;
        uint64 submittedAt;
        uint64 resolvedAt;
    }

    /* -------------------------------------------------------------------- */
    /*                                 Constants                              */
    /* -------------------------------------------------------------------- */

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_MILESTONES = 32;

    /* -------------------------------------------------------------------- */
    /*                                Immutables                              */
    /* -------------------------------------------------------------------- */

    address public immutable creator;
    address public immutable factory;
    /// @notice Destination for protocol fees and rounding dust. Immutable by design:
    ///         a caller-supplied sweep destination is a fund-drain vector.
    address public immutable treasury;
    MilestoneVerifier public immutable verifier;
    ReputationRegistry public immutable reputation;
    uint64 public immutable createdAt;

    /// @notice Dispute module authorised to override a milestone outcome. Set once by
    ///         the factory so a creator cannot point disputes at a contract they control.
    address public disputeModule;

    /* -------------------------------------------------------------------- */
    /*                                 Storage                               */
    /* -------------------------------------------------------------------- */

    uint256 public goal;
    uint64 public fundingDeadline;

    State public state;
    uint256 public totalContributed;
    uint256 public totalReleased;
    uint256 public totalRefunded;
    uint256 public releasedBps;
    uint256 public creatorBalance;
    uint64 public stateChangedAt;

    /// @notice Set once the terminal campaign outcome has been written to the
    ///         reputation registry. Prevents double counting.
    bool public outcomeRecorded;

    Milestone[] private milestones;

    /// @notice backer => wei contributed.
    mapping(address => uint256) public contributionOf;

    /// @notice backer => whether they have already withdrawn their refund.
    mapping(address => bool) public refundClaimed;

    /// @notice backer => whether they have already withdrawn creator-tranche proceeds.
    mapping(address => bool) public creatorClaimed;

    /// @notice Enumerable list of backers, used only by {sweepDust} accounting checks.
    address[] private backers;
    mapping(address => bool) private isBacker;

    /* -------------------------------------------------------------------- */
    /*                                  Events                               */
    /* -------------------------------------------------------------------- */

    event CampaignCreated(
        address indexed campaign,
        address indexed creatorAddress,
        address indexed verifierAddress,
        uint256 goalAmount,
        uint64 fundingDeadline,
        uint256 milestoneCount
    );
    event Contributed(address indexed backer, uint256 amount, uint256 totalContributed);
    event FundingClosed(bool goalMet, uint256 totalRaised);
    event EvidenceSubmitted(
        uint256 indexed index,
        string evidenceCID,
        bytes32 evidenceHash,
        uint64 voteDeadline
    );
    event MilestoneVerified(
        uint256 indexed index,
        uint256 trancheAmount,
        uint256 releasedBpsTotal,
        bool campaignComplete
    );
    event MilestoneRejected(uint256 indexed index, uint128 rejectWeight, uint128 approveWeight);
    event CampaignFailed(uint256 refundableAmount);
    event CreatorBalanceClaimed(address indexed creatorAddress, uint256 amount);
    event RefundClaimed(address indexed backer, uint256 amount);
    event DustSwept(address indexed to, uint256 amount);
    event StateChanged(State previous, State current);
    event DisputeModuleSet(address indexed module);
    event CampaignDisputeResolved(uint256 indexed index, uint8 outcome, uint16 partialBps);
    event MilestonePartiallyReleased(uint256 indexed index, uint256 trancheAmount, uint16 creatorShareBps);

    /* -------------------------------------------------------------------- */
    /*                                  Errors                              */
    /* -------------------------------------------------------------------- */

    error ZeroAddress();
    error ZeroGoal();
    error InvalidDeadline(uint256 fundingDeadline, uint256 nowTs);
    error InvalidTrancheSum(uint256 provided, uint256 expected);
    error MilestoneCountOutOfRange(uint256 count);
    error MilestoneArrayLengthMismatch();
    error DeadlineInPast();
    error MilestoneDeadlineTooEarly(uint64 milestoneDeadline, uint64 fundingDeadline);
    error NotCreator(address caller);
    error WrongState(State expected, State actual);
    error NotFunding();
    error FundingPeriodOver();
    error FundingNotClosed();
    error ZeroContribution();
    error MilestoneAlreadyResolved(uint256 index);
    error MilestoneNotSubmitted(uint256 index);
    error MilestoneNotDue(uint256 index, uint64 deadline);
    error MilestoneDeadlinePassed(uint256 index);
    error NothingToClaim();
    error NothingToSweep();
    error ZeroMilestoneIndex();
    error TransferFailed();
    error NotFactory(address caller);
    error DisputeModuleAlreadySet(address module);
    error NotDisputeModule(address caller);
    error MilestoneNotDisputable(uint256 index);
    error InvalidDisputeOutcome(uint8 outcome);
    error InvalidBps(uint256 value);

    /* -------------------------------------------------------------------- */
    /*                                Modifiers                              */
    /* -------------------------------------------------------------------- */

    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator(msg.sender);
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        _;
    }

    modifier onlyDisputeModule() {
        if (msg.sender != disputeModule || disputeModule == address(0)) {
            revert NotDisputeModule(msg.sender);
        }
        _;
    }

    /* -------------------------------------------------------------------- */
    /*                               Constructor                             */
    /* -------------------------------------------------------------------- */

    /**
     * @param creator_ Address that launches the campaign and receives released tranches.
     * @param verifier_ Milestone verification registry.
     * @param reputation_ On-chain reputation registry written on milestone/campaign outcomes.
     * @param goal_ Funding goal in wei. Must be non-zero.
     * @param fundingDeadline_ Unix timestamp after which no further funds are accepted.
     * @param trancheBps_ Release schedule; must sum to exactly 10 000.
     * @param descriptionHashes_ keccak256 digest of each milestone's acceptance criteria.
     * @param specificationCIDs_ IPFS CID of each milestone's specification document.
     * @param milestoneDeadlines_ Per-milestone submission deadlines.
     * @param treasury_ Destination for protocol fees and rounding dust.
     */
    constructor(
        address creator_,
        address verifier_,
        address reputation_,
        address treasury_,
        uint256 goal_,
        uint64 fundingDeadline_,
        uint16[] memory trancheBps_,
        bytes32[] memory descriptionHashes_,
        string[] memory specificationCIDs_,
        uint64[] memory milestoneDeadlines_
    ) {
        if (
            creator_ == address(0) ||
            verifier_ == address(0) ||
            reputation_ == address(0) ||
            treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (goal_ == 0) revert ZeroGoal();
        if (fundingDeadline_ <= block.timestamp) revert InvalidDeadline(fundingDeadline_, block.timestamp);

        uint256 n = trancheBps_.length;
        if (n == 0 || n > MAX_MILESTONES) revert MilestoneCountOutOfRange(n);
        if (
            descriptionHashes_.length != n ||
            specificationCIDs_.length != n ||
            milestoneDeadlines_.length != n
        ) {
            revert MilestoneArrayLengthMismatch();
        }

        uint256 trancheSum;
        for (uint256 i = 0; i < n; ++i) {
            if (milestoneDeadlines_[i] <= fundingDeadline_) {
                revert MilestoneDeadlineTooEarly(milestoneDeadlines_[i], fundingDeadline_);
            }
            trancheSum += trancheBps_[i];
        }
        if (trancheSum != BPS) revert InvalidTrancheSum(trancheSum, BPS);

        creator = creator_;
        factory = msg.sender;
        treasury = treasury_;
        verifier = MilestoneVerifier(verifier_);
        reputation = ReputationRegistry(reputation_);
        createdAt = uint64(block.timestamp);
        goal = goal_;
        fundingDeadline = fundingDeadline_;
        state = State.Funding;
        stateChangedAt = uint64(block.timestamp);

        for (uint256 i = 0; i < n; ++i) {
            milestones.push(
                Milestone({
                    descriptionHash: descriptionHashes_[i],
                    specificationCID: specificationCIDs_[i],
                    trancheBps: trancheBps_[i],
                    deadline: milestoneDeadlines_[i],
                    state: MilestoneState.Pending,
                    evidenceHash: bytes32(0),
                    evidenceCID: "",
                    submittedAt: 0,
                    resolvedAt: 0
                })
            );
        }

        emit CampaignCreated(
            address(this),
            creator_,
            verifier_,
            goal_,
            fundingDeadline_,
            n
        );
    }

    /* -------------------------------------------------------------------- */
    /*                          Protocol wiring                              */
    /* -------------------------------------------------------------------- */

    /**
     * @notice Binds this campaign to the dispute module that may override milestone
     *         outcomes and trigger refunds.
     * @dev Factory-only and one-shot. Without this restriction a creator could deploy a
     *      fake "dispute module" and release escrow at will.
     */
    function setDisputeModule(address module) external onlyFactory {
        if (module == address(0)) revert ZeroAddress();
        if (disputeModule != address(0)) revert DisputeModuleAlreadySet(disputeModule);
        disputeModule = module;
        emit DisputeModuleSet(module);
    }

    /* -------------------------------------------------------------------- */
    /*                              Funding phase                            */
    /* -------------------------------------------------------------------- */

    /**
     * @notice Contributes funds to the campaign escrow.
     * @dev Only accepted while the campaign is {State.Funding} and before the funding
     *      deadline. Contributions are pooled into a single escrow balance; they are not
     *      tracked as individual sub-accounts, which is what makes pro-rata refunds
     *      computable in O(1).
     */
    function contribute() external payable nonReentrant {
        if (state != State.Funding) revert WrongState(State.Funding, state);
        if (block.timestamp > fundingDeadline) revert FundingPeriodOver();
        if (msg.value == 0) revert ZeroContribution();

        if (contributionOf[msg.sender] == 0) {
            backers.push(msg.sender);
            isBacker[msg.sender] = true;
        }
        contributionOf[msg.sender] += msg.value;
        totalContributed += msg.value;

        emit Contributed(msg.sender, msg.value, totalContributed);
    }

    /**
     * @notice Closes the funding window.
     * @dev Permissionless once the deadline has passed. If the goal was met the campaign
     *      becomes {State.Active}; otherwise it becomes {State.Failed} and the
     *      contribution pool becomes refundable.
     */
    function closeFunding() external nonReentrant {
        if (state != State.Funding) revert FundingNotClosed();
        if (block.timestamp <= fundingDeadline) revert FundingPeriodOver();

        bool goalReached = totalContributed >= goal;
        _setState(goalReached ? State.Active : State.Failed);

        emit FundingClosed(goalReached, totalContributed);

        if (!goalReached) {
            emit CampaignFailed(totalContributed - totalReleased);
        }
    }

    /* -------------------------------------------------------------------- */
    /*                            Milestone execution                        */
    /* -------------------------------------------------------------------- */

    /**
     * @notice Submits evidence for a milestone and opens its verification round.
     * @dev The creator commits to the evidence off-chain (IPFS) and on-chain by digest.
     *      Because the digest is immutable once submitted, verifiers can fetch the CID
     *      and confirm it hashes to `evidenceHash`, which prevents a later swap.
     * @param index Milestone index.
     * @param evidenceCID IPFS CID (or any content-addressed URI) of the evidence.
     * @param evidenceHash keccak256 digest of the evidence document.
     */
    function submitEvidence(
        uint256 index,
        string calldata evidenceCID,
        bytes32 evidenceHash
    ) external onlyCreator nonReentrant {
        if (index >= milestones.length) revert ZeroMilestoneIndex();
        if (state != State.Active) revert WrongState(State.Active, state);

        Milestone storage m = milestones[index];
        if (m.state != MilestoneState.Pending) revert MilestoneAlreadyResolved(index);
        if (block.timestamp > m.deadline) revert MilestoneDeadlinePassed(index);
        if (evidenceHash == bytes32(0)) revert ZeroContribution();

        m.state = MilestoneState.Submitted;
        m.evidenceCID = evidenceCID;
        m.evidenceHash = evidenceHash;
        m.submittedAt = uint64(block.timestamp);

        uint64 voteDeadline = uint64(block.timestamp) + verifier.votingWindow();
        verifier.openRound(address(this), index, voteDeadline);

        emit EvidenceSubmitted(index, evidenceCID, evidenceHash, voteDeadline);
    }

    /**
     * @notice Resolves a submitted milestone once its voting window has closed.
     * @dev Permissionless, so a stalled campaign cannot be held hostage by its creator.
     *      Delegates the tally to {MilestoneVerifier} and applies the escrow effect.
     *      A Rejected milestone leaves the tranche locked; the creator may either
     *      abandon the campaign (unlocking refunds) or appeal through the dispute
     *      module. A dispute verdict can override the verifier panel.
     */
    function resolveMilestone(uint256 index) external nonReentrant {
        if (index >= milestones.length) revert ZeroMilestoneIndex();
        Milestone storage m = milestones[index];
        if (m.state != MilestoneState.Submitted) revert MilestoneNotSubmitted(index);

        VoteChoice outcome = verifier.settleRound(address(this), index);

        if (outcome == VoteChoice.Approve) {
            _releaseTranche(index);
        } else {
            m.state = MilestoneState.Rejected;
            m.resolvedAt = uint64(block.timestamp);
            emit MilestoneRejected(index, 0, 0);
        }
    }

    /**
     * @notice Abandons the campaign and unlocks refunds for all backers.
     * @dev Only the creator may abandon early on the strength of a rejected milestone.
     *      Anyone may abandon once every milestone deadline has elapsed, so an inactive
     *      creator cannot strand escrow forever. Only the *unreleased* balance becomes
     *      refundable, so funds already earned by the creator are unaffected.
     */
    function failCampaign() external nonReentrant {
        if (state != State.Active) revert WrongState(State.Active, state);

        if (msg.sender == creator) {
            if (!_hasRejectedMilestone() && !_allMilestonesExpired()) {
                revert WrongState(State.Active, state);
            }
        } else if (!_allMilestonesExpired()) {
            revert NotCreator(msg.sender);
        }

        _setState(State.Failed);
        emit CampaignFailed(totalContributed - totalReleased);
    }

    /**
     * @notice Applies a dispute verdict to a milestone and the escrow.
     * @dev Only the dispute module registered by the factory may call this. This is the
     *      missing link in the original design: an appeal that cannot move escrow is not
     *      an appeal. Encoding: 1 = Refund, 2 = Release, 3 = Partial.
     * @param index Milestone under dispute.
     * @param outcome Dispute outcome (see {DisputeResolution.Outcome}).
     * @param partialBps Creator share of the disputed tranche when `outcome == 3`.
     */
    function resolveDispute(uint256 index, uint8 outcome, uint16 partialBps)
        external
        nonReentrant
        onlyDisputeModule
    {
        if (state != State.Active) revert WrongState(State.Active, state);
        if (index >= milestones.length) revert ZeroMilestoneIndex();

        Milestone storage m = milestones[index];
        if (m.state != MilestoneState.Submitted && m.state != MilestoneState.Rejected) {
            revert MilestoneNotDisputable(index);
        }

        if (outcome == 1) {
            // Refund: leave the tranche locked and fail the campaign so every backer can
            // claim their pro-rata share of the unreleased pot.
            m.state = MilestoneState.Rejected;
            m.resolvedAt = uint64(block.timestamp);
            emit MilestoneRejected(index, 0, 0);
            _setState(State.Failed);
        } else if (outcome == 2) {
            // Release: the appeal found the milestone valid after all.
            _releaseTranche(index);
        } else if (outcome == 3) {
            if (partialBps > BPS) revert InvalidBps(partialBps);
            _releasePartial(index, partialBps);
            m.state = MilestoneState.Rejected;
            m.resolvedAt = uint64(block.timestamp);
            _setState(State.Failed);
        } else {
            revert InvalidDisputeOutcome(outcome);
        }

        emit CampaignDisputeResolved(index, outcome, partialBps);
    }

    /* -------------------------------------------------------------------- */
    /*                                  Claims                               */
    /* -------------------------------------------------------------------- */

    /**
     * @notice Withdraws tranches already released to the creator.
     * @dev Pull-based: the escrow accrues `creatorBalance` as milestones verify, and the
     *      creator withdraws it whenever convenient.
     */
    function claimCreatorBalance() external nonReentrant onlyCreator {
        uint256 amount = creatorBalance;
        if (amount == 0) revert NothingToClaim();

        // Checks-Effects-Interactions.
        creatorBalance = 0;
        creatorClaimed[msg.sender] = true;

        (bool ok, ) = payable(creator).call{ value: amount }("");
        if (!ok) revert TransferFailed();

        emit CreatorBalanceClaimed(creator, amount);
    }

    /**
     * @notice Withdraws the calling backer's pro-rata share of the refundable balance.
     * @dev Only meaningful once the campaign is {State.Failed} or {State.Cancelled}.
     *      Computed as `contribution * refundable / totalContributed`, which is safe
     *      because the contributions of all backers sum exactly to `totalContributed`.
     */
    function claimRefund() external nonReentrant {
        if (state != State.Failed && state != State.Cancelled) {
            revert WrongState(State.Failed, state);
        }
        if (refundClaimed[msg.sender]) revert NothingToClaim();

        uint256 contributed = contributionOf[msg.sender];
        if (contributed == 0) revert NothingToClaim();

        uint256 refundable = totalContributed - totalReleased;
        uint256 amount = (contributed * refundable) / totalContributed;
        if (amount == 0) revert NothingToClaim();

        // Checks-Effects-Interactions.
        refundClaimed[msg.sender] = true;
        totalRefunded += amount;
        contributionOf[msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{ value: amount }("");
        if (!ok) revert TransferFailed();

        emit RefundClaimed(msg.sender, amount);
    }

    /**
     * @notice Recovers rounding dust left after every backer has been refunded.
     * @dev Requires that every known backer has claimed. Destination is the immutable
     *      {treasury} set at construction, NOT a caller-supplied address: an earlier
     *      revision took the destination as a parameter, which meant any address could
     *      sweep the dust to itself. Slither flagged this as `arbitrary-send-eth` and
     *      the parameter has been removed.
     */
    function sweepDust() external nonReentrant {
        if (state != State.Failed && state != State.Cancelled) revert WrongState(State.Failed, state);

        uint256 n = backers.length;
        for (uint256 i = 0; i < n; ++i) {
            if (!refundClaimed[backers[i]]) revert NothingToSweep();
        }

        uint256 dust = address(this).balance - (totalContributed - totalReleased - totalRefunded);
        if (dust == 0) revert NothingToSweep();

        // Checks-Effects-Interactions.
        totalRefunded += dust;

        (bool ok, ) = payable(treasury).call{ value: dust }("");
        if (!ok) revert TransferFailed();

        emit DustSwept(treasury, dust);
    }

    /* -------------------------------------------------------------------- */
    /*                               Views                                   */
    /* -------------------------------------------------------------------- */

    /// @notice Number of milestones in the campaign.
    function milestoneCount() external view returns (uint256) {
        return milestones.length;
    }

    /// @notice Reads a milestone's full state.
    function getMilestone(uint256 index) external view returns (Milestone memory) {
        if (index >= milestones.length) revert ZeroMilestoneIndex();
        return milestones[index];
    }

    /// @notice Reads a batch of milestones, bounded by {maxMilestones}.
    function getMilestones(uint256 offset, uint256 maxMilestones)
        external
        view
        returns (Milestone[] memory page)
    {
        uint256 total = milestones.length;
        if (offset >= total) return new Milestone[](0);
        uint256 end = offset + maxMilestones;
        if (end > total || end < offset) end = total;

        page = new Milestone[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = milestones[i];
        }
    }

    /// @notice Wei currently held in escrow.
    function escrowBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Wei still owed to backers if the campaign fails.
    function refundableBalance() public view returns (uint256) {
        return totalContributed - totalReleased;
    }

    /// @notice Pro-rata refund the given backer would receive right now.
    function refundQuote(address backer) external view returns (uint256) {
        if (refundClaimed[backer]) return 0;
        uint256 contributed = contributionOf[backer];
        if (contributed == 0 || totalContributed == 0) return 0;
        return (contributed * refundableBalance()) / totalContributed;
    }

    /// @notice Whether the funding goal has been met.
    function goalMet() external view returns (bool) {
        return totalContributed >= goal;
    }

    /* -------------------------------------------------------------------- */
    /*                              Internals                                */
    /* -------------------------------------------------------------------- */

    function _releaseTranche(uint256 index) private {
        Milestone storage m = milestones[index];
        m.state = MilestoneState.Verified;
        m.resolvedAt = uint64(block.timestamp);

        // Revert if the tranche schedule would overshoot, rather than silently
        // over-releasing. Unreachable given the constructor's sum check.
        uint256 newBps = releasedBps + m.trancheBps;
        if (newBps > BPS) revert InvalidTrancheSum(newBps, BPS);

        releasedBps = newBps;

        // Tranche is a share of the *actual amount raised*, not of the goal. This is
        // what makes overfunded campaigns safe: on the final milestone newBps == BPS,
        // so `cumulative` equals `totalContributed` and the entire surplus is released
        // to the creator instead of being stranded forever in a Completed campaign.
        // Using the cumulative amount also avoids per-step rounding dust.
        uint256 cumulative = (totalContributed * newBps) / BPS;
        uint256 trancheAmount = cumulative > totalReleased ? cumulative - totalReleased : 0;
        if (trancheAmount > refundableBalance()) trancheAmount = refundableBalance();

        totalReleased += trancheAmount;
        creatorBalance += trancheAmount;

        // Delivery reputation: an approval after the milestone deadline is still a
        // delivery, but it is not an on-time one.
        reputation.recordMilestone(creator, block.timestamp <= m.deadline);

        bool complete = releasedBps == BPS && _allMilestonesResolved();
        if (complete) {
            _setState(State.Completed);
        }

        emit MilestoneVerified(index, trancheAmount, releasedBps, complete);
    }

    /**
     * @dev Releases the creator's share of one tranche when a dispute resolves as
     *      Partial. The remainder stays in escrow and becomes refundable because the
     *      caller (`resolveDispute`) immediately fails the campaign afterwards.
     */
    function _releasePartial(uint256 index, uint16 creatorShareBps) private {
        Milestone storage m = milestones[index];

        uint256 newBps = releasedBps + m.trancheBps;
        if (newBps > BPS) revert InvalidTrancheSum(newBps, BPS);
        releasedBps = newBps;

        uint256 tranche = (totalContributed * m.trancheBps) / BPS;
        uint256 amount = (tranche * creatorShareBps) / BPS;
        if (amount > refundableBalance()) amount = refundableBalance();

        totalReleased += amount;
        creatorBalance += amount;

        reputation.recordMilestone(creator, block.timestamp <= m.deadline);

        emit MilestoneVerified(index, amount, releasedBps, false);
        emit MilestonePartiallyReleased(index, amount, creatorShareBps);
    }

    function _setState(State next) private {
        State previous = state;
        state = next;
        stateChangedAt = uint64(block.timestamp);

        if (next == State.Completed) {
            _recordOutcome(true);
        } else if (next == State.Failed) {
            _recordOutcome(false);
        }

        emit StateChanged(previous, next);
    }

    /// @dev Writes the terminal campaign outcome exactly once.
    function _recordOutcome(bool completed) private {
        if (outcomeRecorded) return;
        outcomeRecorded = true;
        reputation.recordCampaign(creator, completed);
    }

    function _hasRejectedMilestone() private view returns (bool) {
        for (uint256 i = 0; i < milestones.length; ++i) {
            if (milestones[i].state == MilestoneState.Rejected) return true;
        }
        return false;
    }

    function _allMilestonesExpired() private view returns (bool) {
        for (uint256 i = 0; i < milestones.length; ++i) {
            if (block.timestamp <= milestones[i].deadline) return false;
        }
        return true;
    }

    function _allMilestonesResolved() private view returns (bool) {
        for (uint256 i = 0; i < milestones.length; ++i) {
            if (milestones[i].state != MilestoneState.Verified) return false;
        }
        return true;
    }
}