"""Feature consistency check (Sprint 5).

Confirms that ml/ml/features.py, which the scoring API uses for live
transactions, rebuilds exactly the seven features stored in the processed
training data. A mismatch would mean the model sees different inputs in
production than it saw in training.

Run from the ml folder:
    python -m tests.test_features
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

from ml.features import build_features, load_type_mapping

ML_DIR = Path(__file__).resolve().parents[1]
DATA = ML_DIR / "data" / "paysim_processed.csv"
MAPPING = ML_DIR / "data" / "paysim_processed.type_mapping.json"
FEATURES = [
    "amount", "oldbalanceOrg", "newbalanceOrig", "oldbalanceDest",
    "newbalanceDest", "type_encoded", "balance_discrepancy",
]
SAMPLE_SIZE = 200


def main():
    df = pd.read_csv(DATA)
    mapping = load_type_mapping(MAPPING)
    sample = df.sample(SAMPLE_SIZE, random_state=1)

    mismatches = []
    for index, row in sample.iterrows():
        txn = {key: row[key] for key in
               ["type", "amount", "oldbalanceOrg", "newbalanceOrig", "oldbalanceDest", "newbalanceDest"]}
        rebuilt = np.array(build_features(txn, mapping, FEATURES), dtype=float)
        stored = row[FEATURES].to_numpy(dtype=float)
        if not np.allclose(rebuilt, stored, rtol=1e-9, atol=1e-6):
            mismatches.append({"row": int(index), "stored": stored.tolist(), "rebuilt": rebuilt.tolist()})

    print(f"Type mapping: {json.dumps(mapping)}")
    print(f"Features checked: {', '.join(FEATURES)}")
    print(f"Checked {SAMPLE_SIZE} records: {len(mismatches)} mismatches")
    for m in mismatches[:3]:
        print("  Mismatch:", m)

    out = ML_DIR.parent / "tests" / "results"
    out.mkdir(parents=True, exist_ok=True)
    (out / "feature-check.txt").write_text(
        f"Feature consistency check\nRecords checked: {SAMPLE_SIZE}\nMismatches: {len(mismatches)}\n"
        f"Result: {'Pass' if not mismatches else 'Fail'}\n"
    )
    return 0 if not mismatches else 1


if __name__ == "__main__":
    raise SystemExit(main())
