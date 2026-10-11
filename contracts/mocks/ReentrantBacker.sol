// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ReentrantBacker
 * @notice Test contract that attempts to re-enter {Campaign} payout functions.
 * @dev Used by the security test suite to assert that ReentrancyGuard blocks
 *      reentrant claims, and that checks-effects-interactions ordering prevents
 *      balance double-spending even if the guard were removed.
 */
contract ReentrantBacker {
    enum Attack {
        None,
        ClaimRefund,
        ClaimCreatorBalance
    }

    IReentrancyTarget public immutable target;

    Attack public attack;
    uint256 public reentrancyAttempts;
    bool public reentrySucceeded;

    constructor(IReentrancyTarget target_) {
        target = target_;
    }

    receive() external payable {}

    /// @notice Contributes to a campaign and arms a chosen reentrancy strategy.
    function armAttack(IReentrancyTarget campaign, Attack mode) external payable {
        attack = mode;
        reentrancyAttempts = 0;
        reentrySucceeded = false;
        campaign.contribute{ value: msg.value }();
    }

    /// @notice Plain contribution with no attack payload, for control comparisons.
    function contribute(IReentrancyTarget campaign) external payable {
        campaign.contribute{ value: msg.value }();
    }

    function trigger() external {
        if (attack == Attack.ClaimRefund) {
            target.claimRefund();
        } else if (attack == Attack.ClaimCreatorBalance) {
            target.claimCreatorBalance();
        }
    }

    /// @notice Called by the campaign when it attempts to pay this contract.
    /// @dev Re-enters the guarded function once to prove the guard trips.
    fallback() external payable {
        if (attack != Attack.None && reentrancyAttempts < 3) {
            reentrancyAttempts += 1;
            if (attack == Attack.ClaimRefund) {
                try target.claimRefund() {
                    reentrySucceeded = true;
                } catch {
                    // Expected: ReentrancyGuard reverts.
                }
            } else if (attack == Attack.ClaimCreatorBalance) {
                try target.claimCreatorBalance() {
                    reentrySucceeded = true;
                } catch {
                    // Expected: ReentrancyGuard reverts.
                }
            }
        }
    }
}

/// @notice Minimal surface {ReentrantBacker} needs from a campaign.
interface IReentrancyTarget {
    function contribute() external payable;
    function claimRefund() external;
    function claimCreatorBalance() external;
}
