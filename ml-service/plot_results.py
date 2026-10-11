"""
Charts for the ML evaluation section.

Renders to `ml-service/plots/`:
  - model_comparison.png    precision/recall/F1/AUC across the three models
  - confusion_matrices.png  side-by-side confusion matrices
  - feature_importance.png  Random Forest importances
  - data_distribution.png   archetype feature overlap (shows why classes are not separable)

Run: python ml-service/plot_results.py
"""

from __future__ import annotations

import json
import os
import sys

import matplotlib

matplotlib.use("Agg")  # headless: must be set before pyplot import
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
PLOT_DIR = os.path.join(HERE, "plots")
MODEL_DIR = os.path.join(HERE, "models")
DATA_PATH = os.path.join(HERE, "data", "synthetic_campaigns.csv")

MODELS = ["isolation_forest", "random_forest", "logistic_regression"]
LABELS = ["Isolation\nForest (unsup.)", "Random\nForest", "Logistic\nRegression"]


def load_metrics() -> dict:
    with open(os.path.join(MODEL_DIR, "metrics.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def plot_model_comparison(metrics: dict) -> str:
    fig, ax = plt.subplots(figsize=(9, 5))
    width = 0.2
    metrics_names = ["precision", "recall", "f1", "roc_auc"]
    colors = ["#4C72B0", "#DD8452", "#55A868", "#C44E52"]

    for i, m in enumerate(metrics_names):
        values = [metrics[model][m] for model in MODELS]
        positions = np.arange(len(MODELS)) + (i - 1.5) * width
        bars = ax.bar(positions, values, width, label=m.replace("_", " ").upper(), color=colors[i])
        ax.bar_label(bars, fmt="%.3f", fontsize=8, padding=2)

    ax.set_xticks(np.arange(len(MODELS)))
    ax.set_xticklabels(LABELS)
    ax.set_ylabel("Score")
    ax.set_ylim(0, 1.12)
    ax.set_title("Model comparison on SYNTHETIC data (not real-world fraud performance)")
    ax.legend(loc="lower right", fontsize=8)
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()

    path = os.path.join(PLOT_DIR, "model_comparison.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_confusion(metrics: dict) -> str:
    fig, axes = plt.subplots(1, 3, figsize=(13, 4))
    for ax, model, label in zip(axes, MODELS, LABELS):
        cm = metrics[model]["confusion_matrix"]
        matrix = np.array(
            [[cm["true_negative"], cm["false_positive"]],
             [cm["false_negative"], cm["true_positive"]]]
        )
        ax.imshow(matrix, cmap="Blues")
        for (i, j), val in np.ndenumerate(matrix):
            ax.text(j, i, f"{val}", ha="center", va="center",
                    color="white" if val > matrix.max() / 2 else "black", fontsize=13)
        ax.set_xticks([0, 1]); ax.set_xticklabels(["Pred legit", "Pred fraud"])
        ax.set_yticks([0, 1]); ax.set_yticklabels(["Actual legit", "Actual fraud"])
        ax.set_title(label, fontsize=10)
    fig.suptitle("Confusion matrices (synthetic test set)", fontsize=12)
    fig.tight_layout()

    path = os.path.join(PLOT_DIR, "confusion_matrices.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_feature_importance(metrics: dict) -> str:
    with open(os.path.join(MODEL_DIR, "models.joblib"), "rb") as fh:
        import joblib

        blob = joblib.load(fh)
    importance = blob["feature_importance"]
    ordered = sorted(importance.items(), key=lambda kv: kv[1])

    fig, ax = plt.subplots(figsize=(9, 5))
    ax.barh([k for k, _ in ordered], [v for _, v in ordered], color="#4C72B0")
    ax.set_xlabel("Random Forest importance")
    ax.set_title("Feature importance (trained on synthetic data)")
    ax.grid(axis="x", alpha=0.3)
    fig.tight_layout()

    path = os.path.join(PLOT_DIR, "feature_importance.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_data_distribution() -> str:
    if not os.path.exists(DATA_PATH):
        return ""
    df = pd.read_csv(DATA_PATH)

    fig, axes = plt.subplots(1, 3, figsize=(14, 4))
    features = ["contributor_clustering", "funding_velocity", "creator_reputation"]
    for ax, feature in zip(axes, features):
        for archetype, group in df.groupby("archetype"):
            ax.hist(group[feature], bins=25, alpha=0.4, label=archetype, density=True)
        ax.set_title(feature)
        ax.set_xlabel("value")
        ax.set_ylabel("density")
    axes[0].legend(fontsize=8)
    fig.suptitle(
        "Feature distributions overlap by design — an earlier non-overlapping "
        "generator yielded a meaningless perfect F1",
        fontsize=10,
    )
    fig.tight_layout()

    path = os.path.join(PLOT_DIR, "data_distribution.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def main() -> int:
    os.makedirs(PLOT_DIR, exist_ok=True)
    metrics = load_metrics()

    written = [
        plot_model_comparison(metrics),
        plot_confusion(metrics),
        plot_feature_importance(metrics),
        plot_data_distribution(),
    ]

    for path in written:
        if path:
            print(f"Wrote {path}")

    # Print a compact table for the report.
    print("\n{:<24} {:>9} {:>9} {:>9} {:>9}".format("model", "precision", "recall", "F1", "ROC-AUC"))
    for model in MODELS:
        m = metrics[model]
        print("{:<24} {:>9.3f} {:>9.3f} {:>9.3f} {:>9.3f}".format(
            model, m["precision"], m["recall"], m["f1"], m["roc_auc"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())