# leina

[![CI](https://github.com/Kolimar/leina/actions/workflows/ci.yml/badge.svg)](https://github.com/Kolimar/leina/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@kolimar/leina)](https://www.npmjs.com/package/@kolimar/leina)
[![node](https://img.shields.io/node/v/leina)](#requirements)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Leina** es una **L**inked **E**ngineering **I**ntelligence **N**etwork for **A**gents
(Red de Inteligencia de Ingeniería Conectada para Agentes):
un sistema persistente que conecta código, decisiones, tests, skills y aprendizajes.

En la práctica: una **CLI** que construye un **grafo de conocimiento** consultable de un
codebase más una **memoria de proyecto** local, de modo que un asistente de IA (Devin, Claude
Code, …) recupera contexto *acotado* mediante comandos `leina` rápidos en lugar de hacer grep
por los archivos.

> **Interfaz de línea de comandos.** Cada capacidad es un
> `leina <subcommand>` que ejecutás directamente (o que un agente ejecuta a través de su
> shell). El camino de lectura/consulta arranca en ~0.15s porque el stack pesado de extracción
> (tree-sitter + ts-morph) se carga de forma perezosa — solo `build`/`refresh` pagan ese costo.

Hoy se envían dos capas: el **graph** (qué está conectado con qué) y la **memory con
detección de drift** (el *por qué* detrás del código, re-chequeado contra el grafo a medida
que cambia). Un flujo de trabajo **SDD** integrado (spec→design→tasks) se distribuye como
skills de agente y en el protocolo siempre activo — sus fases de diseño y tareas acotan el
impacto con `leina affected` antes de decidir. Construido en TypeScript, respaldado por
SQLite, con un sidecar semántico para C#/Java de nivel compilador.

La herramienta es **local-first, cloud-ready, graph-native y validation-first**: los casos
de uso principales se exponen como **capabilities** agnósticas de transporte
(`capabilities list`) con esquemas de salida versionados, todo comando legible por máquina
lleva un `schemaVersion`, y `verify --json` le da a CI un gate de salud accionable. El modelo
de grafo es **extensible más allá del código** (servicios, configuraciones, infraestructura)
de modo que `impact analyze` puede cruzar código→test→config→service, y un **event outbox**
local (desactivado por defecto) es la costura para una futura sincronización cloud opcional —
hoy no existe ninguna dependencia de la nube.

## Por qué un grafo (y no solo vector RAG)

Un vector store responde "¿qué se parece a esto?". Un grafo responde "¿qué está *conectado*
con esto, y cómo?" — preguntas de múltiples saltos como *"¿quién depende de esta clase?"* o
*"¿cómo llega la CLI a la base de datos?"*. Para código, el segundo tipo de pregunta es el que
más importa. Ambos enfoques son complementarios; esto es la mitad del grafo.

## Requisitos

- **Node ≥ 22.13** — usa el `node:sqlite` incorporado (sin dependencias nativas) y ejecuta
  TypeScript directamente vía `--experimental-strip-types` (sin paso de build). Node 22.13.0
  es el primer release Active LTS de la serie 22.x donde `node:sqlite` está disponible sin el
  flag `--experimental-sqlite`. **Se recomienda Node ≥ 24** — los builds de Node 22/23 carecen
  de SQLite FTS5, así que la búsqueda de memoria corre en modo degradado LIKE (sin porter
  stemming ni ranking BM25). Se emite una advertencia a stderr en cada comando `memory` en ese
  modo.

  <details><summary><b>¿Por qué el piso de ≥ 22.13?</b> (un trade-off deliberado)</summary>

  El piso compra la propiedad sobre la que descansa todo lo demás: **cero dependencias
  nativas**. `node:sqlite` reemplaza a módulos nativos al estilo `better-sqlite3`, razón por
  la cual leina se instala limpiamente bajo npm/pnpm/bun, con `--ignore-scripts`, detrás de
  proxies, y sin un toolchain de compilación. Bajar el piso sacrificaría esa propiedad.
  Node 20 salió de su ventana de mantenimiento en abril de 2026 — cada línea LTS soportada
  (22, 24) corre leina. Matriz de funcionalidades por versión de Node:

  | Node | Estado |
  |---|---|
  | < 22.13 | ✗ no soportado — la CLI se cierra al iniciar con indicaciones de actualización |
  | 22.13 – 23.x | ✓ funciones completas del grafo; búsqueda de memoria degradada (LIKE, sin FTS5) |
  | ≥ 24 | ✓ todo, incl. búsqueda de memoria full-text con FTS5 (porter + BM25) |

  </details>

```bash
# use it anywhere — installs the `leina` binary on your PATH
npm install -g @kolimar/leina

# or, working from a clone (contributors / latest unreleased code):
npm install
```

### Gestores de paquetes

leina deliberadamente no tiene **scripts de install/postinstall** ni **paso de compilación
nativa** (sus gramáticas de parser son simples archivos `.wasm` dentro de paquetes normales),
así que se instala limpiamente incluso donde los scripts de lifecycle están deshabilitados:

| Gestor | Estado | Notas |
|---|---|---|
| npm | ✅ | incluyendo `--ignore-scripts` |
| pnpm | ✅ | no requiere aprobación de "ignored build scripts" — no hay ninguno |
| bun | ✅ | no requiere entrada en `trustedDependencies` |
| yarn (linker node_modules) | ✅ | classic, o Berry con `nodeLinker: node-modules` |
| yarn Plug'n'Play | ❌ | no soportado — las gramáticas WASM deben existir en el filesystem real |

Si alguna vez una instalación global resuelve de forma extraña (stores symlinkeados,
prefijos personalizados), `leina doctor` imprime desde dónde resuelven realmente el entry
point de la CLI, los assets embebidos y las gramáticas WASM.

> **Windows + Git Bash:** ejecutá `leina` desde **cmd.exe o PowerShell**, no desde Git Bash.
> Bajo MSYS/Git Bash, el shim POSIX de npm puede resolver mal la ruta de la CLI y fallar con
> `MODULE_NOT_FOUND` apuntando a `C:\Program Files\Git\Users\...` incluso con una instalación
> correcta. `leina doctor` señala esto (el check de _shell interop_) y `leina
> setup`/`activate`/`init` imprimen la solución (deliberadamente no hay hook postinstall de
> npm — pnpm/bun saltean los scripts de dependencias). Soluciones alternativas: llamar a node
> directamente — `node "%APPDATA%\npm\node_modules\leina\dist\cli\index.js" --help` —
> o agregar un wrapper en `~/.bashrc`:
> `leina() { node "$APPDATA/npm/node_modules/leina/dist/cli/index.js" "$@"; }`

## Uso

```bash
# These examples use the clone/contributor form `npm run cli -- <command>`.
# If you ran `npm install -g @kolimar/leina`, drop the prefix and call `leina <command>`.
#
# ── Interactive console ─────────────────────────────────────────────────────
# Everything below is also available through menus: install/update (pick asset
# groups), init/deinit the current repo, health status, repair, env vars, uninstall.
npm run cli -- tui                            # also: leina tui

# ── Quick Start ─────────────────────────────────────────────────────────────
# One command, once per machine: the "magic" setup (global share + symlinks +
# user-global Exec grant + hooks, and turns on blanket mode). That's it —
# leina is now available in every Devin session.
npm run cli -- setup                         # also: leina setup
# Undo everything machine-wide at any time:
npm run cli -- disable

# Per project: nothing to remember. Under blanket mode the leina-setup skill
# asks once per repo ("use leina here?") and runs init/deinit for you. Each
# repo has a local, git-ignored consent flag: unknown -> ask once, enabled -> on,
# disabled -> silent. The graph builds on demand the first time it's queried.
# You can also wire a repo by hand:
npm run cli -- init <dir>                     # adaptive: LIGHT under blanket, FULL standalone
npm run cli -- init <dir> --build             # also build the graph synchronously now
npm run cli -- init <dir> --mcp               # register the MCP server in .mcp.json
npm run cli -- init <dir> --claude-hooks      # Claude Code hooks (same gate Devin gets)
npm run cli -- deinit <dir>                   # opt this repo out (consent=disabled) + strip wiring

# Prefer the granular pieces? They compose what `setup` does and each has an inverse:
#   activate <-> deactivate   (global share/symlinks/user-config; no blanket)
#   install-global            (deprecated alias of activate)

# Choose WHICH bundled skills/agents install (see assets/catalog.json for the full list,
# groups and dependencies). Omit the flags to keep your previous choice; default is full.
npm run cli -- activate --preset minimal        # core plumbing only
npm run cli -- activate --preset sdd            # core + the SDD workflow
npm run cli -- activate --skills graph-viz,github-pr --agents none
# Dependencies are auto-included (e.g. selecting the sdd-explore skill pulls its agent);
# switching to a smaller selection sweeps the now-stale host symlinks.

# Choose which AI hosts to link into (default: devin). Claude Code gets the skills as
# ~/.claude/skills/<name> and the agents as ~/.claude/agents/<name>.md (its native format).
# --hosts alone changes WHERE without touching the asset selection.
npm run cli -- activate --hosts devin,claude

# ── Build / query ───────────────────────────────────────────────────────────
# build the graph for a project (writes <dir>/.leina/graph.db + manifest)
npm run cli -- build <dir> [--json]          # --json also writes a portable graph.json
npm run cli -- build <dir> --profile         # stage timings (unchanged files reuse the extract cache)
npm run cli -- refresh <dir>                 # force a full rebuild

# diagnose health: node version, parser wasm assets, global share freshness, host symlinks,
# and the project (graph freshness, AGENTS.md/.gitignore/.devin wiring). Exits non-zero if
# any check fails. Read-only — never writes, never opens a DB file (it checks that DBs
# exist, not that they are internally sound).
npm run cli -- doctor [<dir>]
# auto-fix what doctor found: re-runs the idempotent install writers (global + repo wiring),
# scoped to prior installs; respects deinit; never touches DBs.
npm run cli -- repair [<dir>]

# inspect — query/affected/path auto-rebuild a stale graph before answering
npm run cli -- stats <dir>                    # node/edge counts + confidence breakdown
npm run cli -- status <dir>                   # freshness: is the graph stale vs the code?
npm run cli -- affected <dir> "<symbol>"     # blast radius: who depends on it
npm run cli -- path <dir> "<a>" "<b>"        # shortest path between two symbols
npm run cli -- query <dir> "a question"      # term-scored subgraph

# memory — persist and recall the *why*
# Global DB: ~/.leina/memory.db (honoring $LEINA_HOME), keyed by project.
# Always-on: no init required — any directory works, even ones without a git repo.
npm run cli -- memory save <dir> --title "..." --content "..." [--type decision] [--topic key] [--anchors a,b]
npm run cli -- memory update <dir> <id> [--title ..] [--content ..] [--type ..]
npm run cli -- memory search <dir> "a question" [--type ..] [--limit N]
npm run cli -- memory verified <dir> "a question"   # drift-classified: USABLE / WARNING / DO-NOT-USE
npm run cli -- memory get <dir> <id>
npm run cli -- memory context <dir>
npm run cli -- memory session <dir> --content "..." [--title "..."]
npm run cli -- memory session-start <dir> [--title "..."]
npm run cli -- memory suggest-topic <dir> --title "..." [--type ..]
npm run cli -- memory current-project <dir>         # show derived project key + detection method
npm run cli -- memory merge-projects <dir> --from <old-key> --to <new-key> [--dry-run]
npm run cli -- memory migrate <dir>                 # fold legacy per-repo memory.db into global DB
# Portable memory: decisions travel WITH the repo (no server). `sync` merges the committable
# snapshot .leina/memory-export.jsonl both ways; export/import move JSONL between machines.
npm run cli -- memory sync <dir>                    # absorb + rewrite the snapshot; commit it
npm run cli -- memory export <dir> --out mem.jsonl / memory import <dir> --in mem.jsonl
# memory scopes: --scope project (default) | personal | workspace | path | skill | process |
#                technology | security | infra   (search defaults to project; pass --scope to widen)

# ── MCP server (dual transport) ───────────────────────────────────────────────
# The same capabilities, as MCP tools over stdio. Register ONCE at user scope and the
# tools are available in every project (each tool takes `root`, defaulting to the
# workspace the host launched the server in). Skills/AGENTS.md are transport-neutral:
# agents prefer the mcp__leina__* tools when the host exposes them, else the CLI.
# Tools mirror the capability registry: graph_query/affected/path/stats/build/status/
# visualize, impact_analyze, memory_add/search/verified/context/get/update/
# suggest_topic/session (batch via items[]/ids[]), context_build, audit_run, doctor_run.
# Graph tools build the graph on first use; per-repo consent=disabled blocks tool calls.
# CLI-only by design: env exec (names-not-values contract).
npm run cli -- mcp                             # stdio server (hosts launch this)
npm run cli -- mcp register                    # USER-GLOBAL: Claude Code / Cursor / Windsurf
npm run cli -- mcp status                      # read-only per-host registration state
npm run cli -- mcp unregister                  # inverse of register
npm run cli -- activate --mcp                  # or register as part of install/setup
npm run cli -- init <dir> --mcp                # PROJECT-LEVEL .mcp.json (committable, teams)
# manual registration for any host:  command "leina", args ["mcp"]

# ── Env store (variables for skills that call services) ──────────────────────
# Global store at ~/.leina/.env (0600, plain text). NAMES-NOT-VALUES contract:
# an AI agent only ever handles variable names — values enter via hidden TTY prompt
# (or piped stdin for scripts), listings are masked, --reveal requires a real
# terminal, and `env exec` injects values process-to-process so a skill can call an
# authenticated service without the credential ever entering the model context.
npm run cli -- env set MY_SERVICE_TOKEN        # prompts (hidden); or: echo "$V" | ... env set KEY
npm run cli -- env list                         # names + masked values
# (single quotes: the CHILD shell expands the var — the parent never sees the value)
npm run cli -- env exec --only MY_SERVICE_TOKEN -- sh -c 'curl -H "Authorization: Bearer $MY_SERVICE_TOKEN" https://api...'
npm run cli -- env unset MY_SERVICE_TOKEN
# The bundled `authenticated-api` skill is the canonical worked example (SonarQube GET +
# POST, and the stricter argv-free variants: curl -K - via stdin, or a script consuming
# process.env). See assets/skills/authenticated-api/SKILL.md.

# ── Validation & contracts ────────────────────────────────────────────────────
npm run cli -- doctor [<dir>] [--json]       # health report; --json includes repoIdentity + confidence
npm run cli -- verify [<dir>] [--json]       # same checks, exit 1 on fail (CI gate)
npm run cli -- capabilities list [--json]    # the 6 transport-agnostic capabilities + schemas

# ── Impact / audit / events ───────────────────────────────────────────────────
npm run cli -- impact analyze <dir> "<symbol>" [--json]   # code→test→config→service blast radius
npm run cli -- audit <dir> [--format md|json|html]        # source→sink candidate paths + findings[]
npm run cli -- events tail <dir> [--json]                 # local event outbox (off by default)

# ── Visualize / multi-repo workspaces ─────────────────────────────────────────
npm run cli -- visualize <dir> [--out <path>]             # interactive offline HTML graph viewer
npm run cli -- workspace build <dir>                      # merged graph across member repos
npm run cli -- workspace status|detect <dir>              # per-member freshness / detection JSON
npm run cli -- workspace memory context|search <dir>      # federated memory across members
npm run cli -- workspace visualize <dir> [--drilldown]    # constellation (repos as super-nodes)

# ── Sidecars (Java / C# compiler-grade extraction) ─────────────────────────────
npm run cli -- sidecar status                # are the C#/Java sidecars configured?
npm run cli -- sidecar install csharp        # download a prebuilt binary (sha256-verified) — no toolchain needed
npm run cli -- sidecar verify java           # verify against a fixture (honest skip if no toolchain)

# ── SCIP indexers (Go and beyond — compiler-grade via third-party binaries) ────
npm run cli -- scip status                  # is scip-go on PATH?
npm run cli -- scip install go              # detect+instruct only — prints the install command
npm run cli -- scip verify go               # verify against a fixture (honest skip if not installed)
```

Ejemplo (ejecutado contra el propio `src/` de este repo):

```bash
npm run cli -- build src
npm run cli -- affected src "GraphStore"
#   openStore()  [references]  cli/index.ts:L48
```

> **Referencia completa de comandos:** [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md)
> documenta cada comando, sus flags, qué imprime y el punto de entrada de la implementación
> detrás de él.
>
> **Cómo funciona (guía conceptual):** [`docs/concepts/`](docs/concepts/README.md) explica el
> funcionamiento interno — grafo, memoria, búsqueda, drift y hooks — con diagramas y
> storytelling (en español).
>
> **Recorrido guiado, estilo preguntas y respuestas (en español):**
> [`docs/guides/usage-guide.md`](docs/guides/usage-guide.md) cubre el mismo terreno que este
> README y `GETTING_STARTED.md` desde un ángulo de "qué le puedo pedir a la IA", más un
> recorrido SDD completo — una buena opción para compañeros de equipo menos fluidos con la CLI.
>
> **Toda la documentación, bilingüe, en tu navegador:** una vez publicada, la documentación
> completa del proyecto (este README, las guías de arriba, la referencia de la CLI, el roadmap
> y más) también está disponible como un único sitio buscable con un selector EN/ES — ver
> [`docs/README.md`](docs/README.md) para el índice completo o generarlo localmente con
> `npm run docs:site:build`.

### Entrada por lotes (stdin JSON)

`memory save`, `memory update` y `memory get` aceptan `--batch`: un array JSON en stdin
condensa N escrituras/lecturas en un solo proceso. `save`/`update` también aceptan `--atomic`
para una transacción de todo o nada.

```bash
echo '[{"title":"a","content":"x"},{"title":"b","content":"y"}]' \
  | npm run cli -- memory save <dir> --batch --atomic
echo '["id1","id2"]' | npm run cli -- memory get <dir> --batch
```

### Freshness

`query` / `affected` / `path` pasan por un **freshness gate**: si las fuentes cambiaron desde
el último build, el grafo se reconstruye antes de responder (postura `auto`, la
predeterminada). Bajo la postura `refuse`, una lectura obsoleta te indica que corras
`refresh` en su lugar. `status` reporta el estado de freshness sin reconstruir; `refresh`
fuerza una reconstrucción.

> 📘 **Setup y ciclo de vida.** Cada comando de instalación es **reversible** y nada actúa en
> un repo sin consentimiento. Hay tres capas, cada una con un inverso explícito:
>
> - **Máquina, de una sola vez:** `setup` ⟷ `disable`. `setup` es el comando "mágico" —
>   ejecuta `activate` (share global en `~/.leina/share/{skills,agents,workflows}`,
>   symlinkeado en `~/.config/devin/{skills,agents}`, más el grant user-global `Exec(leina)` +
>   hooks) y activa el centinela **blanket** a nivel de máquina (`~/.leina/.blanket`).
>   `disable` deshace todo eso (strip-inverse — preserva entradas de terceros; sin depender de
>   `.bak`).
> - **Global, granular:** `activate` ⟷ `deactivate` (la mitad global de `setup`, sin el
>   centinela blanket). `install-global` es un alias en desuso de `activate`.
> - **Repo, granular:** `init` ⟷ `deinit`.
>
> **Consentimiento tri-estado (por repo, local y git-ignored — `.leina/consent`):**
> `unknown` (sin flag) → el gate de Devin permanece en silencio y la skill `leina-setup`
> pregunta una vez ("¿usar leina acá?"); `enabled` → leina actúa (inyección de memoria +
> grafo, advisories, auto-reparación de grafo bajo demanda en `SessionStart`); `disabled` →
> no-op silencioso permanente.
>
> **`init` es adaptativo** (`isBlanketActive()`): siempre escribe el flag de consentimiento
> `enabled` + `.gitignore`. Bajo blanket, eso es todo (**LIGHT** — el share/grant/hooks a
> nivel de máquina ya cubren el repo). Standalone (sin blanket) también escribe un bloque de
> protocolo committable en `AGENTS.md`, `.devin/hooks.v1.json`, y un grant `Exec`
> **repo-local** en `.devin/config.json` (**FULL**) — nunca el config user-global.
> `init --name <project-name>` fija la project key en un `.leina/config.json` committable;
> `init --build` construye el grafo de forma sincrónica ahora mismo (de lo contrario, el grafo
> se construye bajo demanda). `deinit` escribe `disabled` y el strip-inverse elimina los
> bloques/grant/hooks gestionados del repo.

### memory CLI: batch + anchors

`memory save` resuelve `--anchors a,b` a nodes reales del grafo para que `memory verified`
pueda más tarde re-chequear cada observación guardada contra el grafo vivo (detección de
drift). Pasá `--topic <key>` para evolucionar una entrada existente en su lugar en vez de
crear un duplicado.

## Memory y detección de drift

El grafo contiene estructura; no puede contener el *por qué* de una decisión. La capa de
memory sí lo hace — decisiones, causas raíz de bugs y descubrimientos persisten entre
sesiones.

**Almacenamiento global siempre activo.** La memory se guarda en una única DB global en
`~/.leina/memory.db` (o `$LEINA_HOME/memory.db`), indexada por una **project key estable**
derivada automáticamente de la URL del remoto de git, el nombre base de la raíz del repo, o
el nombre del directorio. No se requiere `init` — `memory save` funciona en cualquier
directorio. Usá `memory current-project <dir>` para inspeccionar la key derivada. Fijala de
forma permanente con `init --name <name>` (escribe `.leina/config.json`, committable, tiene
prioridad sobre todos los pasos de detección).

El aislamiento entre proyectos se aplica por project key: un `memory search` en el repo A
nunca devuelve resultados del repo B.

Lo que la hace más que un archivo de notas: una observación puede **anclarse** (anchor) a
nodes del grafo (los símbolos de los que habla). Cuando el código cambia, `memory verified`
re-chequea cada resultado contra el grafo vivo y lo etiqueta como **USABLE**, **WARNING** (el
código anclado se movió — obsoleto), o **DO-NOT-USE** (una afirmación normativa que el código
ahora contradice). Una memory que silenciosamente se vuelve incorrecta es peor que no tener
memory; la detección de drift es lo que mantiene confiable el contexto recuperado.

**Migración desde el layout viejo por repo.** Si tenés un `<dir>/.leina/memory.db` de una
versión anterior, corré `leina memory migrate <dir>` para incorporarlo a la DB global. El
archivo original queda intacto. `leina doctor <dir>` advierte si hay una DB legacy presente.

## Lenguajes

| Lenguaje | Extracción | Precisión |
|---|---|---|
| **TypeScript, TSX** | **ts-morph** (API del compilador de TS, en proceso) | **nivel compilador — 100% resuelto, 0 conjeturas** |
| JavaScript, Go, Python, Java, C#, Kotlin, Rust, Ruby, PHP | tree-sitter (WASM) + resolución guiada por imports | sintáctico |
| Go (opcional) | indexador SCIP (`scip-go`) | nivel compilador |
| Java, C# (opcional) | sidecar semántico (Roslyn / JavaParser) | nivel compilador |

**Escalera de precisión.** Todo lenguaje arranca en tree-sitter (sintáctico, siempre
disponible, sin configuración); una capa opcional de nivel compilador puede mejorarlo aún
más, en el orden **tree-sitter → indexador SCIP → ts-morph/sidecar semántico**. El ts-morph de
TypeScript y los sidecars de Java/C# corren en proceso o como binarios construidos por leina;
un indexador SCIP (`scip-go` hoy) es un binario de terceros que instalás vos mismo — el mismo
contrato "nivel compilador si está presente, fallback sintáctico si no", solo que para
herramientas que leina no posee. Ver [indexadores SCIP](#scip-indexers-go-and-beyond) más
abajo.

**Estrategia de resolución.** Cada llamada/referencia se resuelve a su destino con una
escalera de confianza:
- **TypeScript** pasa por el type checker real (ts-morph) — overloads, imports, re-exports y
  generics se resuelven exactamente. Sin AMBIGUOUS.
- **Otros lenguajes** usan tree-sitter con dos heurísticas apiladas:
  1. **Resolución guiada por imports** — `import { make } from "./auth"` prueba que una
     llamada a `make()` apunta a ese módulo (EXTRACTED, desambiguado por la ruta del módulo).
  2. **Inferencia de tipo del receptor** (Java/C#) — rastrea el tipo declarado de fields,
     `this`, parámetros y locals (incl. `var x = new Foo()`), de modo que `x.m()` se resuelve
     al método de la clase correcta en lugar de adivinar entre homónimos.

> ⚠️ **Nota Java/C#:** entre ~15% (Java) y ~23% (C#) de los edges de llamada quedan
> AMBIGUOUS y se descartan del blast radius. C# queda atrás porque `var` proveniente de
> retornos de método y las cadenas LINQ/extension necesitan inferencia de tipos real. Los
> edges estructurales (`extends`, `implements`, `contains`) y las referencias de clase son
> confiables. El sidecar semántico eleva la precisión de llamadas a nivel compilador.

### Escalera de confianza

Cada edge de llamada/referencia está etiquetado para que el asistente sepa qué fue probado y
qué fue adivinado:

- `EXTRACTED` — match único en el mismo archivo, o resuelto por el compilador vía el sidecar.
- `INFERRED` — heurística de nombre único entre archivos.
- `AMBIGUOUS` — múltiples candidatos; se conserva el primero y se **marca** (no se descarta
  silenciosamente).

## Sidecars semánticos (C# y Java)

tree-sitter es sintáctico: ve una llamada a `bar` pero no siempre puede saber *cuál* `bar`.
Para C# y Java delegamos a un front-end de compilador real — Roslyn para C#, el symbol
solver de JavaParser para Java — de modo que las llamadas entre archivos, overloads,
generics y herencia se resuelven al símbolo exacto y los edges quedan probados por el
compilador (`EXTRACTED`).

### El código fuente se distribuye como templates, construidos bajo demanda

Los **fuentes** del sidecar no se commitean como archivos `.cs`/`.java` — se distribuyen
como texto `.tmpl` inerte bajo `assets/sidecars/**`. Eso mantiene este repo como un proyecto
puro de TypeScript/Node (así un pipeline de calidad estrictamente TypeScript nunca tropieza
con código fuente de otro lenguaje), mientras los templates siguen viajando dentro del
paquete npm publicado.

Cuando un repo destino efectivamente contiene archivos Java/C#, construí el sidecar una vez:

```bash
leina sidecar build          # build whatever the local toolchain supports
leina sidecar build csharp   # or a single language
leina sidecar status         # show what's built + which tools are missing
```

Esto materializa los templates e invoca el toolchain local, y luego cachea un binario
autocontenido (C#: archivo único; Java: una app-image de jpackage con un JRE embebido) bajo
`~/.leina/sidecars/<lang>/dist`. Los builds de grafo subsiguientes lo reutilizan — correr el
binario cacheado no necesita .NET/JVM instalados.

`leina build` también puede construir el sidecar implícitamente en el primer uso cuando lo
activás con `LEINA_BUILD_SIDECARS=1`; de lo contrario, imprime un aviso de una línea y cae a
tree-sitter. Si un sidecar no está construido, ese lenguaje degrada a tree-sitter
automáticamente — el grafo igual se construye, solo que de forma sintáctica.

Sobreescribí el binario auto-detectado (o apuntá a uno prebuilt) con una variable de entorno:

```bash
export LEINA_CSHARP_SIDECAR="/path/to/RoslynGraph"
export LEINA_JAVA_SIDECAR="/path/to/JavaGraph"
```

### Requisitos de build (solo al construir un sidecar)

Construir requiere el toolchain del lenguaje en el PATH; correr el binario cacheado no.

- **C#** → el .NET SDK (`dotnet`). Los mirrors NuGet privados/enterprise funcionan vía el
  `NuGet.config` habitual.
- **Java** → un JDK 17+ que incluya `jpackage`, más `curl` (descarga los jars de
  JavaParser). Apuntá a un mirror de Maven con `LEINA_MAVEN_BASE`. Ver
  `assets/sidecars/java/README.md` para los pasos subyacentes.

Ambos sidecars corren **una vez sobre todo el proyecto** (no por archivo) de modo que el
compilador construye un modelo y resuelve llamadas entre archivos. El sidecar de Java infiere
las raíces de código fuente a partir de las declaraciones de package, así que los layouts
multi-módulo se resuelven correctamente. Ver `src/infrastructure/extractors/semantic/sidecar.ts`
para el contrato JSON. GraalVM `native-image` (binario Java de archivo único), un modo Roslyn
consciente de `.sln` y Eclipse JDT son mejoras futuras.

## Indexadores SCIP (Go y más allá)

[SCIP](https://sourcegraph.com/docs/scip) es un formato de índice de inteligencia de código
de nivel compilador basado en protobuf, con un indexador por lenguaje (`scip-go`,
`scip-python`, `rust-analyzer`, ...). A diferencia de los sidecars de C#/Java de arriba —
binarios propiedad de leina construidos a partir de templates que distribuye — un indexador
SCIP es una **herramienta de terceros que instalás vos mismo** vía el gestor de paquetes
propio de ese lenguaje; leina solo lo detecta y, una vez presente, lo usa para extracción de
nivel compilador. Nunca descarga, construye ni auto-instala uno.

```bash
leina scip status            # is scip-go on PATH?
leina scip install go        # detect+instruct only — prints the install command, never runs it
leina scip verify go         # verify against a fixture (honest skip if the indexer is missing)
```

Hoy esto cubre Go vía [`scip-go`](https://github.com/scip-code/scip-go):

```bash
go install github.com/scip-code/scip-go/cmd/scip-go@latest
```

Una vez que `scip-go` está en el `PATH`, `leina build`/`refresh` mejoran automáticamente los
archivos `.go` de tree-sitter a nivel compilador: el indexador corre una vez sobre todo el
proyecto (el mismo contrato whole-project que los sidecars), el índice `.scip` resultante se
transmite Document por Document mediante un parser de protobuf hecho a mano (sin dependencia
nueva — `src/infrastructure/extractors/semantic/scip-proto.ts`), y cada símbolo SCIP se traduce
al MISMO id de grafo que tree-sitter/ts-morph produciría para ese símbolo, así que nada se
duplica — se fusiona. Sin el indexador, la extracción de Go queda sin cambios (tree-sitter,
sintáctica); nada más del build se ve afectado.

## Estructura del proyecto

Layout hexagonal — `domain` (tipos + ports) ← `application` (casos de uso) ← `infrastructure`
(adapters) ← `cli` (driving adapter):

```
src/
├── domain/          graph/{model,ports} · memory/{model,ports} · install/artifact · shared/{batch,id}
├── application/     graph/{build,query,manifest,sources,resolve,detect,dedup} · memory/{query,anchor-verify}
│                    · project/detect-key · install/{agents,command,devin-hooks,devin-skills,migrate,permissions,port,protocol,gitignore} · activate
├── infrastructure/  sqlite/{graph-store,memory-repository,schema} · extractors/{treesitter,semantic/*}
│                    · config/freshness · install/{global,share-paths,symlinks,native-assets,shell,safe-exec}
├── cli/             index (dispatcher) · wiring (composition root) · handlers/{graph,memory,install,system}
│                    · args · io · doctor · agent-gate · active-context
└── version.ts
```

## Estado

Validado de punta a punta sobre fixtures para los 7 lenguajes y sobre repos reales de código
abierto:

| Repo | Lenguaje | Nodes | EXTRACTED |
|---|---|---|---|
| [zod](https://github.com/colinhacks/zod) | TS (ts-morph) | 2.2k | **100%** |
| [gson](https://github.com/google/gson) | Java | 4.4k | 78% |
| [jackson-core](https://github.com/FasterXML/jackson-core) | Java | 5.7k | 77% |
| [Dapper](https://github.com/DapperLib/Dapper) | C# | 2.2k | 72% |
| [Newtonsoft.Json](https://github.com/JamesNK/Newtonsoft.Json) | C# | 9.2k | 69% |
| [Polly](https://github.com/App-vNext/Polly) | C# | 5.8k | 65% |

TypeScript es de nivel compilador (ts-morph). Para Java/C#, se apilan tres técnicas
sintácticas — resolución guiada por imports, luego **inferencia de tipo del receptor**
(fields, `this`, parámetros y locals: `JsonReader in` → `in.nextString()` resuelve a
`JsonReader`). Java llega a 77–78% EXTRACTED; C# queda atrás con 65–72% porque depende de
`var` proveniente de retornos de método y cadenas LINQ/extension-method que solo un type
checker real (el sidecar) puede seguir.

El dogfooding sobre estos repos sacó a la luz y corrigió varios bugs de extracción reales
(métodos receiver de Go, expresiones `new`, herencia de tipos genéricos, colisiones entre
nombres de constructor/clase). Los typechecks están limpios (`npx tsc --noEmit`); la suite de
tests de la CLI (`npm test`) pasa.

## Roadmap

1. ✅ Capa de grafo.
2. ✅ Módulo `memory` — decisiones/bugs persistentes (el *por qué* que el grafo no puede
   contener), con detección de drift anclada al grafo.
3. ✅ Flujo de trabajo `sdd` — las fases de diseño y tareas acotan el impacto con
   `leina affected` antes de decidir, integrado en el protocolo siempre activo (`AGENTS.md`).
   Devin obtiene las fases de SDD como perfiles de subagente personalizados (un AGENT.md por
   fase) y una skill delegadora por fase, más una skill orquestadora `leina-sdd` que conduce
   el flujo completo — todo instalado globalmente por `leina activate`.
4. Clustering / god-nodes para codebases muy grandes.

## Licencia

[MIT](LICENSE) © Alejandro Alfonzo
