"""
Python mirror of `ReputationRegistry.scoreOf`.

THIS IS A CORRECTNESS-CRITICAL MODULE.

`contracts/ReputationRegistry.sol` is the normative definition of the on-chain reputation
formula. This file re-implements it so the backend can display a score without an RPC call
per lookup.

The two MUST agree exactly. That is not aspirational: if they diverge, the dApp shows a
different reputation than the chain enforces, and every reputation claim in the report
becomes wrong. `test/ReputationRegistry.test.ts` asserts on-chain/off-chain parity at a
fixed block height, and this module is the Python side of that pair.

Two deliberate constraints keep the implementations from drifting:

  1. Integer arithmetic only. Solidity's `uint256` division truncates, so Python's `/`
     is replaced with `//`. Using true division here would silently produce different
     results on every non-exact division.

  2. No transcendental functions. The decay term is `HALF_LIFE / (HALF_LIFE + age)`,
     which needs only integer math. The on-chain contract deliberately avoids `exp` for
     exactly this reason.

If you change the Solidity constants, change them here and the parity test will tell you
if you missed one.
"""

from __future__ import annotations

from dataclasses import dataclass

BPS = 10_000
W_DELIVERY = 4_000
W_COMPLETION = 3_000
W_DISPUTE = 2_000
W_INTEGRITY = 1_000
WEIGHT_SUM = W_DELIVERY + W_COMPLETION + W_DISPUTE + W_INTEGRITY  # 10_000

MAX_SLASH_BPS = 5_000
SLASH_PER_TOKEN = 50
HALF_LIFE = 180 * 24 * 60 * 60  # 15_552_000 seconds

TIER_BRONZE = 2_000
TIER_SILVER = 4_000
TIER_GOLD = 6_500
TIER_PLATINUM = 8_000


@dataclass
class Profile:
    """Mirror of `ReputationRegistry.Profile`."""

    milestones_on_time: int = 0
    milestones_total: int = 0
    campaigns_completed: int = 0
    campaigns_failed: int = 0
    dispute_wins: int = 0
    dispute_losses: int = 0
    votes_correct: int = 0
    votes_total: int = 0
    slashed_wei: int = 0
    last_updated: int = 0

    @classmethod
    def from_chain(cls, data: dict) -> "Profile":
        """Builds a Profile from a raw contract call result."""
        return cls(
            milestones_on_time=int(data["milestonesOnTime"]),
            milestones_total=int(data["milestonesTotal"]),
            campaigns_completed=int(data["campaignsCompleted"]),
            campaigns_failed=int(data["campaignsFailed"]),
            dispute_wins=int(data["disputeWins"]),
            dispute_losses=int(data["disputeLosses"]),
            votes_correct=int(data["votesCorrect"]),
            votes_total=int(data["votesTotal"]),
            slashed_wei=int(data["slashedWei"]),
            last_updated=int(data["lastUpdated"]),
        )


def _ratio(a: int, b: int) -> int:
    """a/b in basis points, or 0 when b == 0 (no observations)."""
    if b == 0:
        return 0
    return (a * BPS) // b


def score(profile: Profile, now: int) -> int:
    """Reputation score in basis points (0..10000). Mirrors `ReputationRegistry.scoreOf`."""
    if profile.last_updated == 0:
        return 0

    delivery = _ratio(profile.milestones_on_time, profile.milestones_total)
    completion = _ratio(profile.campaigns_completed, profile.campaigns_completed + profile.campaigns_failed)
    dispute = _ratio(profile.dispute_wins, profile.dispute_wins + profile.dispute_losses)
    integrity = _ratio(profile.votes_correct, profile.votes_total)

    raw = (
        W_DELIVERY * delivery
        + W_COMPLETION * completion
        + W_DISPUTE * dispute
        + W_INTEGRITY * integrity
    ) // WEIGHT_SUM

    penalty = (profile.slashed_wei // (10**18)) * SLASH_PER_TOKEN
    if penalty > MAX_SLASH_BPS:
        penalty = MAX_SLASH_BPS
    if raw > penalty:
        raw -= penalty

    age = now - profile.last_updated
    return (raw * HALF_LIFE) // (HALF_LIFE + age)


def tier(score_bps: int) -> str:
    if score_bps >= TIER_PLATINUM:
        return "Platinum"
    if score_bps >= TIER_GOLD:
        return "Gold"
    if score_bps >= TIER_SILVER:
        return "Silver"
    if score_bps >= TIER_BRONZE:
        return "Bronze"
    return "Unrated"


def score_percent(profile: Profile, now: int) -> float:
    """Score on a 0-100 scale, for display."""
    return score(profile, now) / 100


def reputation_for(address_data: dict, now: int) -> dict:
    """Convenience wrapper returning score, tier and percent in one object."""
    profile = Profile.from_chain(address_data)
    bps = score(profile, now)
    return {
        "score_bps": bps,
        "score_percent": bps / 100,
        "tier": tier(bps),
        "decay_age_days": (now - profile.last_updated) // 86400 if profile.last_updated else None,
    }


if __name__ == "__main__":  # pragma: no cover
    # Quick self-check against the values pinned in the Solidity tests.
    now = 1_700_000_000
    perfect = Profile(
        milestones_on_time=10, milestones_total=10,
        campaigns_completed=1, campaigns_failed=0,
        dispute_wins=1, dispute_losses=0,
        votes_correct=10, votes_total=10,
        slashed_wei=0, last_updated=now,
    )
    print("perfect record ->", score(perfect, now), tier(score(perfect, now)))
    assert abs(score(perfect, now) - 10_000) <= 1, "expected ~10000 bps"

    half = Profile(milestones_on_time=1, milestones_total=1, last_updated=now - HALF_LIFE)
    print("one milestone, one half-life ->", score(half, now))