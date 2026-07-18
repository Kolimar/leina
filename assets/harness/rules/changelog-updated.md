---
{
  "id": "harness/changelog-updated",
  "phase": "deliver",
  "severity": "advisory",
  "enabled": false,
  "summary": "User-facing changes should be reflected in the changelog.",
  "gate": {
    "type": "diff",
    "requireChangesIn": [
      "CHANGELOG.md"
    ],
    "onlyIfChanged": [
      "src/**",
      "lib/**"
    ],
    "failureMessage": "Source files changed but CHANGELOG.md was not updated. If the change is\nuser-facing, add an entry; if not, say so explicitly in your report.\n"
  },
  "tags": [
    "docs"
  ]
}
---

# Keep the changelog current

If the change is visible to users, add a CHANGELOG.md entry describing it in
one line, under the unreleased section. Disabled by default — enable it in
`.harness/config.json` for projects that keep a changelog.
