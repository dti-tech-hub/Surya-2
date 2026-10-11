"""
Survey analysis: SUS score, descriptive statistics, and trust-before vs trust-after.

Computes:
  1. System Usability Scale score per participant (standard 0-100), plus mean/SD and
     the conventional SUS interpretation bands (Bangor et al., 2009).
  2. Mean and standard deviation of every Likert item.
  3. A paired before/after comparison of the trust block.
  4. An effect size (Cohen's d for paired samples) and a paired t-test.
  5. Charts.

SAMPLE-DATA WARNING
-------------------
By default this reads `sample_responses_SAMPLE_ONLY.csv`, which contains randomly
generated rows. The output therefore validates the pipeline, not the hypothesis. Every
chart and table produced from sample data is stamped `SAMPLE DATA`. To run the study for
real, replace the CSV with genuine responses using the same column names.

Usage:
  python analysis.py                       # runs against sample data (default)
  python analysis.py --input real.csv       # run against real responses
  python analysis.py --input real.csv --allow-findings   # drop the SAMPLE stamp
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_INPUT = os.path.join(HERE, "sample_responses_SAMPLE_ONLY.csv")
PLOT_DIR = os.path.join(HERE, "plots")
RESULTS_DIR = os.path.join(HERE, "results")

TRUST_BEFORE = [f"trust_before_q{i}" for i in range(1, 7)]
TRUST_AFTER = [f"trust_after_q{i}" for i in range(1, 7)]
SUS_ITEMS = [f"sus_q{i}" for i in range(1, 11)]

# Bangor et al. (2009) adjective-rating interpretation bands.
SUS_BANDS = [(0, 25, "Worst Imaginable"), (25, 39, "Poor"), (39, 52, "OK"),
             (52, 73, "Good"), (73, 85, "Excellent"), (85, 101, "Best Imaginable")]


def sus_band(score: float) -> str:
    for low, high, label in SUS_BANDS:
        if low <= score < high:
            return label
    return "Unknown"


def compute_sus(df: pd.DataFrame) -> pd.Series:
    """Per-participant SUS score on the standard 0-100 scale.

    Standard scoring: each item is 0-4 after adjusting for the 1-5 response scale
    (odd items subtract 1). Odd-numbered items are positive and even are negative, so
    odd contributions are (score - 1) and even are (5 - score). Sum, then multiply by
    2.5 to reach 0-100.
    """
    items = df[SUS_ITEMS].astype(float)
    contributions = pd.DataFrame(index=df.index)
    for i, col in enumerate(SUS_ITEMS, start=1):
        value = items[col]
        contributions[col] = (value - 1) if i % 2 == 1 else (5 - value)
    return contributions.sum(axis=1) * 2.5


def cohens_d_paired(before: np.ndarray, after: np.ndarray) -> float:
    """Paired-sample Cohen's d using the mean of the per-participant differences."""
    diff = after - before
    sd_diff = np.std(diff, ddof=1) if len(diff) > 1 else 0.0
    if sd_diff == 0:
        return 0.0
    return float(np.mean(diff) / sd_diff)


def paired_test(before: np.ndarray, after: np.ndarray) -> dict:
    """Paired t-test. Uses scipy when available, otherwise falls back to a normal
    approximation and clearly records that the p-value is approximate."""
    diff = after - before
    n = len(diff)
    mean_diff = float(np.mean(diff))
    sd_diff = float(np.std(diff, ddof=1)) if n > 1 else 0.0
    t_stat = mean_diff / (sd_diff / np.sqrt(n)) if sd_diff > 0 else float("nan")

    result = {
        "n": int(n),
        "mean_difference": mean_diff,
        "sd_difference": sd_diff,
        "t_statistic": float(t_stat),
        "cohens_d": cohens_d_paired(before, after),
        "method": "",
        "p_value": None,
    }

    try:
        from scipy import stats  # type: ignore

        test = stats.ttest_rel(after, before)
        result["p_value"] = float(test.pvalue)
        result["method"] = "paired t-test (scipy.stats.ttest_rel)"
    except Exception:
        # Normal approximation with a continuity-free two-sided normal p-value.
        if not np.isnan(t_stat):
            from math import erfc

            result["p_value"] = float(erfc(abs(t_stat) / np.sqrt(2)))
        result["method"] = "normal approximation (scipy unavailable)"

    return result


def describe(series: pd.Series) -> dict:
    values = series.astype(float).dropna()
    if values.empty:
        return {"n": 0, "mean": None, "sd": None, "min": None, "max": None, "median": None}
    return {
        "n": int(len(values)),
        "mean": round(float(values.mean()), 3),
        "sd": round(float(values.std(ddof=1)) if len(values) > 1 else 0.0, 3),
        "min": round(float(values.min()), 3),
        "max": round(float(values.max()), 3),
        "median": round(float(values.median()), 3),
    }


def plot_histogram(sus_scores: pd.Series, is_sample: bool, path: str) -> None:
    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.hist(sus_scores.astype(float), bins=12, color="#4C72B0", edgecolor="white")
    ax.axvline(sus_scores.mean(), color="#C44E52", linestyle="--", label=f"mean = {sus_scores.mean():.1f}")
    ax.set_xlabel("SUS score (0-100)")
    ax.set_ylabel("participants")
    ax.set_title(
        ("SAMPLE DATA -- synthetic responses, not real findings" if is_sample else "SUS score distribution")
    )
    ax.legend()
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_before_after(df: pd.DataFrame, before_cols, after_cols, is_sample: bool, path: str) -> None:
    before_means = df[before_cols].astype(float).mean(axis=1)
    after_means = df[after_cols].astype(float).mean(axis=1)

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))

    # Paired slope chart.
    for b, a in zip(before_means, after_means):
        axes[0].plot([0, 1], [b, a], color="#999999", alpha=0.4, linewidth=0.9)
    axes[0].plot([0, 1], [before_means.mean(), after_means.mean()],
                 color="#C44E52", linewidth=3, marker="o", label="mean")
    axes[0].set_xticks([0, 1])
    axes[0].set_xticklabels(["Before", "After"])
    axes[0].set_ylabel("Mean trust (1-5)")
    axes[0].set_title("Trust before vs after (paired)")
    axes[0].legend()
    axes[0].grid(alpha=0.3)

    # Distribution shift.
    axes[1].hist(before_means, bins=12, alpha=0.6, label="before", color="#4C72B0")
    axes[1].hist(after_means, bins=12, alpha=0.6, label="after", color="#55A868")
    axes[1].set_xlabel("Mean trust (1-5)")
    axes[1].set_title("Distribution shift")
    axes[1].legend()
    axes[1].grid(alpha=0.3)

    if is_sample:
        fig.suptitle("SAMPLE DATA -- synthetic responses, not real findings", color="#C44E52", fontsize=11)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyse the crowdfunding trust survey")
    parser.add_argument("--input", default=DEFAULT_INPUT)
    parser.add_argument(
        "--allow-findings",
        action="store_true",
        help="Drop the SAMPLE DATA stamp. Only valid when --input holds real responses.",
    )
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"input not found: {args.input}", file=sys.stderr)
        return 2

    df = pd.read_csv(args.input)

    # Determine whether this is synthetic. The flag column is preferred; the filename
    # is a fallback. When in doubt the data is treated as sample.
    is_sample = True
    if "is_sample" in df.columns:
        is_sample = bool(df["is_sample"].astype(str).str.lower().isin(["true", "1"]).all())
    elif "SAMPLE" not in os.path.basename(args.input).upper():
        is_sample = False
    if args.allow_findings:
        is_sample = False

    stamp = "SAMPLE DATA -- synthetic responses, not real findings" if is_sample else "REAL DATA"

    print("=" * 78)
    print(f"  {stamp}")
    print(f"  file: {os.path.basename(args.input)}   n = {len(df)}")
    print("=" * 78)

    # --- SUS ---------------------------------------------------------------
    if all(c in df.columns for c in SUS_ITEMS):
        sus_scores = compute_sus(df)
        sus_mean = float(sus_scores.mean())
        sus_sd = float(sus_scores.std(ddof=1)) if len(sus_scores) > 1 else 0.0
        print("\n--- System Usability Scale ---")
        print(f"  SUS score   : {sus_mean:.1f} (SD {sus_sd:.1f}), range "
              f"{sus_scores.min():.0f}-{sus_scores.max():.0f}")
        print(f"  Interpretation: {sus_band(sus_mean)}")
    else:
        sus_scores = pd.Series(dtype=float)
        sus_mean = sus_sd = float("nan")
        print("\n--- System Usability Scale --- column mismatch, skipped")

    # --- Per-item descriptives ---------------------------------------------
    item_rows = []
    for col in TRUST_BEFORE + TRUST_AFTER + SUS_ITEMS:
        if col in df.columns:
            item_rows.append({"item": col, **describe(df[col])})
    items_df = pd.DataFrame(item_rows)

    # --- Paired trust comparison -------------------------------------------
    comparison = None
    if all(c in df.columns for c in TRUST_BEFORE + TRUST_AFTER):
        before_mean = df[TRUST_BEFORE].astype(float).mean(axis=1).to_numpy()
        after_mean = df[TRUST_AFTER].astype(float).mean(axis=1).to_numpy()
        comparison = paired_test(before_mean, after_mean)

        print("\n--- Trust: before vs after (paired) ---")
        print(f"  before mean : {before_mean.mean():.3f} (SD {before_mean.std(ddof=1):.3f})")
        print(f"  after mean  : {after_mean.mean():.3f} (SD {after_mean.std(ddof=1):.3f})")
        print(f"  change      : {comparison['mean_difference']:+.3f}  "
              f"(paired t = {comparison['t_statistic']:.3f}, "
              f"p = {comparison['p_value']:.4g}, d = {comparison['cohens_d']:.3f})")
        print(f"  method      : {comparison['method']}")
    else:
        print("\n--- Trust comparison --- column mismatch, skipped")

    # --- Charts ------------------------------------------------------------
    os.makedirs(PLOT_DIR, exist_ok=True)
    os.makedirs(RESULTS_DIR, exist_ok=True)

    if not sus_scores.empty:
        plot_histogram(sus_scores, is_sample, os.path.join(PLOT_DIR, "sus_distribution.png"))
    plot_before_after(df, TRUST_BEFORE, TRUST_AFTER, is_sample,
                      os.path.join(PLOT_DIR, "trust_before_after.png"))

    # --- Machine-readable output -------------------------------------------
    payload = {
        "data_status": "SAMPLE" if is_sample else "REAL",
        "warning": (
            "Synthetic responses for pipeline validation. These numbers are not study findings."
            if is_sample else None
        ),
        "input_file": os.path.basename(args.input),
        "n_respondents": int(len(df)),
        "sus": {
            "mean": round(sus_mean, 2) if not np.isnan(sus_mean) else None,
            "sd": round(sus_sd, 2) if not np.isnan(sus_sd) else None,
            "interpretation": sus_band(sus_mean) if not np.isnan(sus_mean) else None,
            "scores": [round(float(x), 2) for x in sus_scores.tolist()],
        },
        "items": items_df.to_dict(orient="records"),
        "trust_before_after": comparison,
        "contribution_amount": describe(df["contribution_amount"]) if "contribution_amount" in df else None,
    }

    out_path = os.path.join(RESULTS_DIR, "survey_results.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)

    print(f"\nWrote {out_path}")
    print(f"Wrote charts to {PLOT_DIR}")

    if is_sample:
        print("\n" + "!" * 78)
        print("  REMINDER: the input was synthetic sample data. The numbers above")
        print("  demonstrate that the analysis pipeline runs, and nothing more.")
        print("  Do NOT report them as user-study results.")
        print("!" * 78)

    return 0


if __name__ == "__main__":
    sys.exit(main())