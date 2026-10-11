"""
Synthetic campaign dataset generator for fraud detection.

WHY THIS IS SYNTHETIC
---------------------
There is no public dataset of blockchain crowdfunding campaigns with fraud labels.
Rather than pretend otherwise, this module *generates* a labelled corpus whose
generative process is documented and whose parameters are controlled. Every result
produced by the models in `train.py` is therefore a statement about how well the models
recover a known, injected signal — NOT a claim about real-world fraud detection, which
would require real labelled data this project does not have.

This distinction is load-bearing for the honesty of the evaluation. The synthetic set is
useful for:
  - verifying the feature pipeline is wired correctly,
  - measuring whether an unsupervised detector can recover injected anomalies at all,
  - producing a reproducible demo for the dApp's risk badges.

It is NOT sufficient for claiming a model would work in production.

Determinism
-----------
All randomness flows from a single seeded `numpy.random.Generator`, so the dataset is
byte-identical across runs for a given seed and version. That matters because every
metric in the report must be reproducible.

Generative model
----------------
Four campaign archetypes are injected:

  honest          delivers milestones on time, diverse backers, gradual funding.
  fake            pads the description with marketing language, funding arrives in a
                  burst from a few addresses, then the creator goes silent.
  sybil_ring      funding is split across many addresses that are correlated
                  (created together, similar sizes, similar timing) to simulate one
                  actor wearing many hats.
  abandoned       real interest early, then funding flatlines before any milestone.

Correlation between features is what the models must learn, so the generator does not
emit features independently: funding velocity, contributor clustering, description
similarity and evidence timing are coupled to the archetype.
"""

from __future__ import annotations

import dataclasses
from typing import Dict, List

import numpy as np
import pandas as pd

# Fixed default seed. Changing this changes every downstream metric.
DEFAULT_SEED = 42

ARCHETYPES = ("honest", "fake", "sybil_ring", "abandoned")

# Marketing filler used to inflate fake campaigns' description similarity to each other.
_MARKETING_TOKENS = (
    "revolutionary groundbreaking worldclass innovative unique never-before-seen "
    "unmatched cutting-edge transformative best-in-class ultimate premium exclusive"
).split()

_HONEST_TOKENS = (
    "prototype prototype-tested fabrication assembly open-source datasheet fabrication "
    "tolerance assembly-line open-hardware measurement calibration batch-provenance"
).split()


@dataclasses.dataclass
class GeneratorConfig:
    """Controls the corpus size and archetype mix."""

    n_campaigns: int = 4000
    seed: int = DEFAULT_SEED
    # Relative frequency of each archetype. Deliberately imbalanced to mimic reality,
    # where fraudulent campaigns are the minority. A 50/50 split would make the task
    # unrealistically easy and inflate precision/recall.
    mix: Dict[str, float] = dataclasses.field(
        default_factory=lambda: {
            "honest": 0.55,
            "fake": 0.25,
            "sybil_ring": 0.12,
            "abandoned": 0.08,
        }
    )

    def validate(self) -> None:
        if abs(sum(self.mix.values()) - 1.0) > 1e-6:
            raise ValueError(f"archetype mix must sum to 1.0, got {sum(self.mix.values())}")
        for name in self.mix:
            if name not in ARCHETYPES:
                raise ValueError(f"unknown archetype {name!r}")


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _description_tokens(rng: np.random.Generator, archetype: str) -> str:
    """Build a campaign description whose vocabulary correlates with the archetype.

    Fake campaigns reuse the same marketing vocabulary, which is what makes TF-IDF
    cosine similarity between their descriptions a useful signal.
    """
    if archetype == "fake":
        n = int(rng.integers(18, 40))
        tokens = list(rng.choice(_MARKETING_TOKENS, size=n, replace=True))
    elif archetype == "sybil_ring":
        n = int(rng.integers(10, 22))
        tokens = list(rng.choice(_MARKETING_TOKENS + _HONEST_TOKENS, size=n, replace=True))
    else:  # honest, abandoned
        n = int(rng.integers(12, 30))
        tokens = list(rng.choice(_HONEST_TOKENS, size=n, replace=True))
    return " ".join(tokens)


def _contributor_clustering(rng: np.random.Generator, archetype: str) -> float:
    """Fraction of backers that are behaviourally correlated (Sybil signature).

    Honest campaigns have many independent backers, so clustering is low. A Sybil ring
    has a high correlated fraction because one actor controls many addresses.

    The bands deliberately OVERLAP. An earlier revision used disjoint ranges (honest
    0.02-0.18, sybil 0.55-0.92), which made this feature alone a perfect classifier and
    the whole evaluation meaningless. Real campaigns sit on a continuum.
    """
    base = {
        "honest": rng.uniform(0.02, 0.55),
        "fake": rng.uniform(0.10, 0.60),
        "sybil_ring": rng.uniform(0.35, 0.92),
        "abandoned": rng.uniform(0.02, 0.40),
    }[archetype]
    return float(base)


def generate(config: GeneratorConfig | None = None) -> pd.DataFrame:
    """Generate a labelled synthetic campaign corpus.

    Returns a DataFrame with feature columns, `archetype` (the ground-truth class), and
    `is_fraudulent` (binary label: everything that is not `honest`).
    """
    config = config or GeneratorConfig()
    config.validate()
    rng = np.random.default_rng(config.seed)

    archetypes = list(config.mix.keys())
    probs = np.array([config.mix[a] for a in archetypes], dtype=float)
    probs = probs / probs.sum()

    rows: List[Dict] = []
    for _ in range(config.n_campaigns):
        archetype = str(rng.choice(archetypes, p=probs))

        goal = float(rng.lognormal(mean=np.log(25_000), sigma=1.1))
        goal = float(np.clip(goal, 500, 5_000_000))

        # Campaign age in days.
        age = float(rng.uniform(1, 240))

        # Creator reputation (0..100): fake creators start low, honest accumulate.
        if archetype == "honest":
            rep = float(_sigmoid(np.array(rng.normal(1.0, 1.2)))) * 100
        elif archetype == "fake":
            rep = float(_sigmoid(np.array(rng.normal(-0.8, 1.2)))) * 100
        else:
            rep = float(_sigmoid(np.array(rng.normal(0.0, 1.2)))) * 100

        # Backer count and funding velocity.
        if archetype == "abandoned":
            backers = int(rng.integers(3, 40))
            # Funded early, then flatlined: velocity is low relative to age.
            velocity = float(rng.uniform(0.0, 0.45))
        elif archetype == "fake":
            backers = int(rng.integers(6, 80))
            # Burst funding in the first few days, but not exclusively.
            velocity = float(rng.uniform(0.3, 1.0))
        elif archetype == "sybil_ring":
            backers = int(rng.integers(12, 160))
            velocity = float(rng.uniform(0.15, 0.8))
        else:
            backers = int(rng.integers(5, 200))
            velocity = float(rng.uniform(0.02, 0.6))

        # Amount distribution: sybil rings split into many similar small amounts.
        if archetype == "sybil_ring":
            amount_mean = goal / max(backers, 1)
            amount_cv = 0.05 + rng.uniform(0, 0.08)  # very low dispersion
        elif archetype == "fake":
            amount_mean = goal / max(backers, 1)
            amount_cv = float(rng.uniform(0.4, 1.2))
        else:
            amount_mean = goal / max(backers, 1)
            amount_cv = float(rng.uniform(0.6, 2.5))

        clustering = _contributor_clustering(rng, archetype)

        # Repeated-funder ratio: the same addresses returning across campaigns.
        if archetype == "sybil_ring":
            repeated = float(rng.uniform(0.15, 0.85))
        elif archetype == "fake":
            repeated = float(rng.uniform(0.05, 0.55))
        else:
            repeated = float(rng.uniform(0.0, 0.30))

        # Evidence-submission timing: honest creators submit near the deadline and
        # spread submissions out; fakes dump everything early or never.
        #
        # IMPORTANT: these distributions OVERLAP deliberately. An earlier revision drew
        # evidence_count from disjoint ranges per archetype (fake 1-2, honest 2-5),
        # which made the classes trivially separable and produced a perfect 1.0 F1.
        # That is a property of the generator, not evidence that the features are
        # predictive on real data. The ranges below all share a common support and the
        # archetype only shifts the centre, so no single feature separates the classes.
        if archetype == "honest":
            evidence_delay = float(np.clip(rng.normal(0.7, 0.25), 0.0, 1.0))
            evidence_count = int(rng.integers(1, 6))
        elif archetype == "fake":
            evidence_delay = float(np.clip(rng.normal(0.4, 0.35), 0.0, 1.0))
            evidence_count = int(rng.integers(0, 4))
        elif archetype == "abandoned":
            evidence_delay = float(np.clip(rng.normal(0.85, 0.3), 0.0, 1.0))
            evidence_count = int(rng.integers(0, 2))
        else:  # sybil_ring
            evidence_delay = float(np.clip(rng.normal(0.5, 0.3), 0.0, 1.0))
            evidence_count = int(rng.integers(1, 4))

        # Label noise: a small fraction of every archetype is mislabelled, mirroring
        # the reality that some "fraudulent-looking" campaigns are legitimate and some
        # honest-looking ones are not. Without this, accuracy is trivially 1.0.
        if rng.random() < 0.04:
            archetype = "honest" if archetype != "honest" else "fake"

        description = _description_tokens(rng, archetype)

        rows.append(
            {
                "campaign_id": f"c{len(rows):06d}",
                "archetype": archetype,
                "is_fraudulent": int(archetype != "honest"),
                "goal_usd": goal,
                "age_days": age,
                "creator_reputation": rep,
                "backer_count": backers,
                "funding_velocity": velocity,
                "contributor_clustering": clustering,
                "amount_cv": amount_cv,
                "repeated_funder_ratio": repeated,
                "evidence_delay": evidence_delay,
                "evidence_count": evidence_count,
                "amount_mean_usd": amount_mean,
                "description": description,
                "dispute_count": (
                    # Overlapping: even honest campaigns occasionally have a dispute,
                    # and not every fraudulent one attracts one before it disappears.
                    int(rng.integers(0, 3))
                ),
            }
        )

    df = pd.DataFrame(rows)

    # Funding ratio (raised / goal) is clipped so the column is bounded.
    df["funding_ratio"] = np.clip(
        df["backer_count"] * df["amount_mean_usd"] / df["goal_usd"], 0, 1.5
    )

    # Dispute history is a strong but leaky signal; keep it but let the models weigh it.
    df["dispute_history"] = df["dispute_count"]

    return df


def train_test_split(df: pd.DataFrame, seed: int = DEFAULT_SEED):
    """Stratified split on the fraud label. Returns (train_df, test_df)."""
    from sklearn.model_selection import train_test_split as sk_split

    return sk_split(
        df,
        test_size=0.3,
        random_state=seed,
        stratify=df["is_fraudulent"],
    )


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    import argparse
    import os

    parser = argparse.ArgumentParser(description="Generate synthetic campaign dataset")
    parser.add_argument("--n", type=int, default=4000)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(__file__), "data", "synthetic_campaigns.csv"),
    )
    args = parser.parse_args()

    frame = generate(GeneratorConfig(n_campaigns=args.n, seed=args.seed))
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    frame.to_csv(args.out, index=False)

    print(f"Wrote {len(frame)} rows to {args.out}")
    print(frame["is_fraudulent"].value_counts().to_string())
    print()
    print(frame.groupby("archetype")[["creator_reputation", "funding_velocity",
                                      "contributor_clustering", "repeated_funder_ratio"]].mean().round(3))