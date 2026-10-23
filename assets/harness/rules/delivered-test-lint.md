---
{
  "id": "harness/delivered-test-lint",
  "phase": "verify",
  "severity": "advisory",
  "summary": "Changed tests must not depend on this checkout: no git history at a fixed sha, no temp dir inside the repo.",
  "gate": [
    {
      "type": "diff-content",
      "paths": [
        "*test*",
        "*spec*"
      ],
      "forbidAdded": "\\bgit\\b.*\\b(?:show|log|checkout|cat-file|diff|rev-parse|ls-tree|archive|reset|switch)\\b.*\\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\\b",
      "onlyIfChanged": [
        "**/*test*",
        "**/*spec*"
      ],
      "failureMessage": "Your diff adds a test that reads git history at a fixed commit sha.\nA shallow clone (CI) or rewritten history does not have that commit: create the commits the test needs in a temporary repo instead.\n"
    },
    {
      "type": "diff-content",
      "paths": [
        "*test*",
        "*spec*"
      ],
      "forbidAdded": "\\bmkdtemp(?:Sync)?\\(\\s*(?:[\\\"'`](?![/~$]|[A-Za-z]:[\\\\/])|(?:path\\.)?(?:join|resolve)\\(\\s*(?:__dirname|import\\.meta\\.dirname|process\\.cwd\\(\\)|[\\\"'`]\\.))|\\bmkdtemp\\([^)]*\\bdir\\s*=\\s*(?:[\\\"']\\.|os\\.getcwd\\(\\))|\\bMkdirTemp\\(\\s*\\\"\\.|\\bTMPDIR\\s*[:=]\\s*[\\\"'`]?(?:\\.|\\$\\{?PWD\\b|process\\.cwd\\(\\)|__dirname)",
      "onlyIfChanged": [
        "**/*test*",
        "**/*spec*"
      ],
      "failureMessage": "Your diff adds a test that creates its temp dir inside the repository (relative path, __dirname, process.cwd() or TMPDIR=.).\nUse the OS temp dir (os.tmpdir(), tempfile, t.TempDir()) so a run never leaves files in the checkout or collides with another run.\n"
    }
  ],
  "tags": [
    "testing"
  ]
}
---

# Tests must not depend on this checkout

A test that runs `git show`/`git log`/`git checkout` at a literal commit sha passes only
where that commit exists: a shallow CI clone or a rewritten history breaks it. A test that
makes its temp dir under the repository (a relative path, `__dirname`, `process.cwd()`,
`TMPDIR=.`) leaves files in the checkout and collides with a parallel run. Build the
history the test needs in a temporary repo, and put temp files under the OS temp dir.

Both checks read single added lines, so they can misfire: the rule is advisory.
