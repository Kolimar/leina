# Registro de cambios

Todos los cambios notables de este proyecto se documentarán en este archivo.

El formato se basa en [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
y este proyecto sigue [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [2.1.0] — Sin publicar

### Agregado
- **Subsistema harness (absorbido del `harness-framework` independiente).** Rules de ciclo de vida (intake → plan → execute → verify → deliver) con gates ejecutables, contracts de tarea controlados contra el diff real de git y sync multi-plataforma — ahora nativos de leina, sin dependencias nuevas (validadores propios en lugar de zod, front matter JSON en lugar de YAML, `safe-exec` en lugar de execa, matcher de globs propio calibrado contra picomatch).
  - `leina harness contract new|show|edit|end`, `verify`, `sync [--check|--force|--platforms]`, `list`, `hook <event>`.
  - 14 rules builtin en `assets/harness/rules/` (front matter JSON); las cuatro rules de leina (`memory-first`, `graph-consult`, `graph-fresh`, `session-summary`) vienen **activadas por defecto** — `leina init` arma `.harness/config.json`, corre un harness sync en el mismo proceso y deja el repo gobernado; `deinit` lo revierte usando el lockfile del sync.
  - **Enforcement en el agent gate** en workspaces confiados (ver *Confianza del workspace*): el sello de integridad aplica siempre; el control de scope, el guard de commit/push y el gate de Stop (tope de reintentos y después cesión honesta) aplican con un contract activo, en modo strict o cuando la config no se puede leer.
  - 5 capabilities nuevas en el registro (22 en total), expuestas como tools MCP: `harness_contract_new/show/end`, `harness_verify`, `harness_rules_list`.
  - `leina tui` → nuevo **flujo de harness**: entrevista guiada del contract (goal/scope/criterios), sugerencia de recipes, selección de rules con restricciones de no-debilitamiento y paneles de status/verify/sync.
  - Adapters de plataforma (bloques gestionados en CLAUDE.md / AGENTS.md, skills, cableado de hooks de Cursor/Windsurf/OpenCode vía `leina harness hook`) con el mismo formato de lockfile y marcadores que el framework independiente; en Claude Code/Devin el enforcement viaja por el agent gate de leina en lugar de hooks aparte.
- **Presets de rules.** `leina init --harness-preset generic|leina-native` siembra un `.harness/config.json` nuevo: `generic` desactiva las cuatro rules acopladas a leina para usar el harness sin adoptar el resto de leina; `leina-native` (default) conserva la suite completa.
- **Confianza del workspace.** Un registro fuera del repo (`$LEINA_HOME/trust/`, indexado por la ruta real del repo) que escribe `leina init` y borra `deinit`; todo camino automático del harness y todo gate ejecutable de capa project lo requieren. `leina doctor` lo informa.
- `leina memory compact <dir> [--keep N] [--sessions-older-than DAYS] [--dry-run]` — recolecta los snapshots superseded de cada topic (las filas vivas se conservan siempre), opcionalmente purga sesiones inactivas y después hace `VACUUM`.
- `leina query --json` (el flag se anunciaba pero no estaba implementado).

### Cambiado
- **El `root` de MCP queda confinado al workspace del server** — después de resolver symlinks; los roots de afuera se rechazan salvo que estén permitidos con `LEINA_MCP_ALLOW_ROOTS`. El `out` de `graph_visualize` se confina igual y tiene que terminar en `.html`.
- **`memory_context` por MCP devuelve previews por defecto** (`preview`, `truncated`, `contentChars` en lugar del `content` completo); `full: true` devuelve los cuerpos completos y `limit`/`sessionLimit` acotan el payload.
- `impact_analyze` por MCP resuelve `symbol` igual que la CLI y devuelve `{seed, impacted, note?}`; los argumentos numéricos de MCP son enteros acotados a límites fijos; `root` es opcional en todas las tools.
- Los hooks del harness, el verify desatendido y `harness_verify` por MCP no hacen nada en un workspace no confiado en esta máquina — corré `leina init` ahí una vez (también después de mover o re-clonar un repo). Un `.leina/consent` commiteado no otorga nada. Los hooks advisory del agent gate (inyección de memoria, self-heal del build en segundo plano) también requieren confianza.
- Config del harness: los overrides `rules.<id>` solo aceptan `enabled`/`severity` (una clave `gate` es un error); las capas user y local ya no pueden debilitar una rule bloqueante (desactivarla, bajarla de severidad ni cambiar su gate/phase/scope) ni bajar `strictness`; una config inválida hace que los hooks fallen cerrado.
- `harness verify`: solo las corridas completas actualizan el reporte que lee el guard de commit; un `--rule` desconocido, un flag sin valor o un subcomando desconocido salen con 2; fuera de git falla cerrado; los archivos cambiados son relativos a la raíz del harness (paquetes de monorepo); `--json` incluye `loadErrors`. `contract new --max-retries` tiene que estar entre 1 y 10, y `maxRetries` ahora cuenta bloqueos por cadena de Stop, con un verify nuevo en cada Stop.
- El guard de commit decide la frescura del reporte por el contenido del working tree (una huella que registra verify) en lugar de mtimes; los reportes de versiones anteriores cuentan como desactualizados.
- `harness sync --platforms` solo toca las plataformas nombradas (un id desconocido sale con 2); el sync compila solo las capas commiteadas (rules builtin + project + la config del proyecto); `init --hosts` conserva las plataformas ya sincronizadas o autodetectadas; `deinit` borra la config que escribió `init` mientras siga sin cambios.
- `memory import`/`sync` validan cada línea (tamaños, enums, formas; cualquier línea inválida hace fallar la corrida), recortan timestamps, omiten ids de otros proyectos y no resucitan snapshots compactados; `memory get`/`update` (CLI y MCP) solo ven los ids del proyecto actual.
- Se subió el rango de `@modelcontextprotocol/sdk` a `^1.32.1`.

### Seguridad
- Un repo clonado podía ejecutar código propio a través del harness sin `leina init`: con un override de `gate` en `.harness/config.json`, con un `.leina/consent` commiteado o con un módulo en la raíz del repo que tapaba un gate js builtin. Corregido con el store de confianza fuera del repo, rechazando los overrides de gate en la config y resolviendo los módulos por capa.
- Un `.harness/harness.lock.json` manipulado podía hacer que `deinit` / `sync --force` borraran o escribieran archivos fuera del repo; ahora las rutas del lockfile se validan y toda escritura o borrado se confina por ruta real.
- MCP: un symlink dentro del workspace escapaba del confinamiento de `root`, y `graph_visualize` podía sobreescribir cualquier archivo escribible por el usuario.
- `memory import`/`sync` de un `.leina/memory-export.jsonl` incluido en un repo podía sobreescribir memorias de otro proyecto (que después se inyectaban en las sesiones de ese proyecto); las búsquedas por id cruzaban proyectos.
- XSS almacenado en el visor offline del grafo a través de nombres de carpetas / claves de repo.
- Las regex que vienen de las rules (gates command, diff-content y file) corren con un timeout duro (ReDoS); las fallas de diff-content solo informan `archivo:línea` y un prefijo enmascarado, nunca el secreto detectado; el escaneo de archivos sin trackear nunca sigue symlinks; la rule no-secrets detecta más formas de credenciales.
- El agente no puede editar `$LEINA_HOME/harness` (rules del usuario) ni el store de confianza; el guard de integridad de pre-bash razona sobre destinos de escritura en lugar de menciones.
- El env store se escribe de forma atómica con permisos solo para el dueño.
- Se resolvieron todos los avisos de `npm audit` (stack express/hono/ajv transitivo del SDK de MCP, brace-expansion, js-yaml, undici, source-map-js).

### Corregido
- `graph_visualize` podía terminar todo el server MCP ante un grafo stale rechazado; las llamadas MCP concurrentes sobre un grafo stale lo reconstruían cada una (y `graph_stats` podía leer un grafo a medio escribir) — ahora los builds son single-flight por root.
- `impact_analyze` por MCP siempre devolvía vacío para un nombre de símbolo; `memory_verified` ignoraba `type`.
- Los archivos fuente de más de 4 MiB se omiten de forma consistente en el build y en el chequeo de freshness.
- El retrofit del índice NOCASE de labels ya no bloquea una lectura cuando otro proceso tiene el lock de escritura.
- `memory compact` informa una db bloqueada o un `VACUUM` fallido sin stack trace y no informa una db más grande mientras otro proceso la tiene abierta.
- `env set`/`unset` matchean las claves que acepta el parser (`KEY =valor`) y colapsan duplicados.
- Harness: la detección de commits y el guard de integridad manejan `&`, subshells y backticks; el modo strict y el sello de integridad ahora también aplican en Claude Code/Devin, y el hook de shell de Cursor toma la misma decisión que pre-bash; el plugin de OpenCode bloquea solo con exit status 2; `.harness/state/` se ignora solo; `hookCommand` tiene que ser una forma de lanzar leina; la TUI escribe los overrides de rules recién cuando se confirma el contract; deinit preserva el JSON del usuario tal cual y escribe de forma atómica.
- La ayuda raíz y la de `memory` mostraban `memory <dir> <sub>`; el dispatcher lee `memory <sub> <dir>`.
- Los tests ya no escriben en el `~/.leina` real del desarrollador.

### Rendimiento
- Un índice NOCASE de labels sirve la rama exacta de `findByLabel`; el gate de freshness y un rebuild disparado por staleness comparten un solo recorrido de fuentes.

### Documentación
- Referencia de la CLI (EN/ES): `memory compact`, `graph gc`, `query --json`, `init --harness-preset`, selección de assets en `setup`/`activate`, las reglas de confinamiento y argumentos de MCP, las reglas de import/sync de memoria, los límites del env store y el comportamiento del harness y la confianza.
- Capítulo 7 de conceptos (EN/ES): presets de rules, el mapa de vocabulario de hooks y gates, la confianza del workspace.
- Benchmarks: se corrigieron las afirmaciones sobre la caché en caliente y la escala del read path.

## [2.0.1] — 2026-07-09

### Corregido
- `repair` ya no aborta en un repo que trae evidencia de init commiteada (AGENTS.md / .gitignore) cuando la máquina no tiene una selección de host persistida. Ahora saltea el re-cableado del proyecto con una nota informativa y sigue corriendo sus fases restantes (shell-wrapper, doctor) — coherente con el contrato fail-open de repair, que nunca elige un host. `init` sigue exigiendo un `--hosts` explícito.

## [2.0.0] — 2026-07-08

### Cambiado
- **Selección de host explícita (breaking).** `setup`, `activate` e `init` ahora requieren `--hosts` explícito — leina no elige un host de IA por vos. Si falta, el comando muestra qué hosts detectó y se detiene.
- **Perfil de init explícito (breaking).** Un `leina init` completo ahora requiere `--profile devin|windsurf`.
- **Hosts MCP explícitos (breaking).** `--mcp` en `setup`/`activate` ahora requiere `--mcp-hosts`, y `leina mcp register` requiere `--hosts`.

### Agregado
- `graph gc` — elimina del registro global los proyectos que ya no existen.
- Lanzá el explorador de grafo de solo lectura directamente desde `leina tui`.
- `doctor` ahora reporta una severidad `info` para checks opcionales o no aplicables, con salida en color y los ítems info agrupados al final.

### Eliminado
- El comando `install-global` (usá `activate`), el flag `--agent` de init (usá `--profile`) y el comando `memory migrate`.

### Documentación
- Se actualizaron los docs en inglés y español para reflejar el CLI actual.

## [1.1.3] — 2026-07-07

### Documentación
- Se actualizó la sección de recall de recuperación del benchmark (EN + ES) para reflejar las
  aristas de referencia de anotaciones de tipo ya incorporadas al extractor. Los docs aún
  enmarcaban el recall solo-tipo como un punto ciego del 4.5% frente a 95.1% en valor; los
  snapshots actuales muestran **100% de recall en valor** y **98.2% en solo-tipo**. Se
  reescribieron las barras, la tabla y la narrativa — el ~2% residual es destructuring de
  import dinámico, registrado en el backlog.

## [1.1.2] — 2026-07-07

### Arreglado
- `--help` / `-h` después de un subcomando ya no se consume como el posicional `<dir>`. Los
  comandos que leen `<dir>` de su primer argumento (`status`/`stats`/`affected`/`path`/`query`)
  trataban `--help` como un directorio — una build anterior incluso creaba un `--help/.leina/graph.db`
  huérfano. Ahora el dispatcher intercepta `--help`/`-h` e imprime la ayuda, y esos handlers
  rechazan un token con `--` como directorio (igual que `build`/`refresh`/`serve`/`visualize`).
  Cubierto por un test de regresión de 10 casos.

### Documentación
- Se aclaró que `visualize` y `graph serve` son **herramientas distintas**, no dos formas de la
  misma vista: `visualize` exporta un archivo `.html` estático y compartible de un proyecto;
  `graph serve` levanta un server local en vivo con selector multi-proyecto y memoria anclada por
  nodo. Se agregó una tabla comparativa a la guía de primeros pasos, se listó `graph serve` en las
  herramientas visuales de la guía de uso (faltaba), y se cruzó-referenció en ambos sentidos en el
  README y la referencia de CLI — todo en los dos idiomas. También se tradujeron las secciones de
  `graph serve` que faltaban en el README y la referencia de CLI en español.

## [1.1.1] — 2026-07-07

### Arreglado
- `bin.leina` en `package.json` normalizado (`./dist/cli/index.js` → `dist/cli/index.js`),
  silenciando el warning que npm ya autocorregía al publicar. Sin cambio funcional.

### Documentación
- Se reorientó la documentación de instalación alrededor del **paquete publicado**. `readme.md`,
  `GETTING_STARTED.md` y la guía de uso ahora lideran con `npm install -g @kolimar/leina` +
  `leina tui` como camino principal (un Inicio rápido de tres comandos) y relegan el flujo desde
  un clon a `CONTRIBUTING.md`. Los ejemplos de "Uso" del README pasaron de la forma de clon
  `npm run cli -- <cmd>` a `leina <cmd>`.
- Nueva sección **"Conectalo a tu IA"** que documenta las dos superficies de integración: el
  **server MCP** universal (`leina mcp`, stdio) con una tabla de registro por host — Claude Code,
  Cursor, Windsurf (auto vía `leina mcp register`), más VS Code, OpenAI Codex CLI, Gemini CLI,
  LM Studio, Zed, Cline y JetBrains/Junie (manual, con la ubicación y el formato de config de cada
  host) — y la auto-inyección por **hooks**, ahora acotada explícitamente a Devin y Claude Code
  (los demás hosts llaman las tools MCP on-demand). Se corrigió la lista de hosts para enlace de
  assets a solo Devin y Claude Code (Cursor/Windsurf consumen MCP, no el share de skills/agents).
- Aplicado en ambos idiomas: `GETTING_STARTED.md` / `docs/i18n/es/getting-started.md`,
  `docs/guides/usage-guide.md` / `docs/i18n/en/usage-guide.md`, `readme.md` /
  `docs/i18n/es/index.md`.

## [1.1.0] — 2026-07-06

### Agregado
- **`leina graph serve`**: un servidor HTTP read-only en foreground (`node:http`, sin
  dependencias nuevas) que expone el grafo + la memoria anclada de un proyecto como una API JSON
  (`/api/projects`, `.../graph`, `.../stats`, `.../tree`, `.../search`, `.../nodes/:id`,
  `.../nodes/:id/memories`), más una UI exploradora en JS vanilla: el grafo completo se renderiza
  de entrada (layout de fuerza congelado tras estabilizar, tamaño de nodo por grado, etiquetas que
  aparecen al hacer zoom), con dropdown de búsqueda en vivo, chips de filtro por kind/relación
  (el estructural `contains` apagado por defecto), un árbol de carpetas colapsable, un drawer de
  nodo que lista cada relación incidente en ambas direcciones como grupos navegables, y tarjetas
  de memoria con badge de drift (título/fecha/preview, expandibles). Bindea estricto a loopback,
  admite un token de auth comparado en tiempo constante (`LEINA_SERVE_TOKEN`) y auto-registra el
  proyecto en un nuevo registro global (`~/.leina/projects.json`, también actualizado por
  `build`/`refresh`/`init`).
- **`leina memory reanchor`**: re-ancla conservadoramente observaciones existentes, extrayendo
  solo referencias explícitas a paths/símbolos de su texto y verificando cada candidato contra el
  grafo vivo antes de crear el ancla — los candidatos ambiguos o no resueltos se descartan. Aditivo
  e idempotente por `(observation_id, node_id)`; admite `--dry-run`.
- **Referencias de tipo + valor en el extractor ts-morph**: `affected` sub-reportaba el blast
  radius porque los dependientes solo-de-tipo (`import type`, anotaciones) y los símbolos importados
  usados como valor pero nunca llamados no producían aristas. Dos nuevas pasadas emiten aristas
  `references` probadas por el compilador — el recall solo-de-tipo subió de 4.5% a 98.2%, e
  interfaces como `GraphNode` (0 → 221 dependientes) y `GraphEdge` (0 → 198) dejaron de reportar
  "nada depende de esto".

## [1.0.1] — 2026-07-06

### Arreglado
- El acceso concurrente multi-proceso ya no falla intermitentemente con `SQLITE_BUSY`:
  `graph.db` y el `memory.db` global ahora se abren con un `busy_timeout` de 5s, y el
  constructor de GraphStore salta su DDL de esquema cuando la base ya está marcada con
  la versión actual (antes ejecutaba DDL de escritura en cada apertura, colisionando con
  un build concurrente). Cubierto por un test de regresión multi-proceso.
- Las claves de proyecto ya no se re-alojan silenciosamente cuando se agrega un git
  remote después de `init`: `init` ahora fija automáticamente la clave derivada en
  `.leina/config.json` (config-lock), y `memory current-project`/`search`/`context`
  imprimen una sugerencia accionable cuando la clave resuelta no tiene memorias pero
  una clave derivada anteriormente sí (por ejemplo, memorias guardadas bajo la clave del
  nombre de directorio antes de que existiera el remote), incluyendo el comando exacto
  de `memory merge-projects` para recuperarlas. Las escrituras con `--name` ahora son
  seguras para fusión (se preservan claves hermanas como `project_key_format`).
- El descubrimiento de fuentes del grafo ahora salta artefactos minificados con nombre
  convencional (`*.min.js`, `*.min.css`, …): un bundle vendoreado inundaba el grafo con
  nodos "god" de una sola letra sin sentido y lo re-envejecía en cada copia. El escáner
  cross-repo de workspace aplica el mismo filtro.
- El descubrimiento de fuentes del grafo ahora salta salidas de build de .NET (`obj/`,
  `bin/`): archivos generados (`*.g.cs`, `AssemblyInfo.cs`) se indexaban como fuentes,
  inflando el conteo de archivos y re-envejeciendo el grafo después de cada
  `dotnet build`. El escáner cross-repo de workspace también los salta, igualando la
  lista de exclusión del sidecar de Roslyn.

## [1.0.0] — 2026-07-05

Lanzamiento público inicial de **leina** — Linked Engineering Intelligence Network for Agents.

### Grafo
- Grafo de conocimiento de código consultable (SQLite vía `node:sqlite`, sin dependencias
  nativas) con una compuerta de frescura: `query`/`affected`/`path` se reconstruyen
  automáticamente cuando cambian las fuentes.
- **11 lenguajes**: TypeScript/TSX de grado compilador vía ts-morph; JavaScript, Go, Python,
  Java, C#, Kotlin, Rust, Ruby y PHP vía tree-sitter con resolución guiada por imports e
  inferencia de tipo de receptor; sidecars opcionales de Roslyn/JavaParser elevan Java/C# a
  grado compilador (`sidecar build` local, o `sidecar install` — binarios precompilados
  verificados con sha256).
- Caché de extracción por archivo (hash de contenido) para reconstrucciones incrementales;
  `build --profile` reporta tiempos por etapa. Puntuación de consultas por palabras
  (subtokens camelCase/snake_case).
- `impact analyze` (código→test→config→servicio), `audit` (alcanzabilidad
  origen→sumidero), federación de workspaces para checkouts multi-repositorio,
  visualizadores HTML sin conexión.

### Memoria
- Memoria de proyecto siempre activa (base de datos global indexada por una clave de
  proyecto estable) con **detección de drift** anclada al grafo: `memory verified`
  clasifica los recuerdos como USABLE / WARNING / DO-NOT-USE.
- **Memoria portable**: `memory export/import` (JSONL, fusión determinista) y
  `memory sync` con un snapshot versionable `.leina/memory-export.jsonl` — las decisiones
  viajan con el repositorio, sin servidor.

### Integración con agentes
- **Servidor MCP** (`leina mcp`, stdio): el registro de capacidades versionado (17
  contratos) expuesto como 19 herramientas; `init --mcp` lo registra en el `.mcp.json`
  del proyecto.
- Compuerta de hooks consultiva y neutral respecto al host (con alcance de consentimiento,
  nunca bloquea): Devin (`.devin/hooks.v1.json`) y Claude Code (`init --claude-hooks` →
  `.claude/settings.json`) comparten una misma compuerta; bloque de protocolo en
  `AGENTS.md` para cada host que lo lea.
- Enlace de assets multi-host (`activate --hosts devin,claude`) desde un share
  versionado, con instalación selectiva desde un catálogo (`--preset minimal|sdd|full`,
  `--skills`, `--agents`) y clausura de dependencias.
- Skills/agentes incluidos: flujo de trabajo SDD (spec→design→tasks, acotado por
  impacto), revisores, flujos de trabajo de PR, ayudas de documentación.

### Instalación y operación
- `setup` ⟷ `disable` de un solo paso; `activate` ⟷ `deactivate`, `init` ⟷ `deinit`
  granulares (LIGHT/FULL adaptativo, consentimiento tri-estado por repositorio, todos
  los escritores idempotentes y seguros para fusión).
- `doctor` (diagnóstico de solo lectura que incluye el piso de Node, los assets del
  parser WASM, los enlaces de host) y `repair` (vuelve a ejecutar los escritores
  idempotentes, respeta las exclusiones voluntarias, nunca toca las bases de datos).
- Consola interactiva `leina tui`; almacén de credenciales `leina env` bajo un contrato
  de nombres-no-valores (0600, listados enmascarados, inyección proceso a proceso con
  `env exec`).
- Compuerta de Node ≥ 22.13 al inicio con recomendaciones de gestor de versiones; sin
  scripts de instalación — instalaciones limpias con npm, pnpm, bun y
  `--ignore-scripts`.
- CI en Linux/macOS/Windows × Node 22/24; flujo de trabajo de publicación con
  procedencia certificada.
