# ml/app.py
from pathlib import Path
from typing import Literal

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .features import load_type_mapping, build_features


# --------------------------------------------------
# 1. Locate the model and type-mapping file
# --------------------------------------------------

# app.py is inside the nested ml folder.
# The model and data folder are in its parent directory.
ML_DIR = Path(__file__).resolve().parents[1]

MODEL_PATH = ML_DIR / "fraud_model.pkl"
MAPPING_PATH = (
    ML_DIR / "data" / "paysim_processed.type_mapping.json"
)


# --------------------------------------------------
# 2. Load the saved model bundle
# --------------------------------------------------

if not MODEL_PATH.exists():
    raise FileNotFoundError(
        f"Fraud model not found: {MODEL_PATH}"
    )

if not MAPPING_PATH.exists():
    raise FileNotFoundError(
        f"Type mapping not found: {MAPPING_PATH}"
    )

bundle = joblib.load(MODEL_PATH)

model = bundle["model"]
feature_order = bundle["features"]
model_type = bundle["type"]
threshold = float(bundle["threshold"])

if model_type not in ("random_forest", "isolation_forest"):
    raise ValueError(
        f"Unsupported model type: {model_type}"
    )

type_mapping = load_type_mapping(MAPPING_PATH)


# --------------------------------------------------
# 3. Create the FastAPI application
# --------------------------------------------------

app = FastAPI(
    title="Wallet Fraud Detection API",
    description=(
        "Machine-learning service for wallet transaction "
        "fraud detection."
    ),
    version="1.0.0",
)


# --------------------------------------------------
# 4. Validate incoming transactions
# --------------------------------------------------

class Txn(BaseModel):
    type: Literal["TRANSFER", "CASH_OUT"]

    amount: float = Field(gt=0, allow_inf_nan=False)
    oldbalanceOrg: float = Field(ge=0, allow_inf_nan=False)
    newbalanceOrig: float = Field(ge=0, allow_inf_nan=False)
    oldbalanceDest: float = Field(ge=0, allow_inf_nan=False)
    newbalanceDest: float = Field(ge=0, allow_inf_nan=False)


# --------------------------------------------------
# 5. Health-check endpoint
# --------------------------------------------------

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": model_type,
        "threshold": threshold,
        "feature_count": len(feature_order),
    }


# --------------------------------------------------
# 6. Fraud-scoring endpoint
# --------------------------------------------------

@app.post("/score")
def score(t: Txn):
    try:
        # Convert the request into the features used during training.
        payload = (
            t.model_dump()
            if hasattr(t, "model_dump")
            else t.dict()
        )

        values = build_features(
            payload,
            type_mapping,
            feature_order,
        )

        # Preserve the exact feature order and names.
        X = pd.DataFrame(
            [values],
            columns=feature_order,
        )

        # Random Forest: probability of the fraud class (label 1).
        if model_type == "random_forest":
            classes = list(model.classes_)

            if 1 not in classes:
                raise RuntimeError(
                    "The model has no class labelled 1."
                )

            fraud_index = classes.index(1)

            fraud_score = float(
                model.predict_proba(X)[0][fraud_index]
            )

            score_is_probability = True

        # Isolation Forest: higher anomaly score means
        # a more anomalous transaction, not a fraud probability.
        else:
            fraud_score = float(
                -model.score_samples(X)[0]
            )

            score_is_probability = False

        flagged = fraud_score >= threshold

        return {
            "fraud_score": fraud_score,
            "flagged": bool(flagged),
            "model": model_type,
            "threshold": threshold,
            "score_is_probability": score_is_probability,
        }

    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from exc