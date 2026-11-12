# ml/app.py
from pathlib import Path
from typing import Literal

import joblib
import numpy as np
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
# Older bundles call this key "model_type".
model_type = bundle.get("type") or bundle.get("model_type")
threshold = float(bundle["threshold"])

if model_type not in ("random_forest", "isolation_forest"):
    raise ValueError(
        f"Unsupported model type: {model_type}"
    )

type_mapping = load_type_mapping(MAPPING_PATH)


# --------------------------------------------------
# 2b. Explain a Random Forest score
# --------------------------------------------------
# Each tree reaches its answer by a path of yes/no questions about the
# features. At every step the fraud probability changes, and that change is
# credited to the feature the question was about. Averaged over all trees,
# these credits add up exactly:
#
#     fraud score = base value + sum of the feature contributions
#
# where the base value is the model's average answer before it has looked
# at anything. A positive contribution pushed the score up; a negative one
# pushed it down. This is the decision-path attribution method.

def explain_random_forest(forest, values, fraud_index):
    x = np.asarray(values, dtype=np.float32)
    contributions = np.zeros(len(values), dtype=float)
    base = 0.0

    for estimator in forest.estimators_:
        tree = estimator.tree_
        node_values = tree.value[:, 0, :]

        def fraud_probability(node):
            return node_values[node][fraud_index] / node_values[node].sum()

        node = 0
        base += fraud_probability(0)
        while tree.children_left[node] != -1:
            feature = tree.feature[node]
            child = (
                tree.children_left[node]
                if x[feature] <= tree.threshold[node]
                else tree.children_right[node]
            )
            contributions[feature] += (
                fraud_probability(child) - fraud_probability(node)
            )
            node = child

    count = len(forest.estimators_)
    return base / count, contributions / count


# --------------------------------------------------
# 3. Create the FastAPI application
# --------------------------------------------------

app = FastAPI(
    title="Wallet Fraud Detection API",
    description=(
        "Machine-learning service for wallet transaction "
        "fraud detection."
    ),
    version="2.0.0",
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

            # Why the model gave this score, largest effect first.
            base_value, feature_effects = explain_random_forest(
                model, values, fraud_index
            )
            contributions = sorted(
                (
                    {
                        "feature": name,
                        "value": float(value),
                        "contribution": round(float(effect), 6),
                    }
                    for name, value, effect in zip(
                        feature_order, values, feature_effects
                    )
                ),
                key=lambda item: abs(item["contribution"]),
                reverse=True,
            )

        # Isolation Forest: higher anomaly score means
        # a more anomalous transaction, not a fraud probability.
        else:
            fraud_score = float(
                -model.score_samples(X)[0]
            )

            score_is_probability = False
            base_value, contributions = None, []

        flagged = fraud_score >= threshold

        return {
            "fraud_score": fraud_score,
            "flagged": bool(flagged),
            "model": model_type,
            "threshold": threshold,
            "score_is_probability": score_is_probability,
            "base_value": (
                None if base_value is None else round(float(base_value), 6)
            ),
            "contributions": contributions,
        }

    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from exc