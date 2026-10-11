"""
FastAPI wrapper around the fraud-detection models.

Design contract
---------------
The backend calls this service over HTTP with a feature payload. This service does NOT
read the backend's SQLite database directly. That separation is deliberate and required:

  - the database is owned by the backend, with its own migrations and repository layer;
  - giving the ML service direct read access would couple it to a storage engine and make
    the swap to PostgreSQL (see docs/DECISIONS.md, D-009) a two-service migration;
  - a network boundary means the ML service can be scaled, replaced, or run separately.

The consequence is that the backend is responsible for extracting features and this
service is responsible for scoring them. If a feature is missing it is treated as 0.0
rather than raising, because a partial payload from a young campaign should still return
a (low-confidence) score rather than a 500.

Run with:
    uvicorn ml_service.api:app --port 8000
"""

from __future__ import annotations

import os
import sys
from typing import Dict, List, Optional

# Allow `import train` when this module is run as a script from the repo root.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

import train as trainer  # noqa: E402

app = FastAPI(
    title="Crowdfunding Fraud ML Service",
    version="1.0.0",
    description=(
        "Scores campaigns for fraud risk using models trained on a SYNTHETIC dataset. "
        "Risk scores reflect recovered synthetic structure, not validated real-world "
        "fraud probability."
    ),
)

# Lazily loaded so the service starts even before `train.py` has been run, and so the
# model is loaded once per worker rather than per request.
_MODELS: Optional[trainer.TrainedModels] = None


def get_models() -> trainer.TrainedModels:
    global _MODELS
    if _MODELS is None:
        try:
            _MODELS = trainer.load()
        except FileNotFoundError as exc:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Models not trained. Run `python ml-service/train.py` before "
                    "starting the service."
                ),
            ) from exc
    return _MODELS


class CampaignFeatures(BaseModel):
    """Feature payload. Mirrors the columns in train.NUMERIC_FEATURES."""

    campaign_id: Optional[str] = None
    goal_usd: float = Field(0.0, description="Funding goal in USD.")
    age_days: float = Field(0.0, description="Campaign age in days.")
    creator_reputation: float = Field(0.0, ge=0, le=100)
    backer_count: int = Field(0, ge=0)
    funding_velocity: float = Field(0.0, ge=0)
    contributor_clustering: float = Field(0.0, ge=0, le=1)
    amount_cv: float = Field(0.0, ge=0)
    repeated_funder_ratio: float = Field(0.0, ge=0, le=1)
    evidence_delay: float = Field(0.0, ge=0, le=1)
    evidence_count: int = Field(0, ge=0)
    funding_ratio: float = Field(0.0, ge=0)
    dispute_history: int = Field(0, ge=0)
    text_similarity: float = Field(0.0, ge=0, description="Mean TF-IDF cosine similarity.")
    description: str = Field("", description="Raw text; used only for the TF-IDF signal.")


class RiskResponse(BaseModel):
    campaign_id: Optional[str]
    risk_score: float
    risk_band: str
    components: Dict[str, object]
    top_factors: List[Dict[str, object]]
    disclaimer: str


@app.get("/health")
def health() -> Dict[str, object]:
    try:
        get_models()
        trained = True
    except HTTPException:
        trained = False
    return {"status": "ok", "models_trained": trained}


@app.get("/metrics")
def metrics() -> Dict[str, object]:
    """Returns the training-time evaluation metrics."""
    return get_models().metrics


@app.get("/features")
def feature_importance() -> Dict[str, object]:
    """Returns feature importances and logistic coefficients for interpretability."""
    models = get_models()
    return {
        "random_forest_importance": models.feature_importance,
        "logistic_coefficients": models.logistic_coef,
        "interpretation": (
            "importance = how much a feature contributes to the Random Forest split; "
            "coefficient = signed linear effect from Logistic Regression. Neither is a "
            "causal claim."
        ),
    }


@app.post("/score", response_model=RiskResponse)
def score(features: CampaignFeatures) -> RiskResponse:
    """Scores one campaign, returning a 0-100 risk and the top contributing factors."""
    models = get_models()
    payload = features.model_dump()
    description = payload.pop("description", "")
    campaign_id = payload.pop("campaign_id", None)

    # text_similarity is a peer-relative feature the backend cannot compute on a single
    # campaign in isolation. When the backend has already computed it, it is supplied
    # above; otherwise we fall back to 0.0 and the score leans on the other features.
    result = trainer.score_campaign(models, payload, description)
    result["campaign_id"] = campaign_id
    return RiskResponse(**result)


@app.post("/score/batch")
def score_batch(items: List[CampaignFeatures]) -> List[RiskResponse]:
    """Scores a list of campaigns. Used by the backend to pre-compute list-page badges."""
    return [score(item) for item in items]


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)