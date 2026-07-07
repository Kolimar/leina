# Registro de cambios

Todos los cambios notables de este proyecto se documentarán en este archivo.

El formato se basa en [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
y este proyecto sigue [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

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
