---
{
  "name": "fix-bug",
  "description": "Fix a reported bug with a regression test that pins the fix.",
  "taskType": "bugfix"
}
---

# Recipe: fix a bug

A parameterized golden path. Follow the steps in order; do not improvise the
sequence. Parameter: `<symptom>` (the observed wrong behavior).

1. Declare the contract:
   `leina harness contract new --goal "Fix: <symptom>" --type bugfix --scope "src/**" --scope "test/**" --criterion "regression test reproduces the bug and passes after the fix" --criterion "no unrelated behavior changed"`
2. Reproduce first: write a failing test that captures `<symptom>` exactly.
   If you cannot reproduce it, STOP and report what you tried — do not "fix"
   what you cannot observe.
3. Find the root cause (not the nearest symptom). State it in one sentence in
   `.harness/state/current/plan.md` before changing code.
4. Apply the smallest fix that makes the regression test pass. Resist
   refactoring beyond the fix — that is a separate task.
5. Run the full suite, then `leina harness verify`, and fix every failing gate.
6. `leina harness contract end`.
