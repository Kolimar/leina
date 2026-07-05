---
name: branch-pr
description: "Create pull requests with issue-first checks. Trigger: creating, opening, or preparing PRs for review."
license: MIT
metadata:
  version: "2.0"
---

## When to Use

Use this skill when:
- Creating a pull request for any change
- Preparing a branch for submission
- Helping a contributor open a PR

---

## Critical Rules

1. **Every PR MUST link an approved issue** — no exceptions
2. **Every PR MUST have exactly one `type:*` label**
3. **Automated checks must pass** before merge is possible
4. **Blank PRs without issue linkage should be blocked** by the repo's CI, where configured

---

## Workflow

```
1. Verify the linked issue is approved (per the repo's issue workflow)
2. Create branch: type/description (see Branch Naming below)
3. Implement changes with conventional commits
4. Run the project's linters and tests
5. Open PR, following the repo's PR template if one exists
6. Add exactly one type:* label
7. Wait for automated checks to pass
```

---

## Branch Naming

Branch names MUST match this regex:

```
^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$
```

**Format:** `type/description` — lowercase, no spaces, only `a-z0-9._-` in description.

| Type | Branch pattern | Example |
|------|---------------|---------|
| Feature | `feat/<description>` | `feat/user-login` |
| Bug fix | `fix/<description>` | `fix/zsh-glob-error` |
| Chore | `chore/<description>` | `chore/update-ci-actions` |
| Docs | `docs/<description>` | `docs/installation-guide` |
| Style | `style/<description>` | `style/format-scripts` |
| Refactor | `refactor/<description>` | `refactor/extract-shared-logic` |
| Performance | `perf/<description>` | `perf/reduce-startup-time` |
| Test | `test/<description>` | `test/add-setup-coverage` |
| Build | `build/<description>` | `build/update-shellcheck` |
| CI | `ci/<description>` | `ci/add-branch-validation` |
| Revert | `revert/<description>` | `revert/broken-setup-change` |

---

## PR Body Format

If the repo provides a PR template (e.g. `.github/PULL_REQUEST_TEMPLATE.md`), follow it. Otherwise, every PR body MUST contain:

### 1. Linked Issue (REQUIRED)

```markdown
Closes #<issue-number>
```

Valid keywords: `Closes #N`, `Fixes #N`, `Resolves #N` (case insensitive).
The linked issue MUST have the `status:approved` label.

### 2. PR Type (REQUIRED)

Check exactly ONE in the template and add the matching label:

| Checkbox | Label to add |
|----------|-------------|
| Bug fix | `type:bug` |
| New feature | `type:feature` |
| Documentation only | `type:docs` |
| Code refactoring | `type:refactor` |
| Maintenance/tooling | `type:chore` |
| Breaking change | `type:breaking-change` |

### 3. Summary

1-3 bullet points of what the PR does.

### 4. Changes Table

```markdown
| File | Change |
|------|--------|
| `path/to/file` | What changed |
```

### 5. Test Plan

```markdown
- [x] Linters and tests pass for the project's stack
- [x] Manually tested the affected functionality
```

### 6. Contributor Checklist

All boxes must be checked:
- Linked an approved issue
- Added exactly one `type:*` label
- Ran the project's linters and tests
- Docs updated if behavior changed
- Conventional commit format
- No `Co-Authored-By` trailers

---

## Automated Checks (where the repo enforces them)

If the repo wires CI for PR governance, expect checks along these lines (exact job names vary per repo):

| Check | What it verifies |
|-------|-----------------|
| Issue reference | Body contains `Closes/Fixes/Resolves #N` |
| Issue approved | The linked issue is approved |
| Single type label | PR has exactly one `type:*` label |
| Project CI | Linters and tests pass for the stack |

---

## Mandatory ticket on every commit (NON-NEGOTIABLE)

Every commit message MUST start with the ticket id (`TICKET-123 Description of the change`).
Follow `skills/_shared/ticket-commit-rule.md`: ask the user for the ticket BEFORE any
`git commit`; never assume, omit, or invent it; if no ticket is given, do not commit.

---

## Conventional Commits

Commit messages MUST match this regex:

```
^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9\._-]+\))?!?: .+
```

**Format:** `type(scope): description` or `type: description`

- `type` — required, one of: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`
- `(scope)` — optional, lowercase with `a-z0-9._-`
- `!` — optional, indicates breaking change
- `description` — required, starts after `: `

Type-to-label mapping:

| Commit type | PR label |
|-------------|----------|
| `feat` | `type:feature` |
| `fix` | `type:bug` |
| `docs` | `type:docs` |
| `refactor` | `type:refactor` |
| `chore` | `type:chore` |
| `style` | `type:chore` |
| `perf` | `type:feature` |
| `test` | `type:chore` |
| `build` | `type:chore` |
| `ci` | `type:chore` |
| `revert` | `type:bug` |
| `feat!` / `fix!` | `type:breaking-change` |

Examples:
```
PROJ-123 feat(api): add pagination to the search endpoint
PROJ-123 fix(skills): correct topic key format in sdd-apply
PROJ-123 docs(readme): update multi-model configuration guide
PROJ-123 refactor(skills): extract shared persistence logic
PROJ-123 chore(ci): add a lint step to the PR validation workflow
DEVOPS-42 perf(build): reduce cold-start time
DEVOPS-42 style(skills): fix markdown formatting
DEVOPS-42 test(api): add search endpoint integration tests
DEVOPS-42 ci(workflows): add branch name validation
DEVOPS-42 revert: undo broken release change
PROJ-100 feat!: redesign the tool loading system
```

---

## Commands

```bash
# Create branch
git checkout -b feat/my-feature main

# Run the project's linters and tests before pushing

# Push and create PR
git push -u origin feat/my-feature
gh pr create --title "feat(scope): description" --body "Closes #N"

# Add type label to PR
gh pr edit <pr-number> --add-label "type:feature"
```
