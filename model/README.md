# model/

Implements the plan from `IMPLEMENTATION_MODEL.md`: trains two models to
replace/augment the hardcoded formulas in `backend/services/materials_estimator.py`
and `backend/services/structural_inspector.py`.

- **Cost model** (`cost_model.joblib`) — regresses total materials cost from
  building shape + region, replacing the flat-constant formula.
- **Risk model** (`risk_model.joblib`) — outputs an advisory structural-risk
  probability from seismic/soil/wind data. This is **additive** — it never
  replaces the deterministic no-overhang geometry check, which stays
  hardcoded because it's a correctness rule, not a prediction problem.

The risk label is generated with a HAZUS/GEM-style lognormal seismic
fragility function (`seismic_fragility_probability` in `features.py`) —
the standard probabilistic damage-state model used in real seismic risk
assessment — rather than an arbitrary weighted-sum heuristic. The capacity
thresholds are rescaled from the literal FEMA HAZUS table (calibrated to
US design-basis PGAs of 0.3g+) to fit India's IS 1893 zone PGA range
(0.10-0.16g); see the comment above `_FRAGILITY_BY_HEIGHT` for why. Wind
and load-irregularity are added as smaller secondary terms since HAZUS
earthquake fragility alone doesn't cover those.

This folder is standalone (no dependency on the `backend/` package) so it
can be trained independently before wiring the outputs back in. It IS
wired in — see `backend/services/ml_loader.py`.

## Files

| File | Purpose |
|---|---|
| `districts.json` | Seismic/soil/wind/climate data per Karnataka district, mirrored from `frontend/src/data/karnataka_db.ts` |
| `features.py` | Single source of truth for feature order/encoding and the synthetic-label heuristics (`district_cost_multiplier`, `district_risk_prior`) |
| `generate_dataset.py` | Generates synthetic training data — building shapes labeled via the existing cost formula + region multiplier, and risk labeled via the physics-flavored heuristic |
| `train_cost_model.py` | Trains + evaluates + serializes the cost regressor |
| `train_risk_model.py` | Trains + evaluates + serializes the risk classifier |
| `data/` | Generated CSVs (gitignored) |
| `models/` | Serialized `.joblib` models + `.meta.json` metadata (gitignored) |

## Usage

```bash
cd model
pip install -r requirements.txt

python generate_dataset.py --n 8000 --seed 42
python train_cost_model.py
python train_risk_model.py
```

This writes `models/cost_model.joblib`, `models/risk_model.joblib`, and a
`.meta.json` next to each with training metrics and feature importances
(useful for an "/api/model-info" demo endpoint, or just to show judges the
model card live).

## Backend integration

Already wired up — `backend/services/ml_loader.py` adds this folder to
`sys.path`, loads both `.joblib` files once (via `functools.lru_cache`),
and builds feature vectors through the **same** `build_cost_feature_vector`
/ `build_risk_feature_vector` functions in `features.py`, so training and
serving never drift apart. `materials_estimator.py` and
`structural_inspector.py` fall back to their original hardcoded formulas if
the model files are missing, so the app never crashes if training hasn't
been run yet. Check `GET /api/model-info` to confirm both models are
loaded and serving.

## Retraining

Any change to room cost multipliers, default sqft, or constraints in
`backend/models/building.py` should be mirrored into `features.py`, and the
dataset + models regenerated. The synthetic labels are *derived from* the
current formulas, so the model's value-add is the region/seismic/soil
signal layered on top — not a wholesale replacement of the engineering
assumptions.
