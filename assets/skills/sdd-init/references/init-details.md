# SDD Init Details

## Testing Capability Checklist

- Test runner: `package.json` scripts/deps, `pyproject.toml`, `pytest.ini`, `go.mod`, `Cargo.toml`, `Makefile`.
- Test layers: unit runner; integration libraries (`testing-library`, `httpx`, `httptest`, `WebApplicationFactory`); E2E tools (`playwright`, `cypress`, `selenium`, `chromedp`).
- Coverage: `vitest --coverage`, `jest --coverage`, `c8`, `pytest-cov`, `go test -cover`, `coverlet`.
- Quality: linter, type checker, formatter commands.

## Skill Registry Scan Rules

- Scan user skills: `~/.claude/skills/` (present only when the Claude Code add-on is installed; Windsurf and Devin do not use a skills directory).
- Scan project skills: `{project-root}/.claude/skills/` (present only with the Claude Code add-on).
- Skip `sdd-*`, `_shared`, and `skill-registry`; deduplicate by skill name, preferring project-level skills over user-level skills.
- Read each selected `SKILL.md`; if it exceeds 200 lines, focus on frontmatter plus the Hard Rules section.
- Extract `name`, trigger text from `description`, full `SKILL.md` path, and compact rules.
- Generate compact rules as 5-15 actionable lines per skill: constraints, key patterns, breaking changes, and gotchas only. Do not include purpose, motivation, installation steps, full examples, or fluff.
- Scan project convention files: `AGENTS.md` (read by Windsurf, Devin and Claude Code) and project-level `CLAUDE.md` (present only with the Claude Code add-on).
- For index files such as `AGENTS.md`, extract referenced file paths and include both the index and referenced files in the registry.

## LLM-First Skill Criteria

- Treat skills as runtime instruction contracts, not human documentation.
- Required structure: frontmatter, Activation Contract, Hard Rules, Decision Gates, Execution Steps, Output Contract, References.
- Keep `description` quoted, one physical line, trigger-first, and no longer than 250 characters.
- Target 180-450 body tokens; move examples, schemas, edge cases, and background into local `references/` or `assets/`.
- References must be local files and stable relative to the skill directory when possible.
- Quality gates: hard rules are observable, decision gates cover real forks, output contract states exactly what to return, and references resolve locally.
- For leina SDD skills, persistence is MANDATORY: save artifacts via `leina memory save` using the `sdd/{change-name}/{artifact}` topic convention with `--topic` (see `skills/_shared/leina-memory-convention.md`).

## Leina Memory Saves

All saves use the `leina memory save <dir>` CLI; `<dir>` is the project root.

```bash
leina memory save <dir> \
  --title "sdd-init/{project}" --topic "sdd-init/{project}" \
  --type architecture --content "{detected project context markdown}"

leina memory save <dir> \
  --title "sdd/{project}/testing-capabilities" --topic "sdd/{project}/testing-capabilities" \
  --type config --content "{testing capabilities markdown}"

leina memory save <dir> \
  --title "skill-registry" --topic "skill-registry" \
  --type config --content "{registry markdown}"
```

## OpenSpec Skeleton

```text
openspec/
├── config.yaml
├── specs/
└── changes/
    └── archive/
```

`config.yaml` should include concise context, `strict_tdd`, testing capabilities, and phase rules for proposal/spec/design/tasks/apply/verify/archive. Keep `context:` under 10 lines.

## Testing Capabilities Format

```markdown
## Testing Capabilities

**Strict TDD Mode**: {enabled/disabled}
**Detected**: {date}

### Test Runner

- Command: `{command}`
- Framework: {name}

### Test Layers

| Layer       | Available | Tool        |
| ----------- | --------- | ----------- |
| Unit        | ✅ / ❌   | {tool or —} |
| Integration | ✅ / ❌   | {tool or —} |
| E2E         | ✅ / ❌   | {tool or —} |

### Coverage

- Available: ✅ / ❌
- Command: `{command or —}`

### Quality Tools

| Tool         | Available | Command        |
| ------------ | --------- | -------------- |
| Linter       | ✅ / ❌   | {command or —} |
| Type checker | ✅ / ❌   | {command or —} |
| Formatter    | ✅ / ❌   | {command or —} |
```

## Output Templates

For each mode, include project, stack, persistence, Strict TDD Mode, Testing Capabilities table, artifacts created/saved, limitations where relevant, and next steps. Memory mode must mention local/non-shareable limitations; none mode must recommend enabling persistence.
