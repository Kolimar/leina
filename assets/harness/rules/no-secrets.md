---
{
  "id": "harness/no-secrets",
  "phase": "verify",
  "severity": "blocking",
  "summary": "The diff must not add credentials, tokens, or private keys.",
  "gate": {
    "type": "diff-content",
    "ignoreCase": true,
    "forbidAdded": "-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY|aws_secret_access_key|(api[_-]?key|secret|token|password)[\"']?\\s*[:=]\\s*[\"'][A-Za-z0-9_/+-]{16,}",
    "failureMessage": "The diff appears to add a credential (key, token, or password literal).\nRemove it and load the value from the environment or a secret store instead.\nIf this is a false positive (e.g. a test fixture), rename the identifier so\nit no longer reads as a live credential.\n"
  },
  "tags": [
    "security"
  ]
}
---

# Never commit secrets

Credentials belong in the environment or a secret manager, never in the diff.
Placeholder values in examples must be obviously fake (`YOUR_API_KEY`).
