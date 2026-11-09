# ml/features.py
# Builds transaction features in the same format used during training.

import json
import math
from pathlib import Path


def load_type_mapping(path=None):
    """Load the transaction-type encoding used during training."""

    if path is None:
        path = (
            Path(__file__).resolve().parent.parent
            / "data"
            / "paysim_processed.type_mapping.json"
        )
    else:
        path = Path(path)

    with open(path, "r", encoding="utf-8") as file:
        mapping = json.load(file)

    if not isinstance(mapping, dict):
        raise ValueError("Transaction-type mapping must be a JSON object.")

    return mapping


def build_features(txn: dict, type_mapping: dict, feature_order: list) -> list:
    """
    Convert a transaction dictionary into the exact feature order
    expected by the trained Random Forest model.
    """

    required_fields = [
        "type",
        "amount",
        "oldbalanceOrg",
        "newbalanceOrig",
        "oldbalanceDest",
        "newbalanceDest",
    ]

    missing = [field for field in required_fields if field not in txn]

    if missing:
        raise ValueError(f"Missing transaction fields: {missing}")

    transaction_type = str(txn["type"]).strip().upper()

    if transaction_type not in type_mapping:
        raise ValueError(
            f"Unsupported transaction type: {transaction_type}"
        )

    # Convert numeric values and reject invalid numbers.
    amount = float(txn["amount"])
    oldbalance_org = float(txn["oldbalanceOrg"])
    newbalance_orig = float(txn["newbalanceOrig"])
    oldbalance_dest = float(txn["oldbalanceDest"])
    newbalance_dest = float(txn["newbalanceDest"])

    numeric_values = {
        "amount": amount,
        "oldbalanceOrg": oldbalance_org,
        "newbalanceOrig": newbalance_orig,
        "oldbalanceDest": oldbalance_dest,
        "newbalanceDest": newbalance_dest,
    }

    for name, value in numeric_values.items():
        if not math.isfinite(value):
            raise ValueError(f"{name} must be a finite number.")

        if value < 0:
            raise ValueError(f"{name} cannot be negative.")

    # These must match the feature calculations used in training.
    feature_values = {
        "amount": amount,
        "oldbalanceOrg": oldbalance_org,
        "newbalanceOrig": newbalance_orig,
        "oldbalanceDest": oldbalance_dest,
        "newbalanceDest": newbalance_dest,
        "type_encoded": float(type_mapping[transaction_type]),
        "balance_discrepancy": (
            oldbalance_org - amount - newbalance_orig
        ),
    }

    # Fail explicitly if the saved model expects unknown features.
    unknown_features = [
        name for name in feature_order
        if name not in feature_values
    ]

    if unknown_features:
        raise ValueError(
            f"Unsupported model features: {unknown_features}"
        )

    # Feature order must come from the saved model bundle.
    return [feature_values[name] for name in feature_order]