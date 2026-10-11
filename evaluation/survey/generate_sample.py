"""
Generate a SYNTHETIC survey response file to exercise the analysis pipeline.

!!!!!!!!!!!!!!!! SAMPLE ONLY !!!!!!!!!!!!!!!!

The rows produced here are randomly generated. They are NOT responses from real
participants. They exist so that `analysis.py` can be run, debugged, and
demonstrated end-to-end, and so the chart code has something to draw.

Any SUS score, trust-before/after comparison, or chart computed from this file
describes numbers that were made up by a random number generator. Reporting
them as study findings would be fabrication.

To obtain real results, collect responses using `instrument.md`, export them to
a CSV with the SAME column names, and replace this file.

Generation is seeded so the pipeline output is reproducible.
"""

from __future__ import annotations

import os

import numpy as np
import pandas as pd

SEED = 20240611
N_RESPONSENTS = 48

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sample_responses_SAMPLE_ONLY.csv")

# Both trust blocks use the SAME item numbering (1..6) because they are the same six
# statements asked twice; "before" and "after" are distinguished by the column prefix,
# not by the question number. analysis.py maps after_q{i} to instrument.md question 6+i.
TRUST_BEFORE_ITEMS = [f"trust_before_q{i}" for i in range(1, 7)]
TRUST_AFTER_ITEMS = [f"trust_after_q{i}" for i in range(1, 7)]
SUS_ITEMS = [f"sus_q{i}" for i in range(1, 11)]

# Columns are ordered to match the CSV export a Google Form produces.
COLUMNS = (
    ["participant_id", "timestamp", "is_sample"]
    + TRUST_BEFORE_ITEMS
    + TRUST_AFTER_ITEMS
    + SUS_ITEMS
    + ["contribution_amount", "would_use_real_campaign", "open_increased_trust", "open_decreased_trust"]
)


def generate(n: int = N_RESPONSENTS, seed: int = SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []

    for i in range(n):
        # Each participant has a latent "trust propensity"; the before/after measures
        # are two noisy readings of it plus a small positive shift from using the
        # prototype. Without this per-person correlation, a before/after test would be
        # comparing two independent samples.
        propensity = rng.normal(2.9, 0.7)

        # Prototype exposure produces a modest, realistic improvement, with some
        # participants showing no change or a decrease.
        shift = rng.normal(0.45, 0.35)

        before = np.clip(rng.normal(propensity, 0.45, size=6), 1, 5)
        after = np.clip(rng.normal(propensity + shift, 0.45, size=6), 1, 5)

        # SUS answers: 50% positive (5), 25% neutral (3), 25% negative (1).
        sus = rng.choice([5, 3, 1], size=10, p=[0.5, 0.25, 0.25]).astype(float)

        contribution = float(np.clip(rng.lognormal(np.log(45), 0.8), 1, 500))
        would_use = int(rng.choice([1, 2, 3, 4, 5], p=[0.05, 0.07, 0.18, 0.4, 0.3]))

        rows.append(
            {
                "participant_id": f"S{1000 + i}",
                "timestamp": pd.Timestamp("2026-01-15") + pd.Timedelta(hours=int(i * 2)),
                "is_sample": True,
                **dict(zip(TRUST_BEFORE_ITEMS, before)),
                **dict(zip(TRUST_AFTER_ITEMS, after)),
                **dict(zip(SUS_ITEMS, sus)),
                "contribution_amount": round(contribution, 2),
                "would_use_real_campaign": would_use,
                "open_increased_trust": rng.choice(
                    [
                        "Escrow means money is not just a promise.",
                        "Seeing the milestone tracker made it feel less risky.",
                        "Being able to dispute without a lawyer is appealing.",
                        "Reputation badges helped me judge who to back.",
                        "",
                    ],
                    p=[0.28, 0.24, 0.2, 0.18, 0.1],
                ),
                "open_decreased_trust": rng.choice(
                    [
                        "",
                        "I still don't know who is behind a fake campaign.",
                        "Verifier votes could be bought with stake.",
                        "It was hard to tell what was real and what was a mock.",
                    ],
                    p=[0.55, 0.2, 0.15, 0.1],
                ),
            }
        )

    return pd.DataFrame(rows, columns=COLUMNS)


if __name__ == "__main__":
    frame = generate()
    frame.to_csv(OUT, index=False)
    print("!" * 72)
    print("SAMPLE ONLY -- synthetic responses for pipeline validation.")
    print("These are NOT real participants and MUST NOT be reported as findings.")
    print("!" * 72)
    print(f"\nWrote {len(frame)} synthetic rows to {OUT}")
    print(frame[["trust_before_q1", "trust_after_q1", "sus_q1"]].head().to_string(index=False))