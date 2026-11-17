"""Trains the fraud model and saves it as fraud_model.pkl.

This is the model comparison notebook's Random Forest, with the same data,
split, parameters and random seed, as a script. It exists so the model can
be built without opening the notebook: in Docker, in the automated tests
on GitHub, and on a fresh clone.

Version 3: the saved bundle also carries a version name, its evaluation on
the notebook's realistic test set (about 1% fraud) and a description of
the training data that the scoring service uses to measure drift.

Run from the ml folder:
    python train_model.py

The model is written to MODEL_DIR if that is set, otherwise to this folder.
"""
import os
from pathlib import Path

import joblib

from ml.training import (
    build_bundle, evaluate, load_split, make_realistic_test, reference, train, version_tag,
)

ML_DIR = Path(__file__).resolve().parent
MODEL = Path(os.environ.get("MODEL_DIR", ML_DIR)) / "fraud_model.pkl"


def main():
    X_train, X_test, y_train, y_test = load_split()
    model = train(X_train, y_train)

    X_real, y_real = make_realistic_test(X_test, y_test)
    split = evaluate(model, X_test, y_test)
    realistic = evaluate(model, X_real, y_real)
    print(f"Trained on {len(X_train):,} records")
    print(f"Held-out split ({split['n']:,} records, about one in six fraud): "
          f"precision {split['precision']:.4f}, recall {split['recall']:.4f}, F1 {split['f1']:.4f}")
    print(f"Realistic test set ({realistic['n']:,} records, about 1% fraud): "
          f"precision {realistic['precision']:.4f}, recall {realistic['recall']:.4f}, F1 {realistic['f1']:.4f}")

    MODEL.parent.mkdir(parents=True, exist_ok=True)
    bundle = build_bundle(
        model,
        version=version_tag(0),
        metrics={"paysim_realistic": realistic, "paysim_split": split},
        ref=reference(X_train),
        n_live=0,
        notes="Trained on PaySim only (train_model.py)",
    )
    joblib.dump(bundle, MODEL)
    print(f"Model {bundle['version']} saved to: {MODEL}")


if __name__ == "__main__":
    main()
