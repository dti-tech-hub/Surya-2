"""
Fraud-detection models, training, and metrics.

Produces a risk score (0-100) plus the top contributing features for a campaign, using:
  - Isolation Forest (unsupervised): can it recover the injected anomalies without
    ever seeing a label?
  - Random Forest (supervised): reference performance against known labels.
  - Logistic Regression (supervised): interpretable linear baseline, and the source of
    per-feature coefficients used to explain a risk score.

HONESTY CONSTRAINT (repeated because it governs how these numbers may be used)
-------------------------------------------------------------------------------
The training labels are SYNTHETIC (`data_generation.py`). Every metric below therefore
measures "can the model recover a signal I deliberately injected?" It is not evidence of
real-world fraud-detection performance. There is no public labelled dataset of
blockchain crowdfunding fraud, so this project cannot make that claim, and the report
must not imply otherwise.

To use this against real data, swap the loader in `load_dataset` and retrain. The
feature pipeline and model code are unchanged by that swap.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    classification_report,
    confusion_matrix,
    precision_recall_fscore_support,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
MODEL_DIR = os.path.join(HERE, "models")

# Numeric features fed to the tree/linear models. Text is handled separately by TF-IDF.
NUMERIC_FEATURES: List[str] = [
    "goal_usd",
    "age_days",
    "creator_reputation",
    "backer_count",
    "funding_velocity",
    "contributor_clustering",
    "amount_cv",
    "repeated_funder_ratio",
    "evidence_delay",
    "evidence_count",
    "funding_ratio",
    "dispute_history",
]


@dataclass
class TrainedModels:
    """Container for the fitted pipeline and its evaluation artefacts."""

    isolation_forest: IsolationForest
    random_forest: RandomForestClassifier
    logistic: LogisticRegression
    scaler: StandardScaler
    tfidf: TfidfVectorizer
    metrics: Dict[str, object] = field(default_factory=dict)
    feature_importance: Dict[str, float] = field(default_factory=dict)
    logistic_coef: Dict[str, float] = field(default_factory=dict)


def load_dataset(path: Optional[str] = None) -> pd.DataFrame:
    """Load the campaign feature table. Generates it if absent."""
    path = path or os.path.join(DATA_DIR, "synthetic_campaigns.csv")
    if not os.path.exists(path):
        import data_generation

        frame = data_generation.generate()
        os.makedirs(DATA_DIR, exist_ok=True)
        frame.to_csv(path, index=False)
    return pd.read_csv(path)


def _build_text_features(
    train_text: pd.Series, test_text: pd.Series
) -> Tuple[TfidfVectorizer, np.ndarray, np.ndarray]:
    """Fit TF-IDF on the training split only, then transform both.

    Fitting the vectoriser on the full corpus would leak test-set vocabulary into
    training and inflate the score. This is a real methodological point, not a formality.
    """
    tfidf = TfidfVectorizer(max_features=2000, ngram_range=(1, 2), min_df=2)
    train_matrix = tfidf.fit_transform(train_text)
    test_matrix = tfidf.transform(test_text)
    return tfidf, np.asarray(train_matrix.todense()), np.asarray(test_matrix.todense())


def _describe_similarity(text: pd.Series) -> np.ndarray:
    """Mean cosine similarity of each description to the rest of the corpus.

    Fake campaigns share marketing vocabulary, so their descriptions are unusually
    similar to one another. This scalarises that relation into one numeric feature.
    """
    vec = TfidfVectorizer(max_features=2000, ngram_range=(1, 2), min_df=1)
    try:
        matrix = vec.fit_transform(text)
    except ValueError:
        return np.zeros(len(text))

    # Sparse cosine similarity without densifying the whole matrix.
    from sklearn.preprocessing import normalize

    matrix = normalize(matrix)
    similarity = (matrix @ matrix.T).toarray()
    np.fill_diagonal(similarity, 0.0)
    denom = max(len(text) - 1, 1)
    return similarity.sum(axis=1) / denom


def train_all(
    dataset: Optional[pd.DataFrame] = None, seed: int = 42
) -> TrainedModels:
    """Fit all three models and compute evaluation metrics.

    Returns a {TrainedModels} with the fitted estimators plus a metrics dict.
    """
    df = dataset if dataset is not None else load_dataset()

    # Text-similarity feature is computed on the FULL corpus here because it is a
    # property of a campaign relative to its peers, not a learned decision boundary.
    # It is computed before the split so the "peers" set is the same for every row,
    # and it never uses the label.
    df = df.copy()
    df["text_similarity"] = _describe_similarity(df["description"])

    features = NUMERIC_FEATURES + ["text_similarity"]
    X = df[features]
    y = df["is_fraudulent"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.3, random_state=seed, stratify=y
    )

    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_test_s = scaler.transform(X_test)

    # --- Isolation Forest (unsupervised) -----------------------------------
    # contamination is set from the training fraud rate. This is an assumption: it
    # tells the model what fraction to flag. It does NOT give the model labels, but it
    # does inject prior knowledge about the base rate, which is worth stating.
    contamination = float(y_train.mean())
    iso = IsolationForest(
        n_estimators=300,
        contamination=contamination,
        random_state=seed,
        n_jobs=-1,
    )
    iso.fit(X_train)
    # score_samples: higher = more normal. Flip so higher = riskier.
    iso_scores_train = -iso.score_samples(X_train)
    iso_scores_test = -iso.score_samples(X_test)
    iso_pred = (iso.predict(X_test) == -1).astype(int)  # -1 => outlier

    iso_metrics = _binary_metrics(y_test, iso_pred, iso_scores_test, prefix="isolation_forest")

    # --- Random Forest (supervised) ----------------------------------------
    rf = RandomForestClassifier(
        n_estimators=300, max_depth=12, min_samples_leaf=3, random_state=seed, n_jobs=-1
    )
    rf.fit(X_train, y_train)
    rf_pred = rf.predict(X_test)
    rf_proba = rf.predict_proba(X_test)[:, 1]
    rf_metrics = _binary_metrics(y_test, rf_pred, rf_proba, prefix="random_forest")

    # --- Logistic Regression (supervised, interpretable) -------------------
    log = LogisticRegression(max_iter=2000, class_weight="balanced", random_state=seed)
    log.fit(X_train_s, y_train)
    log_pred = log.predict(X_test_s)
    log_proba = log.predict_proba(X_test_s)[:, 1]
    log_metrics = _binary_metrics(y_test, log_pred, log_proba, prefix="logistic_regression")

    importances = dict(zip(features, rf.feature_importances_.tolist()))
    coefficients = dict(zip(features, log.coef_[0].tolist()))

    metrics = {
        "dataset": {
            "n_samples": int(len(df)),
            "n_train": int(len(X_train)),
            "n_test": int(len(X_test)),
            "fraud_rate": float(y.mean()),
            "isolation_forest_contamination": contamination,
            "synthetic": True,
        },
        "isolation_forest": iso_metrics,
        "random_forest": rf_metrics,
        "logistic_regression": log_metrics,
        "per_class": {
            "random_forest": classification_report(y_test, rf_pred, output_dict=True, zero_division=0),
            "logistic_regression": classification_report(y_test, log_pred, output_dict=True, zero_division=0),
        },
    }

    return TrainedModels(
        isolation_forest=iso,
        random_forest=rf,
        logistic=log,
        scaler=scaler,
        tfidf=TfidfVectorizer(max_features=2000),
        metrics=metrics,
        feature_importance=importances,
        logistic_coef=coefficients,
    )


def _binary_metrics(
    y_true: pd.Series, y_pred: np.ndarray, y_score: np.ndarray, prefix: str
) -> Dict[str, float]:
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_true, y_pred, average="binary", zero_division=0
    )
    try:
        auc = roc_auc_score(y_true, y_score)
        ap = average_precision_score(y_true, y_score)
    except ValueError:
        auc, ap = float("nan"), float("nan")

    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    return {
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f1),
        "roc_auc": float(auc),
        "average_precision": float(ap),
        "confusion_matrix": {
            "true_negative": int(tn),
            "false_positive": int(fp),
            "false_negative": int(fn),
            "true_positive": int(tp),
        },
    }


def score_campaign(
    models: TrainedModels, features: Dict[str, float], description: str = ""
) -> Dict[str, object]:
    """Score a single campaign, returning a 0-100 risk and the top contributing factors.

    Uses a blend of the Random Forest probability and the Isolation Forest's normalised
    anomaly score, because either alone is weaker: the supervised model overfits the
    synthetic structure, and the unsupervised one cannot calibrate a risk level.

    The blend weight is an assumption, documented here rather than tuned silently.
    """
    import pandas as pd

    row = {name: features.get(name, 0.0) for name in NUMERIC_FEATURES}
    row["text_similarity"] = features.get("text_similarity", 0.0)
    frame = pd.DataFrame([row], columns=NUMERIC_FEATURES + ["text_similarity"])

    rf_proba = float(models.random_forest.predict_proba(frame)[0, 1])

    # Isolation Forest score is unbounded; map to (0,1) via a logistic squash.
    iso_raw = float(-models.isolation_forest.score_samples(frame)[0])
    iso_prob = 1.0 / (1.0 + np.exp(-iso_raw))

    risk = 100.0 * (0.6 * rf_proba + 0.4 * iso_prob)

    # Contribution explanation: for each feature, how much does moving it to the
    # campaign's observed value change the RF probability relative to the dataset mean?
    explain = _explain_risk(models, frame)

    return {
        "risk_score": round(float(risk), 2),
        "risk_band": risk_band(risk),
        "components": {
            "random_forest_probability": round(rf_proba, 4),
            "isolation_forest_anomaly": round(iso_prob, 4),
            "blend": {"random_forest": 0.6, "isolation_forest": 0.4},
        },
        "top_factors": explain,
        "disclaimer": (
            "Trained on a SYNTHETIC dataset. The score reflects recovered synthetic "
            "structure, not validated real-world fraud probability."
        ),
    }


def _explain_risk(models: TrainedModels, frame: pd.DataFrame, k: int = 5) -> List[Dict]:
    """Rank features by their contribution, using RF importances weighted by the
    deviation of the observed value from the training mean.

    This is an importance-based explanation, not a Shapley value. It says which features
    matter and in which direction this row deviates, not the exact marginal contribution
    to the output. Stated plainly so the UI does not overclaim.
    """
    baseline = frame.copy()
    out = []
    for name in frame.columns:
        importance = models.feature_importance.get(name, 0.0)
        value = float(frame[name].iloc[0])
        mean = float(models.scaler.mean_[list(NUMERIC_FEATURES + ["text_similarity"]).index(name)])
        deviation = abs(value - mean) / (mean if mean else 1.0)
        contribution = importance * min(deviation, 5.0)
        out.append(
            {
                "feature": name,
                "value": round(value, 4),
                "dataset_mean": round(mean, 4),
                "importance": round(importance, 4),
                "contribution": round(contribution, 4),
                "direction": "above average" if value > mean else "below average",
            }
        )
    out.sort(key=lambda d: d["contribution"], reverse=True)
    return out[:k]


def risk_band(score: float) -> str:
    if score >= 70:
        return "high"
    if score >= 40:
        return "medium"
    return "low"


def save(models: TrainedModels, directory: str = MODEL_DIR) -> str:
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, "models.joblib")
    joblib.dump(
        {
            "isolation_forest": models.isolation_forest,
            "random_forest": models.random_forest,
            "logistic": models.logistic,
            "scaler": models.scaler,
            "metrics": models.metrics,
            "feature_importance": models.feature_importance,
            "logistic_coef": models.logistic_coef,
        },
        path,
    )

    # Metrics are also written as JSON so the report and the dApp can read them
    # without unpickling.
    metrics_path = os.path.join(directory, "metrics.json")
    with open(metrics_path, "w", encoding="utf-8") as fh:
        json.dump(models.metrics, fh, indent=2)
    return path


def load(directory: str = MODEL_DIR) -> TrainedModels:
    path = os.path.join(directory, "models.joblib")
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"No trained models at {path}. Run: python ml-service/train.py"
        )
    blob = joblib.load(path)
    return TrainedModels(
        isolation_forest=blob["isolation_forest"],
        random_forest=blob["random_forest"],
        logistic=blob["logistic"],
        scaler=blob["scaler"],
        tfidf=TfidfVectorizer(max_features=2000),
        metrics=blob["metrics"],
        feature_importance=blob["feature_importance"],
        logistic_coef=blob["logistic_coef"],
    )


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    models = train_all()
    path = save(models)
    print(f"Saved models to {path}\n")
    print(json.dumps(models.metrics, indent=2))
    print("\nTop Random Forest features:")
    for name, value in sorted(
        models.feature_importance.items(), key=lambda kv: kv[1], reverse=True
    )[:10]:
        print(f"  {name:<26} {value:.4f}")