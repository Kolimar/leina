---
{
  "name": "add-endpoint",
  "description": "Add a new HTTP endpoint to the service, end to end, with tests.",
  "taskType": "feature"
}
---

# Recipe: add a new endpoint

A parameterized golden path. Follow the steps in order; do not improvise the
sequence. Parameters: `<resource>` (e.g. `users`), `<action>` (e.g. `list`).

1. Declare the contract:
   `leina harness contract new --goal "Add <action> <resource> endpoint" --type feature --scope "src/routes/**" --scope "src/services/**" --scope "test/**" --criterion "endpoint returns expected shape" --criterion "error cases covered by tests"`
2. Locate the existing route registration pattern (grep for an already-working
   endpoint) and mirror it — same file layout, same naming, same validation
   style. Never introduce a new pattern when one exists.
3. Write the failing test first: request → expected status + body shape.
4. Implement handler + service logic until the new test passes.
5. Run the full suite, then `leina harness verify`, and fix every failing gate.
6. `leina harness contract end`.
