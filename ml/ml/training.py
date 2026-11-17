# ml/training.py
# Training, evaluation and drift measurement shared by train_model.py and
# the retraining endpoint of the scoring service (version 3).
#
# Training uses the same data, split, parameters and seed as
# model_comparison.ipynb. Evaluation uses the notebook's "realistic" test
# set, about 1% fraud, so figures can be compared with the project report.

import hashlib
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    average_precision_score, confusion_matrix, f1_score, precision_score, recall_score,
)
from sklearn.model_selection import train_test_split

from .features import build_features

ML_DIR = Path(__file__).resolve().parents[1]
DATA = ML_DIR / "data" / "paysim_processed.csv"
FEATURES = [
    "amount", "oldbalanceOrg", "newbalanceOrig", "oldbalanceDest",
    "newbalanceDest", "type_encoded", "balance_discrepancy",
]
LABEL = "isFraud"
THRESHOLD = 0.5
RF_PARAMS = dict(n_estimators=200, max_depth=12, class_weight="balanced", random_state=42, n_jobs=-1)


def load_split():
    df = pd.read_csv(DATA)
    X, y = df[FEATURES], df[LABEL]
    return train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)


def make_realistic_test(X_test, y_test, fraud_rate=0.01, seed=42):
    """The notebook's test set: every legitimate transaction plus enough
    fraud cases for about 1% prevalence."""
    legit_idx = y_test[y_test == 0].index
    fraud_idx_all = y_test[y_test == 1].index
    n_fraud = max(1, int(len(legit_idx) * fraud_rate / (1 - fraud_rate)))
    fraud_idx = y_test.loc[fraud_idx_all].sample(n=min(n_fraud, len(fraud_idx_all)), random_state=seed).index
    selected = legit_idx.union(fraud_idx)
    return X_test.loc[selected], y_test.loc[selected]


def train(X, y, sample_weight=None):
    model = RandomForestClassifier(**RF_PARAMS)
    model.fit(X, y, sample_weight=sample_weight)
    return model


def evaluate(model, X, y, threshold=THRESHOLD):
    if len(X) == 0:
        return None
    fraud_index = list(model.classes_).index(1)
    scores = model.predict_proba(X)[:, fraud_index]
    predicted = (scores >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, predicted, labels=[0, 1]).ravel()
    both = len(set(int(v) for v in y)) == 2
    return {
        "n": int(len(y)),
        "fraud": int(int(np.sum(y))),
        "precision": round(float(precision_score(y, predicted, zero_division=0)), 4),
        "recall": round(float(recall_score(y, predicted, zero_division=0)), 4),
        "f1": round(float(f1_score(y, predicted, zero_division=0)), 4),
        "pr_auc": round(float(average_precision_score(y, scores)), 4) if both else None,
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def reference(X):
    """What each feature looked like in training, for drift checks.
    Features with few distinct values are stored as categories; the rest
    as ten quantile bins."""
    ref = {}
    for name in X.columns:
        col = X[name].to_numpy(dtype=float)
        values = np.unique(col)
        if len(values) <= 10:
            ref[name] = {
                "kind": "categorical",
                "values": [float(v) for v in values],
                "expected": [float(np.mean(col == v)) for v in values],
            }
            continue
        # Features that are often exactly zero (an emptied balance, for
        # example) get a bin of their own; the rest are split into deciles
        # of the non-zero values, so the bins do not collapse.
        zero_share = float(np.mean(col == 0))
        values_for_edges = col[col != 0] if zero_share > 0.2 else col
        edges = np.unique(np.quantile(values_for_edges, np.linspace(0, 1, 11)))
        if zero_share > 0.2:
            nonzero = col[col != 0]
            counts = np.bincount(bin_index(nonzero, edges), minlength=max(len(edges) - 1, 1))
            ref[name] = {
                "kind": "zero_binned",
                "edges": [float(e) for e in edges],
                "expected": [zero_share] + [float(c) / len(col) for c in counts],
            }
            continue
        counts = np.bincount(bin_index(col, edges), minlength=len(edges) - 1)
        ref[name] = {
            "kind": "binned",
            "edges": [float(e) for e in edges],
            "expected": [float(c) / len(col) for c in counts],
        }
    return ref


def bin_index(values, edges):
    # Interior edges decide the bin; values outside the training range go
    # into the first or last bin.
    interior = np.asarray(edges[1:-1])
    return np.searchsorted(interior, values, side="right")


def psi(ref, rows):
    """Population stability index of live feature values against training.
    A common rule of thumb: below 0.1 stable, 0.1 to 0.25 a moderate shift,
    above 0.25 a major shift."""
    out = {}
    eps = 1e-4
    for name, spec in ref.items():
        live = np.array([float(r[name]) for r in rows if r.get(name) is not None and math.isfinite(float(r[name]))])
        if len(live) == 0:
            continue
        if spec["kind"] == "categorical":
            actual = [float(np.mean(live == v)) for v in spec["values"]]
            other = 1.0 - sum(actual)
            expected = list(spec["expected"])
            if other > eps:
                actual.append(other)
                expected.append(0.0)
        elif spec["kind"] == "zero_binned":
            nonzero = live[live != 0]
            counts = np.bincount(bin_index(nonzero, spec["edges"]), minlength=len(spec["expected"]) - 1)
            actual = [float(np.mean(live == 0))] + [float(c) / len(live) for c in counts]
            expected = list(spec["expected"])
        else:
            counts = np.bincount(bin_index(live, spec["edges"]), minlength=len(spec["expected"]))
            actual = [float(c) / len(live) for c in counts]
            expected = list(spec["expected"])
        value = sum((max(a, eps) - max(e, eps)) * math.log(max(a, eps) / max(e, eps)) for a, e in zip(actual, expected))
        out[name] = {
            "psi": round(value, 4),
            "status": "stable" if value < 0.1 else "moderate" if value < 0.25 else "major",
            "expected": [round(e, 4) for e in expected],
            "actual": [round(a, 4) for a in actual],
            "edges": spec.get("edges"),
            "values": spec.get("values"),
        }
    return {"n": len(rows), "features": out}


def examples_to_frame(examples, type_mapping):
    """Live labelled payments sent by the website: transaction fields plus
    a label (1 fraud, 0 legitimate)."""
    rows, labels = [], []
    for ex in examples:
        try:
            rows.append(build_features(ex, type_mapping, FEATURES))
            labels.append(1 if int(ex["label"]) == 1 else 0)
        except (ValueError, KeyError, TypeError):
            continue
    return pd.DataFrame(rows, columns=FEATURES), pd.Series(labels, dtype=int)


def version_tag(n_live):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"rf-{stamp}-{n_live}live"


def file_version(path):
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()[:8]
    return f"rf-{digest}"


def build_bundle(model, *, version, metrics, ref, n_live, notes=""):
    return {
        "model": model,
        "features": FEATURES,
        "type": "random_forest",
        "model_type": "random_forest",
        "threshold": THRESHOLD,
        "version": version,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "metrics": metrics,
        "reference": ref,
        "live_examples": n_live,
        "notes": notes,
    }
