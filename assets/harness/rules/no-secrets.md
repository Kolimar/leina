---
{
  "id": "harness/no-secrets",
  "phase": "verify",
  "severity": "blocking",
  "summary": "The diff must not add credentials, tokens, or private keys.",
  "gate": {
    "type": "diff-content",
    "ignoreCase": true,
    "forbidAdded": "-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY|aws_secret_access_ke[y]|(?:[A-Za-z0-9_-]*(?:secret|token|passwd|password|credential)s?|[A-Za-z0-9_-]*[_-]key|apikey)[\"']?\\s*[:=]\\s*[\"'][A-Za-z0-9_/+=.-]{16,}|(?:[A-Za-z0-9_-]*(?:secret|token|passwd|password|credential)s?|[A-Za-z0-9_-]*[_-]key|apikey)[\"']?\\s*[:=]\\s*(?=[A-Za-z0-9_/+=.-]*[0-9])[A-Za-z0-9_/+=.-]{16,}|\\bgh[pousr]_[A-Za-z0-9]{30,}|\\bgithub_pat_[A-Za-z0-9_]{30,}|\\bxox[abprs]-[A-Za-z0-9][A-Za-z0-9-]{8,}|\\bAIza[0-9A-Za-z_-]{30,}|\\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|\\bsk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}|\\bAKIA[0-9A-Z]{16}\\b|\\bbearer\\s+(?=[A-Za-z0-9_/+=.-]*[0-9])[A-Za-z0-9_/+=.-]{25,}|\\b(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis|amqps?)://[^/\\s:@]+:[^@\\s]{3,}@",
    "failureMessage": "The diff appears to add a credential (key, token, or password literal).\nRemove it and load the value from the environment or a secret store instead.\nIf this is a false positive (e.g. a test fixture), rename the identifier or\nbreak the literal apart so it no longer reads as a live credential.\n"
  },
  "tags": [
    "security"
  ]
}
---

# Never commit secrets

Credentials belong in the environment or a secret manager, never in the diff.
Placeholder values in examples must be obviously fake (`YOUR_API_KEY`).

## What the gate looks for

- Private key blocks (`-----BEGIN … PRIVATE KEY`).
- Assignments to secret-looking identifiers (ending in `key`, `secret`,
  `token`, `password`, `passwd`, `credential`) — quoted values of 16+
  characters, and **unquoted** values of 16+ characters containing a digit
  (the most common leak shape: `API_KEY=…` in a `.env` or shell file).
- Known provider token prefixes, wherever they appear on a line: GitHub
  (`ghp_…`, `github_pat_…`), Slack (`xoxb-…`, `xoxp-…`), Google (`AIza…`),
  Stripe (`sk_live_…`, `sk_test_…`), OpenAI/Anthropic-style (`sk-…`), AWS
  access key ids (`AKIA…`) and the `aws_secret_access_…` config key.
- `Bearer <token>` authorization values.
- Connection strings embedding a password
  (`postgres://user:…@host` style — also `mysql`, `mongodb`, `redis`, `amqp`).

## Detection is best-effort — not a guarantee

A single regex cannot recognize every credential format. Entropy-encoded
blobs without a known prefix, secrets split across lines, novel provider
prefixes, and values shorter than the length thresholds all pass silently.
Treat this gate as a tripwire against the common accident, not as a secret
scanner of record — pair it with a dedicated scanner (gitleaks,
trufflehog) in CI if secrets are a real threat for the repository.

The unquoted-value pattern requires a digit in the value to avoid flagging
ordinary code (`token = requestAccessToken`); a fully alphabetic unquoted
secret will therefore not be caught. The gate reports only `file:line` and a
masked 3-character prefix of the match, never the matched text itself, so a
caught secret is not re-echoed into the verify report.
