# leina

[![GitHub](https://img.shields.io/badge/GitHub-Kolimar%2Fleina-181717?logo=github)](https://github.com/Kolimar/leina)
[![CI](https://github.com/Kolimar/leina/actions/workflows/ci.yml/badge.svg)](https://github.com/Kolimar/leina/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@kolimar/leina)](https://www.npmjs.com/package/@kolimar/leina)
[![node](https://img.shields.io/node/v/@kolimar/leina)](#requisitos)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<details>
<summary><strong>Contenido</strong></summary>

- [Por qué un grafo (y no solo vector RAG)](#por-qué-un-grafo-y-no-solo-vector-rag)
- [Requisitos](#requisitos)
- [Uso](#uso)
  - [Consola interactiva](#consola-interactiva)
  - [Inicio rápido](#inicio-rápido)
  - [Build / consulta](#build--consulta)
  - [Memory](#memory)
  - [Servidor MCP](#servidor-mcp-transporte-dual)
  - [Env store](#env-store-variables-para-skills-que-llaman-a-servicios)
  - [Validación y contratos](#validación-y-contratos)
  - [Impact / audit / events](#impact--audit--events)
  - [Visualización / workspaces multi-repo](#visualización--workspaces-multi-repo)
  - [Sidecars](#sidecars-extracción-de-nivel-compilador-para-java--c)
- [Memory y detección de drift](#memory-y-detección-de-drift)
- [Lenguajes](#lenguajes)
- [Sidecars semánticos (C# y Java)](#sidecars-semánticos-c-y-java)
- [Indexadores SCIP](#indexadores-scip-go-y-más-allá)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Estado](#estado)
- [Roadmap](#roadmap)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

</details>

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
```

> ¿Contribuís a leina o querés correr lo último sin publicar? Trabajás desde un clon en vez de la instalación global — el setup de desarrollo (`git clone`, `npm install`, `npm run cli -- <cmd>`) está en [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

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

Estos ejemplos usan la forma de instalación global `leina <command>`. ¿Trabajás desde un clon (contribuidores)? Usá `npm run cli -- <command>` — mirá [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

### Consola interactiva

Todo lo de abajo también está disponible por menús: install/update (elegir grupos de
assets), init/deinit del repo actual, estado de salud, repair, variables de env, desinstalar.

```bash
leina tui
```

### Inicio rápido

Un comando, una vez por máquina: el setup "mágico" (share global + symlinks + grant
`Exec` user-global + hooks, y activa el modo blanket). `--hosts` es obligatorio — elegí
los hosts de instalación (`devin`, `claude`). Eso es todo — leina queda disponible en
cada sesión de los hosts elegidos (y, vía MCP, cualquier otro host que registres — ver
[MCP server](#mcp-server-dual-transport)).

```bash
leina setup --hosts devin,claude
# Undo everything machine-wide at any time:
leina disable
```

Por proyecto: no hay nada que recordar. Bajo blanket mode, la skill leina-setup pregunta
una vez por repo ("¿usar leina acá?") y corre init/deinit por vos. Cada repo tiene un flag
de consentimiento local, git-ignored: unknown -> pregunta una vez, enabled -> activo,
disabled -> silencioso. El grafo se construye bajo demanda la primera vez que se consulta.
También podés cablear un repo a mano:

Un `init` standalone es **FULL** y exige `--hosts` y `--profile devin|windsurf`; bajo blanket
un `init` es **LIGHT** y no necesita ninguno.

```bash
leina init <dir> --hosts devin --profile devin          # standalone FULL (under blanket, plain `leina init <dir>` is LIGHT)
leina init <dir> --hosts devin --profile devin --build  # also build the graph synchronously now
leina init <dir> --hosts devin --profile devin --mcp    # also add a project-level .mcp.json
leina init <dir> --hosts claude --profile devin         # wire Claude Code hooks
leina init <dir> --hosts devin --profile devin --claude-hooks  # force Claude Code hooks even without the claude host
leina deinit <dir>                                       # opt this repo out (consent=disabled) + strip wiring
```

¿Preferís las piezas granulares? Componen lo que hace `setup` y cada una tiene un
inverso: `activate` ⟷ `deactivate` (share/symlinks/config user-global; sin blanket).

Elegí QUÉ skills/agentes incluidos instalar (ver `assets/catalog.json` para la lista
completa, grupos y dependencias). Omití los flags de selección para mantener tu elección
previa; el default es full. Las dependencias se incluyen automáticamente (por ejemplo, elegir
la skill sdd-explore trae su agente); pasar a una selección más chica limpia los symlinks
de host que quedaron obsoletos.

```bash
leina activate --hosts devin --preset minimal        # core plumbing only
leina activate --hosts devin --preset sdd            # core + the SDD workflow
leina activate --hosts devin --skills graph-viz,github-pr --agents none
```

Elegí a qué hosts de IA conectarte con `--hosts` (obligatorio; sin default). Claude Code
recibe las skills como `~/.claude/skills/<name>` y los agentes como
`~/.claude/agents/<name>.md` (su formato nativo). `--hosts` solo cambia DÓNDE, sin tocar la
selección de assets.

```bash
leina activate --hosts devin,claude
```

### Build / consulta

```bash
# build the graph for a project (writes <dir>/.leina/graph.db + manifest)
leina build <dir> [--json]          # --json also writes a portable graph.json
leina build <dir> --profile         # stage timings (unchanged files reuse the extract cache)
leina refresh <dir>                 # force a full rebuild

# diagnose health: node version, parser wasm assets, global share freshness, host symlinks,
# and the project (graph freshness, AGENTS.md/.gitignore/.devin wiring). Reports each check as
# ok / info / warn / fail (optional/N-A grouped in a final info section). Informative — never
# changes its exit code; read-only, never writes, never opens a DB file. Use `verify` for a CI gate.
leina doctor [<dir>]
# auto-fix what doctor found: re-runs the idempotent install writers (global + repo wiring),
# scoped to prior installs; respects deinit; never touches DBs.
leina repair [<dir>]

# inspect — query/affected/path auto-rebuild a stale graph before answering
leina stats <dir>                    # node/edge counts + confidence breakdown
leina status <dir>                   # freshness: is the graph stale vs the code?
leina affected <dir> "<symbol>"     # blast radius: who depends on it
leina path <dir> "<a>" "<b>"        # shortest path between two symbols
leina query <dir> "a question"      # term-scored subgraph
```

### Memory

Base de datos global: `~/.leina/memory.db` (respetando `$LEINA_HOME`), indexada por
proyecto. Siempre activa: no requiere init — cualquier directorio funciona, incluso sin
repo de git.

```bash
leina memory save <dir> --title "..." --content "..." [--type decision] [--topic key] [--anchors a,b]
leina memory update <dir> <id> [--title ..] [--content ..] [--type ..]
leina memory search <dir> "a question" [--type ..] [--limit N]
leina memory verified <dir> "a question"   # drift-classified: USABLE / WARNING / DO-NOT-USE
leina memory get <dir> <id>
leina memory context <dir>
leina memory session <dir> --content "..." [--title "..."]
leina memory session-start <dir> [--title "..."]   # open a session at session start
leina memory suggest-topic <dir> --title "..." [--type ..]
leina memory current-project <dir>         # show derived project key + detection method
leina memory merge-projects <dir> --from <old-key> --to <new-key> [--dry-run]
leina memory reanchor <dir> <id>           # re-resolve an observation's anchors against the live graph
leina memory export <dir> [--out file.jsonl]       # dump observations + anchors as JSONL
leina memory import <dir> [--in file.jsonl]        # merge an export; newer revision wins
leina memory sync <dir>                            # two-way merge with .leina/memory-export.jsonl
# memory scopes: --scope project (default) | personal | workspace | path | skill | process |
#                technology | security | infra   (search defaults to project; pass --scope to widen)
```

### Servidor MCP (transporte dual)

Las mismas capabilities, como MCP tools sobre stdio. Registralo UNA VEZ a nivel de
usuario y las tools quedan disponibles en cada proyecto (cada tool toma `root`, que por
defecto es el workspace donde el host lanzó el server). Skills/AGENTS.md son neutrales
al transporte: los agentes prefieren las tools `mcp__leina__*` cuando el host las
expone, si no usan la CLI. Las tools reflejan el registro de capabilities:
`graph_query/affected/path/stats/build/status/visualize`, `impact_analyze`,
`memory_add/search/verified/context/get/update/suggest_topic/session` (batch vía
`items[]`/`ids[]`), `context_build`, `audit_run`, `doctor_run`. Las tools de grafo
construyen el grafo en el primer uso; `consent=disabled` por repo bloquea las llamadas.
Solo CLI por diseño: `env exec` (contrato nombres-no-valores).

```bash
leina mcp                                             # stdio server (hosts launch this)
leina mcp register --hosts claude,cursor,windsurf     # USER-GLOBAL; --hosts is required
leina mcp register --hosts cursor                     # configurá solo el/los host(s) que usás
leina mcp status                                      # read-only per-host registration state
leina mcp unregister --hosts cursor                   # inverse of register
leina activate --hosts claude --mcp --mcp-hosts claude   # or register as part of install/setup
leina init <dir> --hosts devin --profile devin --mcp     # PROJECT-LEVEL .mcp.json (committable, teams)
```

**Cualquier host compatible con MCP funciona** — `leina mcp register` auto-configura Claude Code,
Cursor y Windsurf; para el resto, agregás el server a la config MCP propia de ese host a mano. El
comando de lanzamiento es siempre el mismo (`command: "leina"`, `args: ["mcp"]`); la mayoría usa el
entry estándar `mcpServers`:

```json
{ "mcpServers": { "leina": { "command": "leina", "args": ["mcp"] } } }
```

Algunos usan otra envoltura — **VS Code** (`.vscode/mcp.json`, clave `servers`, con `"type":"stdio"`),
**OpenAI Codex CLI** (`~/.codex/config.toml`, `[mcp_servers.leina]`), **Zed** (`context_servers`,
`"source":"custom"`) — más **Gemini CLI**, **LM Studio**, **Cline** y **JetBrains AI Assistant /
Junie** en la forma estándar. Mirá [`docs/GETTING_STARTED.md`](../../GETTING_STARTED.md#7-connect-it-to-your-ai)
para la tabla por host (ubicación de la config + comando exacto). Como MCP es universal — y la
inyección de contexto por hooks se limita a Devin y Claude Code — **MCP es la forma recomendada de
conectar cualquier otro host.**

### Env store (variables para skills que llaman a servicios)

Store global en `~/.leina/.env` (0600, texto plano). Contrato NOMBRES-NO-VALORES: un
agente de IA solo maneja nombres de variables — los valores entran vía prompt de TTY
oculto (o stdin para scripts), los listados quedan enmascarados, `--reveal` requiere una
terminal real, y `env exec` inyecta valores proceso a proceso para que una skill llame a
un servicio autenticado sin que la credencial entre nunca al contexto del modelo.

```bash
leina env set MY_SERVICE_TOKEN        # prompts (hidden); or: echo "$V" | ... env set KEY
leina env list                         # names + masked values
# (single quotes: the CHILD shell expands the var — the parent never sees the value)
leina env exec --only MY_SERVICE_TOKEN -- sh -c 'curl -H "Authorization: Bearer $MY_SERVICE_TOKEN" https://api...'
leina env unset MY_SERVICE_TOKEN
```

La skill incluida `authenticated-api` es el ejemplo de referencia (SonarQube GET y POST,
y las variantes más estrictas sin argv: `curl -K -` vía stdin, o un script que consume
`process.env`).

### Validación y contratos

```bash
leina doctor [<dir>] [--json]       # health report; --json includes repoIdentity + confidence
leina verify [<dir>] [--json]       # same checks, exit 1 on fail (CI gate)
leina capabilities list [--json]    # the 17 transport-agnostic capabilities + schemas
```

### Impact / audit / events

```bash
leina impact analyze <dir> "<symbol>" [--json]   # code→test→config→service blast radius
leina audit <dir> [--format md|json|html]        # source→sink candidate paths + findings[]
leina events tail <dir> [--json]                 # local event outbox (off by default)
```

### Visualización / workspaces multi-repo

```bash
leina visualize <dir> [--out <path>]             # interactive offline HTML graph viewer
leina graph serve <dir> [--port 7423]            # live local server (multi-project + memory)
leina workspace build <dir>                      # merged graph across member repos
leina workspace status|detect <dir>              # per-member freshness / detection JSON
leina workspace memory context|search <dir>      # federated memory across members
leina workspace visualize <dir> [--drilldown]    # constellation (repos as super-nodes)
```

> `visualize` escribe un **archivo `.html` estático y compartible** de un proyecto. `graph serve`
> es otra cosa: un **server local en vivo** (read-only, `:7423`, Ctrl+C) con selector
> multi-proyecto y la memoria anclada de cada nodo — mismo visor, herramienta distinta. Tabla
> comparativa en el paso 4 de [`getting-started`](../../GETTING_STARTED.md#4-see-your-code-as-a-graph).

### Sidecars (extracción de nivel compilador para Java / C#)

```bash
leina sidecar status                # are the C#/Java sidecars configured?
leina sidecar install csharp        # download a prebuilt binary (sha256-verified) — no toolchain needed
leina sidecar verify java           # verify against a fixture (honest skip if no toolchain)
```

### Indexadores SCIP (referencia rápida)

```bash
leina scip status                  # is scip-go on PATH?
leina scip install go              # detect+instruct only — prints the install command
leina scip verify go               # verify against a fixture (honest skip if not installed)
```

Ejemplo:

```bash
leina build <your-project>
leina affected <your-project> "GraphStore"
#   openStore()  [references]  db/connection.ts:L48
```

> **Referencia completa de comandos:** [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md)
> documenta cada comando, sus flags, qué imprime y el punto de entrada de la implementación
> detrás de él.
>
> **Cómo funciona (guía conceptual):** [`docs/concepts/`](docs/concepts/README.md) explica el
> funcionamiento interno — grafo, memoria, búsqueda, drift y hooks — con diagramas y
> storytelling. Escrita primero en español — hay [traducción al inglés](docs/i18n/en/concepts/README.md)
> disponible para compartir con compañeros que no lean español.
>
> **Recorrido guiado, estilo preguntas y respuestas:**
> [`docs/guides/usage-guide.md`](docs/guides/usage-guide.md) (español;
> [traducción al inglés](docs/i18n/en/usage-guide.md)) cubre el mismo terreno que este
> README y `GETTING_STARTED.md` desde un ángulo de "qué le puedo pedir a la IA", más un
> recorrido SDD completo — una buena opción para compañeros de equipo menos fluidos con la CLI.
>
> **Toda la documentación, bilingüe, en tu navegador:** [kolimar.github.io/leina](https://kolimar.github.io/leina/)
> aloja la documentación completa del proyecto (este README, las guías de arriba, la
> referencia de la CLI, el roadmap y más) como un único sitio buscable con un selector
> EN/ES — ver [`docs/README.md`](docs/README.md) para el índice completo o generarlo
> localmente con `npm run docs:site:build`.

### Entrada por lotes (stdin JSON)

`memory save`, `memory update` y `memory get` aceptan `--batch`: un array JSON en stdin
condensa N escrituras/lecturas en un solo proceso. `add`/`update` también aceptan `--atomic`
para una transacción de todo o nada.

```bash
echo '[{"title":"a","content":"x"},{"title":"b","content":"y"}]' \
  | leina memory save <dir> --batch --atomic
echo '["id1","id2"]' | leina memory get <dir> --batch
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
>   centinela blanket).
> - **Repo, granular:** `init` ⟷ `deinit`.
>
> **Consentimiento tri-estado (por repo, local y git-ignored — `.leina/consent`):**
> `unknown` (sin flag) → el gate de Devin permanece en silencio y la skill `leina-setup`
> pregunta una vez ("¿usar leina acá?"); `enabled` → leina actúa (inyección de memoria +
> grafo, advisories, auto-reparación de grafo bajo demanda en `SessionStart`); `disabled` →
> no-op silencioso permanente.
>
> **`init` es adaptativo**: siempre escribe el flag de consentimiento `enabled` + `.gitignore`.
> Bajo blanket, eso es todo (**LIGHT** — el share/grant/hooks a nivel de máquina ya cubren el
> repo; no hacen falta flags). Standalone (sin blanket) es **FULL** — exige `--hosts` y
> `--profile devin|windsurf`, y también escribe un bloque de protocolo committable en
> `AGENTS.md`, `.devin/hooks.v1.json`, y un grant `Exec` **repo-local** en `.devin/config.json`
> — nunca el config user-global.
> `init --name <project-name>` fija la project key en un `.leina/config.json` committable;
> `init --build` construye el grafo de forma sincrónica ahora mismo (de lo contrario, el grafo
> se construye bajo demanda). `deinit` escribe `disabled` y el strip-inverse elimina los
> bloques/grant/hooks gestionados del repo.

### memory CLI: batch + anchors

`memory save` resuelve `--anchors a,b` a nodes reales del grafo para que `memory verified`
pueda más tarde re-chequear cada observación guardada contra el grafo vivo (detección de
drift). Pasá `--topic <key>` para evolucionar una entrada existente en su lugar en vez de
crear un duplicado.

### Servidor explorador del grafo (`graph serve`)

```bash
leina graph serve <dir> [--port 7423] [--host 127.0.0.1]
```

Un servidor `node:http` read-only y en foreground (sin dependencias nuevas) sobre el mismo grafo +
memoria anclada que el resto de la CLI: una API JSON (`/api/projects`, `.../stats`, `.../tree`,
`.../search`, `.../nodes/:id`, `.../nodes/:id/memories`) más una pequeña UI exploradora en JS
vanilla — selector de proyectos, chips por kind de nodo/arista, un árbol de carpetas y un drawer de
detalle con `declaredBy`/`invokedBy` y memorias con badge de drift. Bindea estrictamente a loopback
y auto-registra el proyecto en `~/.leina/projects.json` (el mismo registro que `build`/`refresh`/
`init` actualizan). Cortalo con Ctrl+C.

> No confundir con [`visualize`](#visualización--workspaces-multi-repo): eso exporta un **archivo
> `.html` estático y compartible** de un solo proyecto. `graph serve` es un **server en vivo** —
> selector multi-proyecto, memoria anclada por nodo, pero solo mientras corre.

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
herramientas que leina no posee. Ver [indexadores SCIP](#indexadores-scip-go-y-más-allá) más
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
  JavaParser). Apuntá a un mirror de Maven con `LEINA_MAVEN_BASE`.

Ambos sidecars corren **una vez sobre todo el proyecto** (no por archivo) de modo que el
compilador construye un modelo y resuelve llamadas entre archivos. El sidecar de Java infiere
las raíces de código fuente a partir de las declaraciones de package, así que los layouts
multi-módulo se resuelven correctamente. GraalVM `native-image` (binario Java de archivo
único), un modo Roslyn consciente de `.sln` y Eclipse JDT son mejoras futuras.

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
nueva), y cada símbolo SCIP se traduce
al MISMO id de grafo que tree-sitter/ts-morph produciría para ese símbolo, así que nada se
duplica — se fusiona. Sin el indexador, la extracción de Go queda sin cambios (tree-sitter,
sintáctica); nada más del build se ve afectado.

## Estructura del proyecto

leina sigue un layout hexagonal: **domain** (tipos + ports) ← **application** (casos de uso)
← **infrastructure** (adapters) ← **cli** (driving adapter). El core de dominio no depende de
detalles de framework, de modo que extractores, stores y transportes se conectan por los
bordes sin tocar la lógica central.

## Estado

Validado de punta a punta sobre repos reales de código abierto para 3 de los 11 lenguajes
soportados (TypeScript, Java, C# — los de extracción más pesada); los otros 8 están
cubiertos por la suite de fixtures (`npm test`):

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

## Contribuir

Issues y pull requests son bienvenidos — ver [`CONTRIBUTING.md`](CONTRIBUTING.md) para el
setup de desarrollo, la arquitectura en dos minutos y las pautas de PR. ¿Encontraste un
problema de seguridad? Ver [`SECURITY.md`](SECURITY.md) en vez de abrir un issue público.

## Licencia

[MIT](LICENSE) © Alejandro Alfonzo
