# leina docs — index

Start with the root [`readme.md`](../readme.md) for the project overview. From there:

| Doc | What it covers | Language |
|---|---|---|
| [`GETTING_STARTED.md`](GETTING_STARTED.md) | First-timer walkthrough: install, build the graph, query it, save memory | English |
| [`guides/usage-guide.md`](guides/usage-guide.md) | Guided, Q&A-style walkthrough ("what can I ask the AI") + a full SDD walkthrough | English ([ES](i18n/es/usage-guide.md)) |
| [`CLI_REFERENCE.md`](CLI_REFERENCE.md) | Every command, every flag, and what it prints | English ([ES](i18n/es/cli-reference.md)) |
| [`concepts/`](concepts/README.md) | How it works — graph, memory, search, drift, hooks — with diagrams | English ([ES](i18n/es/concepts/README.md)) |
| [`ROADMAP.md`](ROADMAP.md) | What's shipped, what's next, non-goals | English |
| [`benchmarks/README.md`](benchmarks/README.md) | Reproducible timing harness + reference numbers | English |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Dev setup, architecture in two minutes, PR guidelines | English |
| [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Community standards and enforcement | English |
| [`../SECURITY.md`](../SECURITY.md) | Supported versions, vulnerability reporting, scope notes | English |
| [`../changelog.md`](../changelog.md) | Notable changes, [Keep a Changelog](http://keepachangelog.com/) format | English |

> 🌐 **Read it bilingual, in your browser.** All of the above (except `AGENTS.md`, which is an
> agent-integration convention doc for contributors, not product documentation) is published as
> one searchable static site with an English/Spanish toggle, generated from these same markdown
> files plus their translated counterparts under [`i18n/`](i18n/). Generate it locally:
>
> ```bash
> npm run docs:site:build   # writes site/index.html
> open site/index.html      # macOS; use xdg-open on Linux
> ```
>
> It's also deployed automatically to GitHub Pages on every push to `main`.
