# SVI calibration cross-validation tools

The TS SVI fitter (`demo/src/svi/`) is cross-validated against
`scipy.optimize.least_squares` to triangulate against a second independent
solver. CI does not run Python — the committed
`demo/test/fixtures/scipy-reference.json` is the snapshot the test reads.
Reviewers who want to verify the snapshot is current re-run the script
locally and diff the regenerated JSON against the committed copy.

## One-time setup

```bash
cd demo/tools
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Regenerating `scipy-reference.json`

```bash
python3 generate-scipy-reference.py
```

This reads `../test/fixtures/gatheral-spx.json`, runs scipy's
trust-region-reflective LM on the same residual function used by the TS
fitter, and writes `../test/fixtures/scipy-reference.json` with the
recovered parameters.

## Pinned dependency rationale

scipy versions are pinned in `requirements.txt`; minor convergence
differences across scipy releases (typically in the last 1–2 sig figs) can
cause the committed JSON to drift if scipy is bumped. If you upgrade
scipy:

1. Run the regen script.
2. Diff the new `scipy-reference.json` against the committed one.
3. If the diff is within the per-parameter tolerance documented in the
   test (`svi-cross-validation.test.ts`), update `requirements.txt` and
   commit the new JSON.
4. If the diff exceeds tolerance, investigate before bumping.
