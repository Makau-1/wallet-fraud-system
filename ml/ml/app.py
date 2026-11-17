# ml/app.py
# Fraud scoring service (versions 1 to 3).
#
# Version 3 adds a closed feedback loop:
#   - the champion model scores every transaction, as before
#   - a challenger model, retrained from PaySim plus the decisions analysts
#     made on live payments, scores the same transactions in shadow: its
#     score is recorded but never acted on
#   - administrators compare the two and promote the challenger, or roll
#     back to an earlier champion
#   - drift: live feature values are compared with the training data
#
# The model endpoints under /models need the X-ML-Admin-Token header to
# match ML_ADMIN_TOKEN. If ML_ADMIN_TOKEN is not set they only accept
# requests from this computer.

import os
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Literal, Optional

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from .features import load_type_mapping, build_features
from . import training


# --------------------------------------------------
# 1. Locate the models and type-mapping file
# --------------------------------------------------

# app.py is inside the nested ml folder; data lives in its parent.
ML_DIR = Path(__file__).resolve().parents[1]
MODEL_DIR = Path(os.environ.get("MODEL_DIR", ML_DIR))
CHAMPION_PATH = MODEL_DIR / "fraud_model.pkl"
CHALLENGER_PATH = MODEL_DIR / "fraud_model_challenger.pkl"
ARCHIVE_DIR = MODEL_DIR / "model_archive"
MAPPING_PATH = ML_DIR / "data" / "paysim_processed.type_mapping.json"

if not CHAMPION_PATH.exists():
    raise FileNotFoundError(f"Fraud model not found: {CHAMPION_PATH}. Run python train_model.py first.")
if not MAPPING_PATH.exists():
    raise FileNotFoundError(f"Type mapping not found: {MAPPING_PATH}")

type_mapping = load_type_mapping(MAPPING_PATH)
lock = threading.RLock()


# --------------------------------------------------
# 2. Load model bundles
# --------------------------------------------------

def load_bundle(path):
    bundle = joblib.load(path)
    # Older bundles call this key "model_type" and carry no version.
    bundle["type"] = bundle.get("type") or bundle.get("model_type")
    if bundle["type"] not in ("random_forest", "isolation_forest"):
        raise ValueError(f"Unsupported model type: {bundle['type']}")
    bundle.setdefault("version", training.file_version(path))
    bundle["threshold"] = float(bundle["threshold"])
    if bundle["type"] == "random_forest":
        bundle["fraud_index"] = list(bundle["model"].classes_).index(1)
    # Scoring is one payment at a time: spreading 200 trees over worker
    # processes costs more than it saves (about 39 ms against 13 ms a call).
    if hasattr(bundle["model"], "n_jobs"):
        bundle["model"].n_jobs = 1
    return bundle


champion = load_bundle(CHAMPION_PATH)
challenger = load_bundle(CHALLENGER_PATH) if CHALLENGER_PATH.exists() else None

# Kept for code that reads these names (version 1 and 2).
model = champion["model"]
feature_order = champion["features"]
model_type = champion["type"]
threshold = champion["threshold"]


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


def score_with(bundle, values, explain):
    X = pd.DataFrame([values], columns=bundle["features"])
    if bundle["type"] == "random_forest":
        fraud_score = float(bundle["model"].predict_proba(X)[0][bundle["fraud_index"]])
        if not explain:
            return fraud_score, None, []
        base_value, effects = explain_random_forest(bundle["model"], values, bundle["fraud_index"])
        contributions = sorted(
            (
                {"feature": name, "value": float(value), "contribution": round(float(effect), 6)}
                for name, value, effect in zip(bundle["features"], values, effects)
            ),
            key=lambda item: abs(item["contribution"]),
            reverse=True,
        )
        return fraud_score, round(float(base_value), 6), contributions
    # Isolation Forest: higher means more anomalous, not a probability.
    return float(-bundle["model"].score_samples(X)[0]), None, []


# --------------------------------------------------
# 3. Create the FastAPI application
# --------------------------------------------------

app = FastAPI(
    title="Wallet Fraud Detection API",
    description="Machine-learning service for wallet transaction fraud detection.",
    version="3.0.0",
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


class Example(Txn):
    label: Literal[0, 1]


class RetrainRequest(BaseModel):
    examples: List[Example] = Field(default_factory=list)
    live_weight: float = Field(default=20.0, ge=1, le=200)


class DriftRequest(BaseModel):
    rows: List[dict]


# --------------------------------------------------
# 5. Health-check endpoint
# --------------------------------------------------

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": champion["type"],
        "threshold": champion["threshold"],
        "feature_count": len(champion["features"]),
        "version": champion["version"],
        "challenger": challenger["version"] if challenger else None,
    }


# --------------------------------------------------
# 6. Fraud-scoring endpoint
# --------------------------------------------------

@app.post("/score")
def score(t: Txn):
    try:
        payload = t.model_dump() if hasattr(t, "model_dump") else t.dict()
        with lock:
            current, shadow_bundle = champion, challenger
        values = build_features(payload, type_mapping, current["features"])
        fraud_score, base_value, contributions = score_with(current, values, explain=True)

        result = {
            "fraud_score": fraud_score,
            "flagged": bool(fraud_score >= current["threshold"]),
            "model": current["type"],
            "model_version": current["version"],
            "threshold": current["threshold"],
            "score_is_probability": current["type"] == "random_forest",
            "base_value": base_value,
            "contributions": contributions,
        }
        # The challenger scores the same transaction in shadow. Its score
        # is returned for comparison only.
        if shadow_bundle is not None:
            shadow_values = build_features(payload, type_mapping, shadow_bundle["features"])
            shadow_score, _, _ = score_with(shadow_bundle, shadow_values, explain=False)
            result["shadow"] = {"fraud_score": shadow_score, "model_version": shadow_bundle["version"]}
        return result

    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# --------------------------------------------------
# 7. Model management (version 3)
# --------------------------------------------------

def require_admin(request: Request, token: Optional[str]):
    expected = os.environ.get("ML_ADMIN_TOKEN")
    if expected:
        if token != expected:
            raise HTTPException(status_code=403, detail="Model management needs a valid X-ML-Admin-Token")
        return
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Set ML_ADMIN_TOKEN to manage models from another computer")


def describe(bundle):
    if bundle is None:
        return None
    return {
        "version": bundle["version"],
        "trained_at": bundle.get("trained_at"),
        "live_examples": bundle.get("live_examples", 0),
        "metrics": bundle.get("metrics"),
        "notes": bundle.get("notes", ""),
        "threshold": bundle["threshold"],
        "has_reference": bool(bundle.get("reference")),
    }


job = {"state": "idle", "started_at": None, "finished_at": None, "error": None, "version": None}


@app.get("/models")
def models(request: Request, x_ml_admin_token: Optional[str] = Header(default=None)):
    require_admin(request, x_ml_admin_token)
    archive = sorted(p.name for p in ARCHIVE_DIR.glob("*.pkl")) if ARCHIVE_DIR.exists() else []
    with lock:
        return {"champion": describe(champion), "challenger": describe(challenger), "archive": archive[-10:], "job": job}


def run_retrain(examples, live_weight):
    global challenger
    try:
        X_train, X_test, y_train, y_test = training.load_split()
        X_live, y_live = training.examples_to_frame([e for e in examples], type_mapping)

        # Hold back 30% of the live labels to compare the two models on
        # real wallet decisions, if there are enough of each class.
        X_live_hold = y_live_hold = None
        positives, negatives = int(y_live.sum()), int((y_live == 0).sum())
        if positives >= 5 and negatives >= 5:
            from sklearn.model_selection import train_test_split
            X_live, X_live_hold, y_live, y_live_hold = train_test_split(
                X_live, y_live, test_size=0.3, random_state=42, stratify=y_live)

        X_all = pd.concat([X_train, X_live], ignore_index=True)
        y_all = pd.concat([y_train, y_live], ignore_index=True)
        weights = np.concatenate([np.ones(len(X_train)), np.full(len(X_live), live_weight)])
        new_model = training.train(X_all, y_all, sample_weight=weights)

        X_real, y_real = training.make_realistic_test(X_test, y_test)
        version = training.version_tag(len(examples))
        metrics = {"paysim_realistic": training.evaluate(new_model, X_real, y_real)}
        with lock:
            current = champion
        comparison = {"paysim_realistic": training.evaluate(current["model"], X_real, y_real)} if current["type"] == "random_forest" else {}
        if X_live_hold is not None:
            metrics["live_holdout"] = training.evaluate(new_model, X_live_hold, y_live_hold)
            if current["type"] == "random_forest":
                comparison["live_holdout"] = training.evaluate(current["model"], X_live_hold, y_live_hold)
        notes = (f"PaySim plus {len(examples)} labelled live payments ({positives} fraud, {negatives} legitimate), "
                 f"live examples weighted x{live_weight:g}")
        if X_live_hold is None:
            notes += ". Too few labels in each class to hold some back, so the models are compared on PaySim only."

        bundle = training.build_bundle(new_model, version=version, metrics=metrics,
                                       ref=training.reference(X_train), n_live=len(examples), notes=notes)
        bundle["champion_comparison"] = {"version": current["version"], "metrics": comparison}
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        joblib.dump(bundle, CHALLENGER_PATH)
        loaded = load_bundle(CHALLENGER_PATH)
        loaded["champion_comparison"] = bundle["champion_comparison"]
        with lock:
            challenger = loaded
        job.update(state="done", finished_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), version=version, error=None)
    except Exception as exc:  # reported through /models
        job.update(state="failed", finished_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), error=str(exc))


@app.post("/models/retrain", status_code=202)
def retrain(body: RetrainRequest, request: Request, x_ml_admin_token: Optional[str] = Header(default=None)):
    require_admin(request, x_ml_admin_token)
    if job["state"] == "running":
        raise HTTPException(status_code=409, detail="A retraining job is already running")
    examples = [e.model_dump() if hasattr(e, "model_dump") else e.dict() for e in body.examples]
    job.update(state="running", started_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
               finished_at=None, error=None, version=None)
    threading.Thread(target=run_retrain, args=(examples, body.live_weight), daemon=True).start()
    return {"state": "running", "examples": len(examples)}


@app.get("/models/challenger/comparison")
def challenger_comparison(request: Request, x_ml_admin_token: Optional[str] = Header(default=None)):
    require_admin(request, x_ml_admin_token)
    with lock:
        if challenger is None:
            raise HTTPException(status_code=404, detail="There is no challenger model")
        return {"challenger": describe(challenger), "champion": challenger.get("champion_comparison")}


@app.post("/models/promote")
def promote(request: Request, x_ml_admin_token: Optional[str] = Header(default=None)):
    global champion, challenger, model, feature_order, model_type, threshold
    require_admin(request, x_ml_admin_token)
    with lock:
        if challenger is None:
            raise HTTPException(status_code=404, detail="There is no challenger to promote")
        ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        archived = ARCHIVE_DIR / f"{champion['version']}.pkl"
        shutil.copy2(CHAMPION_PATH, archived)
        shutil.move(str(CHALLENGER_PATH), str(CHAMPION_PATH))
        previous = champion["version"]
        champion, challenger = load_bundle(CHAMPION_PATH), None
        model, feature_order, model_type, threshold = champion["model"], champion["features"], champion["type"], champion["threshold"]
        return {"champion": champion["version"], "previous": previous, "archived_as": archived.name}


@app.post("/models/rollback")
def rollback(request: Request, x_ml_admin_token: Optional[str] = Header(default=None)):
    global champion, model, feature_order, model_type, threshold
    require_admin(request, x_ml_admin_token)
    with lock:
        if not ARCHIVE_DIR.exists() or not any(ARCHIVE_DIR.glob("*.pkl")):
            raise HTTPException(status_code=404, detail="There is no earlier model to go back to")
        latest = max(ARCHIVE_DIR.glob("*.pkl"), key=lambda p: p.stat().st_mtime)
        current = champion["version"]
        shutil.copy2(CHAMPION_PATH, ARCHIVE_DIR / f"{current}.rolled-back.pkl.bak")
        shutil.move(str(latest), str(CHAMPION_PATH))
        champion = load_bundle(CHAMPION_PATH)
        model, feature_order, model_type, threshold = champion["model"], champion["features"], champion["type"], champion["threshold"]
        return {"champion": champion["version"], "replaced": current}


@app.delete("/models/challenger")
def discard(request: Request, x_ml_admin_token: Optional[str] = Header(default=None)):
    global challenger
    require_admin(request, x_ml_admin_token)
    with lock:
        if challenger is None:
            raise HTTPException(status_code=404, detail="There is no challenger model")
        version = challenger["version"]
        CHALLENGER_PATH.unlink(missing_ok=True)
        challenger = None
        return {"discarded": version}


@app.post("/models/drift")
def drift(body: DriftRequest, request: Request, x_ml_admin_token: Optional[str] = Header(default=None)):
    require_admin(request, x_ml_admin_token)
    with lock:
        ref = champion.get("reference")
        version = champion["version"]
    if not ref:
        raise HTTPException(status_code=409, detail="This model has no training reference. Retrain it with train_model.py.")
    result = training.psi(ref, body.rows)
    result["version"] = version
    return result
