# CirCor validation

Scores HeartCode's beat detection against the expert-reviewed segmentation in the CirCor DigiScope dataset.
Protocol: "HeartCode Validation Protocol (CirCor)" (the doc). Thresholds are in `CONFIG` in `validate.mjs`.

```
# 1. development split (20% of subjects): use it to find bugs in the scorer, not to judge the detector
node validation/validate.mjs ~/Documents/CirCor --split dev

# 2. lock the thresholds, commit everything, tag the commit (git tag validation-v1)

# 3. the test split (80%): opens once, on the frozen tool
node validation/validate.mjs ~/Documents/CirCor --split test --confirm-locked
```

Point the first argument at the folder holding the `.wav`, `.tsv` and `.txt` files (it is searched recursively).
Results land in `validation-results/<split>/`: `report.md`, `summary.json`, `results.csv`, `results.jsonl`, `excluded.json`.
An interrupted run carries on when you repeat the command.

The test split refuses to run if `src/` or `validation/` has uncommitted changes, or if it was already opened on a
different commit. Changing the detector after seeing test results spends the test set: log it as a deviation.

`npm test` includes a self-test that scores a fake CirCor-format folder (honest labels must score high, deliberately
shifted labels must score low), so the scorer itself is checked.
