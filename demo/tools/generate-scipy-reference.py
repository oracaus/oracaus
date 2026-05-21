#!/usr/bin/env python3
"""Cross-validate the demo's TS SVI fitter against scipy.optimize.least_squares.

Usage:
    python3 generate-scipy-reference.py

Scans `../test/fixtures/gatheral-*.json`, runs scipy's trust-region-reflective
LM on each, and writes the corresponding `scipy-reference[-suffix].json`. The
filename suffix is preserved: `gatheral-spx.json` → `scipy-reference.json`,
`gatheral-skewed.json` → `scipy-reference-skewed.json`, etc.

The residual is unweighted; the test gates the demo's weighted-LS path
elsewhere (svi-fitter.test.ts). Per-parameter bounds enforced via scipy's
`bounds` argument: `b ≥ 0`, `|ρ| < 0.999`, `σ > 1e-6`.

CI does not run this script. Reviewers who want to verify the cross-
validation re-run the script locally and diff the regenerated JSONs against
the committed copies.

Pinned dependencies (`requirements.txt`): scipy 1.13.0, numpy 1.26.4.
Newer scipy versions may converge slightly differently in the last 1–2 sig
figs; adjust the test tolerance accordingly if you bump.
"""

from __future__ import annotations

import json
import pathlib
import sys
from typing import Any

import numpy as np
from scipy.optimize import least_squares  # type: ignore[import-untyped]


HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE.parent / "test" / "fixtures"


def w_svi(k: np.ndarray, params: np.ndarray) -> np.ndarray:
    """Raw-SVI total variance w(k) under params (a, b, rho, m, sigma)."""
    a, b, rho, m, sigma = params
    km = k - m
    return a + b * (rho * km + np.hypot(km, sigma))


def residual(params: np.ndarray, ks: np.ndarray, ws: np.ndarray) -> np.ndarray:
    """f(p) - y for unweighted LS."""
    return w_svi(ks, params) - ws


def output_name(fixture_name: str) -> str:
    """Map gatheral-spx.json → scipy-reference.json, gatheral-foo.json →
    scipy-reference-foo.json. The base case has no suffix."""
    stem = pathlib.Path(fixture_name).stem
    assert stem.startswith("gatheral-"), f"unexpected fixture name: {fixture_name}"
    suffix = stem[len("gatheral-") :]
    if suffix == "spx":
        return "scipy-reference.json"
    return f"scipy-reference-{suffix}.json"


def fit_one(fixture_path: pathlib.Path) -> int:
    with fixture_path.open() as fh:
        fixture: dict[str, Any] = json.load(fh)

    T = fixture["timeToExpiry"]
    ks = np.array([q["logMoneyness"] for q in fixture["quotes"]], dtype=np.float64)
    ivs = np.array([q["impliedVol"] for q in fixture["quotes"]], dtype=np.float64)
    ws = ivs * ivs * T

    # Cold start far from truth — verifies scipy's basin of attraction.
    x0 = np.array([0.01, 0.5, 0.0, 0.0, 0.5], dtype=np.float64)
    bounds = (
        [-np.inf, 0.0, -0.999, -np.inf, 1e-6],
        [np.inf, 10.0, 0.999, np.inf, 5.0],
    )

    result = least_squares(
        residual,
        x0,
        args=(ks, ws),
        bounds=bounds,
        method="trf",
        xtol=1e-14,
        ftol=1e-14,
        gtol=1e-14,
        max_nfev=2000,
    )

    if not result.success:
        print(
            f"scipy did not converge on {fixture_path.name}: {result.message}",
            file=sys.stderr,
        )
        return 1

    a, b, rho, m, sigma = result.x.tolist()
    out_filename = output_name(fixture_path.name)
    out = {
        "$schema": "scipy.optimize.least_squares cross-validation reference",
        "description": (
            f"Output of scipy.optimize.least_squares (TRF method) on the same "
            f"SVI calibration as {fixture_path.name}. Regenerate via "
            f"demo/tools/generate-scipy-reference.py."
        ),
        "scipyVersion": "1.13.0",
        "method": "trf",
        "loss": "linear",
        "fitsTo": f"demo/test/fixtures/{fixture_path.name}",
        "params": {"a": a, "b": b, "rho": rho, "m": m, "sigma": sigma},
        "residualNorm": float(np.sqrt(2.0 * result.cost)),
        "iterations": int(result.nfev),
        "tolerance": "1e-12 absolute on each parameter for clean data",
    }

    out_path = FIXTURES / out_filename
    with out_path.open("w") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    print(f"Wrote {out_path}")
    return 0


def main() -> int:
    fixtures = sorted(FIXTURES.glob("gatheral-*.json"))
    if not fixtures:
        print(f"No gatheral-*.json fixtures found in {FIXTURES}", file=sys.stderr)
        return 1
    failed = 0
    for fixture in fixtures:
        failed += fit_one(fixture)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
