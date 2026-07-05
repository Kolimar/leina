# SonarQube Rules

**Server:** http://sonarprod.ar.bsch:9000
**Generated:** 2026-04-14 16:45:39

---

## C# (3 rules)

| # | Rule Key | Name | Severity | Type | Status |
|---|----------|------|----------|------|--------|
| 1 | `csharpsquid:S1116` | Empty statements should be removed | MAJOR | CODE_SMELL | DEPRECATED |
| 2 | `csharpsquid:S1186` | Methods should not be empty | MAJOR | CODE_SMELL | READY |
| 3 | `roslyn.sonaranalyzer.security.cs:S2076` | OS commands should not be vulnerable to injection | BLOCKER | VULNERABILITY | READY |

## C++ (4 rules)

| # | Rule Key | Name | Severity | Type | Status |
|---|----------|------|----------|------|--------|
| 1 | `cpp:S1116` | Empty statements should be removed | MAJOR | CODE_SMELL | DEPRECATED |
| 2 | `cpp:S1186` | Methods should not be empty | MAJOR | CODE_SMELL | READY |
| 3 | `cpp:S2068` | Hard-coded credentials are security-sensitive | BLOCKER | SECURITY_HOTSPOT | READY |
| 4 | `cpp:S1481` | Unused local variables should be removed | MINOR | CODE_SMELL | DEPRECATED |
