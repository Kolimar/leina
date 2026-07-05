# Security Policy

## Supported versions

Only the latest published version of `leina` receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security reports. Instead, use GitHub's private
vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository.
You should receive an acknowledgement within a few days.

## Scope notes for researchers

- leina is **local-first**: it makes no network calls at runtime (building a Java/C#
  sidecar is the only operation that downloads anything, and it does so via the local
  toolchain / a configurable mirror).
- `~/.leina/.env` stores service credentials in **plain text with 0600 permissions** by
  design; the threat model is keeping values out of argv, shell history, and AI-agent
  context (the "names, not values" contract) — not encryption at rest. Reports that assume
  at-rest encryption is intended will be closed as by-design, but reports of value leakage
  through argv/stdout/logs are very much in scope.
- `leina audit` findings are candidate paths for triage, not confirmed vulnerabilities.
