# ml/validate_external.py
# Validation beyond the 80/20 split (version 3).
#
# The model is trained on a sample of PaySim: all 8,213 fraud cases among
# TRANSFER and CASH_OUT payments and 41,065 legitimate ones. The rest of
# PaySim, about 2.7 million legitimate TRANSFER and CASH_OUT payments, was
# never used. This script uses it for three further checks:
#
#   1. Unseen legitimate payments. The current model scores every
#      legitimate payment that was not in the training sample. This gives
#      the false-alarm rate on millions of payments instead of thousands,
#      and, with the recall on the held-out fraud, the precision to expect
#      at PaySim's real fraud rate (about 0.3%) rather than the 1% test set.
#
#   2. Temporal split. A fresh model with the same settings is trained only
#      on payments from the first 80% of the simulated month and tested on
#      every payment after that, at the real fraud rate. A random split lets
#      the model see the future; this does not.
#
#   3. Another dataset (optional). Any log in PaySim's column format, for
#      example a new PaySim run with a different seed, can be scored with
#      the current model unchanged, with --other.
#
# The raw PaySim log is about 470 MB and is not in the repository. Download
# it from Kaggle ("Synthetic Financial Datasets For Fraud Detection",
# file PS_20174392719_1491204439457_log.csv), save it as ml/data/paysim.csv,
# then run from the ml folder:
#
#   python validate_external.py
#   python validate_external.py --raw path\to\paysim.csv --other path\to\other.csv
#
# Results are written to ml/results/validation.json and
# ml/results/validation.md. Expect a few minutes and about 2 GB of memory.

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, confusion_matrix

from ml import training
from ml.features import load_type_mapping

ML_DIR = Path(__file__).resolve().parent
RAW_COLUMNS = ["step", "type", "amount", "oldbalanceOrg", "newbalanceOrig",
               "oldbalanceDest", "newbalanceDest", "isFraud"]
MATCH = ["type", "amount", "oldbalanceOrg", "newbalanceOrig", "oldbalanceDest", "newbalanceDest", "isFraud"]


def features_of(df, mapping):
    """The model's features, computed exactly as ml/features.py does."""
    out = pd.DataFrame(index=df.index)
    for name in ["amount", "oldbalanceOrg", "newbalanceOrig", "oldbalanceDest", "newbalanceDest"]:
        out[name] = df[name].astype(float)
    out["type_encoded"] = df["type"].map(mapping).astype(float)
    out["balance_discrepancy"] = df["oldbalanceOrg"] - df["amount"] - df["newbalanceOrig"]
    return out[training.FEATURES]


def load_raw(path, mapping):
    print(f"Reading {path} …")
    df = pd.read_csv(path, usecols=RAW_COLUMNS)
    df = df[df["type"].isin(list(mapping))].reset_index(drop=True)
    print(f"  {len(df):,} TRANSFER and CASH_OUT payments, {int(df['isFraud'].sum()):,} of them fraud")
    return df


def scores_of(model, X, batch=200_000):
    index = list(model.classes_).index(1)
    out = np.empty(len(X))
    for start in range(0, len(X), batch):
        out[start:start + batch] = model.predict_proba(X.iloc[start:start + batch])[:, index]
    return out


def summary(y, scores, threshold):
    y = np.asarray(y).astype(int)
    predicted = (scores >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, predicted, labels=[0, 1]).ravel()
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return {
        "n": int(len(y)),
        "fraud": int(y.sum()),
        "fraud_rate": round(float(y.mean()), 5) if len(y) else None,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(2 * precision * recall / (precision + recall), 4) if precision + recall else 0.0,
        "false_alarm_rate": round(fp / (fp + tn), 6) if fp + tn else None,
        "pr_auc": round(float(average_precision_score(y, scores)), 4) if 0 < y.sum() < len(y) else None,
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def key_of(df):
    """A key for matching a raw row to a row of the training sample."""
    rounded = df[MATCH].copy()
    for name in MATCH[1:-1]:
        rounded[name] = rounded[name].round(2)
    return pd.util.hash_pandas_object(rounded, index=False)


def check_unseen(raw, bundle, mapping):
    """Check 1: the current model on every payment it was not trained on."""
    model, threshold = bundle["model"], float(bundle["threshold"])
    processed = pd.read_csv(training.DATA)
    X_train, X_test, y_train, y_test = training.load_split()
    in_sample = set(key_of(processed))

    raw_keys = key_of(raw)
    unseen_legit = raw[(raw["isFraud"] == 0) & ~raw_keys.isin(in_sample)]
    print(f"  {len(unseen_legit):,} legitimate payments were never in the training sample")

    legit_scores = scores_of(model, features_of(unseen_legit, mapping))
    false_alarms = int((legit_scores >= threshold).sum())
    fpr = false_alarms / len(unseen_legit) if len(unseen_legit) else 0.0

    fraud_test = X_test[y_test == 1]
    fraud_scores = scores_of(model, fraud_test)
    recall = float((fraud_scores >= threshold).mean()) if len(fraud_test) else 0.0

    prevalence = float(raw["isFraud"].mean())
    tp_rate = recall * prevalence
    fp_rate = fpr * (1 - prevalence)
    precision = tp_rate / (tp_rate + fp_rate) if tp_rate + fp_rate else 0.0

    # The same figures as one test set: the held-out fraud plus every
    # unseen legitimate payment (a fraud rate far below the real one,
    # because only a fifth of the fraud cases are held out).
    combined_y = np.concatenate([np.zeros(len(legit_scores)), np.ones(len(fraud_scores))])
    combined_scores = np.concatenate([legit_scores, fraud_scores])

    return {
        "unseen_legitimate": int(len(unseen_legit)),
        "false_alarms": false_alarms,
        "false_alarm_rate": round(fpr, 6),
        "held_out_fraud": int(len(fraud_test)),
        "recall_on_held_out_fraud": round(recall, 4),
        "paysim_fraud_rate": round(prevalence, 5),
        "expected_precision_at_paysim_rate": round(precision, 4),
        "expected_f1_at_paysim_rate": round(2 * precision * recall / (precision + recall), 4) if precision + recall else 0.0,
        "held_out_fraud_plus_unseen_legitimate": summary(combined_y, combined_scores, threshold),
    }


def check_temporal(raw, mapping, cut_share=0.8):
    """Check 2: train on the earlier payments, test on the later ones."""
    steps = np.sort(raw["step"].to_numpy())
    cut = int(steps[int(len(steps) * cut_share)])
    early, late = raw[raw["step"] < cut], raw[raw["step"] >= cut]
    print(f"  training on hours 1 to {cut - 1} ({len(early):,} payments), testing on hours {cut} to {int(steps[-1])} ({len(late):,})")

    # The same kind of sample the original model was trained on: every
    # fraud case and five legitimate payments for each.
    fraud = early[early["isFraud"] == 1]
    legit_pool = early[early["isFraud"] == 0]
    legit = legit_pool.sample(n=min(len(legit_pool), 5 * len(fraud)), random_state=42)
    sample = pd.concat([fraud, legit]).sample(frac=1, random_state=42)
    model = training.train(features_of(sample, mapping), sample["isFraud"].astype(int))

    X_late = features_of(late, mapping)
    y_late = late["isFraud"].astype(int).to_numpy()
    s_late = scores_of(model, X_late)
    full = summary(y_late, s_late, training.THRESHOLD)

    # The later payments resampled to 1% fraud, to compare with the report.
    late_y = pd.Series(y_late, index=late.index)
    X_real, y_real = training.make_realistic_test(X_late, late_y)
    realistic = summary(y_real.to_numpy(), scores_of(model, X_real), training.THRESHOLD)
    return {
        "cut_step": cut,
        "train": {"payments_in_window": int(len(early)), "fraud": int(len(fraud)), "legitimate_sampled": int(len(legit))},
        "test_all_later_payments": full,
        "test_later_payments_at_1_percent": realistic,
    }


def check_other(path, bundle, mapping):
    """Check 3: the current model, unchanged, on another PaySim-format log."""
    other = load_raw(path, mapping)
    scores = scores_of(bundle["model"], features_of(other, mapping))
    return {"file": os.path.basename(path), **summary(other["isFraud"].to_numpy(), scores, float(bundle["threshold"]))}


def pct(x):
    return "n/a" if x is None else f"{100 * x:.2f}%"


def write_markdown(result, path):
    u, t = result["unseen"], result["temporal"]
    lines = [
        "# SecureWallet model validation beyond the 80/20 split",
        "",
        f"{result['run_at']} · model {result['model_version']} · threshold {result['threshold']}",
        "",
        "## 1. Every legitimate payment the model never saw",
        "",
        f"The model scored {u['unseen_legitimate']:,} legitimate TRANSFER and CASH_OUT payments from PaySim that were not in its training sample "
        f"and raised {u['false_alarms']:,} false alarms, a false-alarm rate of {pct(u['false_alarm_rate'])}. "
        f"On the {u['held_out_fraud']:,} held-out fraud cases its recall was {pct(u['recall_on_held_out_fraud'])}. "
        f"At PaySim's real fraud rate of {pct(u['paysim_fraud_rate'])}, that recall and false-alarm rate give an expected precision of "
        f"{pct(u['expected_precision_at_paysim_rate'])} and F1 of {u['expected_f1_at_paysim_rate']}.",
        "",
        "## 2. Trained on the past, tested on the future",
        "",
        f"A new model with the same settings was trained on payments before hour {t['cut_step']} "
        f"({t['train']['fraud']:,} fraud cases and {t['train']['legitimate_sampled']:,} sampled legitimate payments) and tested on every later payment.",
        "",
        "| Test set | Payments | Fraud rate | Precision | Recall | F1 | PR-AUC | False alarms |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for label, s in [("All later payments", t["test_all_later_payments"]), ("Later payments at 1% fraud", t["test_later_payments_at_1_percent"])]:
        lines.append(f"| {label} | {s['n']:,} | {pct(s['fraud_rate'])} | {s['precision']} | {s['recall']} | {s['f1']} | {s['pr_auc']} | {s['confusion']['fp']:,} |")
    if result.get("other"):
        o = result["other"]
        lines += ["", "## 3. Another dataset", "",
                  f"The current model, unchanged, on {o['file']}: {o['n']:,} payments, fraud rate {pct(o['fraud_rate'])}, "
                  f"precision {o['precision']}, recall {o['recall']}, F1 {o['f1']}, PR-AUC {o['pr_auc']}, false-alarm rate {pct(o['false_alarm_rate'])}."]
    lines += ["", "The full figures, including confusion matrices, are in validation.json."]
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Validate the fraud model beyond the 80/20 split.")
    parser.add_argument("--raw", default=str(ML_DIR / "data" / "paysim.csv"), help="the raw PaySim log")
    parser.add_argument("--model", default=str(Path(os.environ.get("MODEL_DIR", ML_DIR)) / "fraud_model.pkl"),
                        help="model bundle to validate (default: the current champion)")
    parser.add_argument("--other", help="another log in PaySim's column format")
    parser.add_argument("--out", default=str(ML_DIR / "results"))
    args = parser.parse_args()

    if not Path(args.raw).exists():
        raise SystemExit(f"{args.raw} not found. Download the PaySim log from Kaggle and save it there, or pass --raw.")
    model_path = Path(args.model) if args.model and Path(args.model).exists() else ML_DIR / "fraud_model.pkl"
    bundle = joblib.load(model_path)
    mapping = load_type_mapping()
    raw = load_raw(args.raw, mapping)

    print("1. Scoring every legitimate payment the model never saw …")
    unseen = check_unseen(raw, bundle, mapping)
    print("2. Temporal split …")
    temporal = check_temporal(raw, mapping)
    other = None
    if args.other:
        print("3. Another dataset …")
        other = check_other(args.other, bundle, mapping)

    result = {
        "run_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "model": model_path.name,
        "model_version": bundle.get("version") or training.file_version(model_path),
        "threshold": float(bundle["threshold"]),
        "unseen": unseen,
        "temporal": temporal,
        "other": other,
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "validation.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    write_markdown(result, out / "validation.md")
    print((out / "validation.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
