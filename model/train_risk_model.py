"""
Trains a GradientBoostingRegressor on the continuous structural-risk score (0-1)
— not the at_risk yes/no label, which made predictions collapse to 0% or 100% —
used to ADD an advisory risk score alongside (not replacing) the
deterministic overhang check in backend/services/structural_inspector.py.

Usage:
    python train_risk_model.py --data data/synthetic_dataset.csv
"""
import argparse
import json
import os
from datetime import datetime, timezone

import joblib
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split

from features import FEATURE_NAMES_RISK

_HERE = os.path.dirname(__file__)


def main(data_path: str, out_dir: str):
    df = pd.read_csv(data_path)
    feature_cols = [f"risk__{name}" for name in FEATURE_NAMES_RISK]
    X = df[feature_cols]
    y = df["risk_score"]

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    model = GradientBoostingRegressor(n_estimators=200, max_depth=3, learning_rate=0.05, random_state=42)
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    mae = mean_absolute_error(y_test, preds)
    r2 = r2_score(y_test, preds)

    print(f"MAE: {mae:.4f}")
    print(f"R2:  {r2:.3f}")

    importances = sorted(zip(FEATURE_NAMES_RISK, model.feature_importances_), key=lambda t: -t[1])
    print("\nTop features:")
    for name, imp in importances:
        print(f"  {name:28s} {imp:.3f}")

    os.makedirs(out_dir, exist_ok=True)
    model_path = os.path.join(out_dir, "risk_model.joblib")
    joblib.dump(model, model_path)

    meta = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_samples": len(df),
        "target": "risk_score (continuous 0-1)",
        "mae": mae,
        "r2": r2,
        "feature_names": FEATURE_NAMES_RISK,
        "top_features": [{"name": n, "importance": float(i)} for n, i in importances],
    }
    with open(os.path.join(out_dir, "risk_model.meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(f"\nSaved model to {model_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=str, default=os.path.join(_HERE, "data", "synthetic_dataset.csv"))
    parser.add_argument("--out", type=str, default=os.path.join(_HERE, "models"))
    args = parser.parse_args()
    main(args.data, args.out)
