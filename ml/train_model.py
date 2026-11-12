"""Trains the fraud model and saves it as ml/fraud_model.pkl.

This is the model comparison notebook's Random Forest, with the same data,
split, parameters and random seed, as a script. It exists so the model can
be built without opening the notebook: in Docker, in the automated tests
on GitHub, and on a fresh clone.

Run from the ml folder:
    python train_model.py
"""
from pathlib import Path

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import f1_score, precision_score, recall_score
from sklearn.model_selection import train_test_split

ML_DIR = Path(__file__).resolve().parent
DATA = ML_DIR / "data" / "paysim_processed.csv"
MODEL = ML_DIR / "fraud_model.pkl"
FEATURES = [
    "amount", "oldbalanceOrg", "newbalanceOrig", "oldbalanceDest",
    "newbalanceDest", "type_encoded", "balance_discrepancy",
]
THRESHOLD = 0.5


def main():
    df = pd.read_csv(DATA)
    X, y = df[FEATURES], df["isFraud"]
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    model = RandomForestClassifier(
        n_estimators=200, max_depth=12, class_weight="balanced",
        random_state=42, n_jobs=-1,
    )
    model.fit(X_train, y_train)

    predicted = model.predict(X_test)
    print(f"Trained on {len(X_train):,} records, tested on {len(X_test):,}")
    # A quick check that training worked. This test split has about one
    # fraud in six, so these figures are higher than the ones reported for
    # the realistic 1% fraud test set built in model_comparison.ipynb.
    print("Check on the held-out split (not the 1% fraud evaluation): "
          f"precision {precision_score(y_test, predicted):.4f}, "
          f"recall {recall_score(y_test, predicted):.4f}, "
          f"F1 {f1_score(y_test, predicted):.4f}")

    joblib.dump({
        "model": model,
        "features": FEATURES,
        "type": "random_forest",
        "model_type": "random_forest",
        "threshold": THRESHOLD,
    }, MODEL)
    print(f"Model saved to: {MODEL}")


if __name__ == "__main__":
    main()
