# Registro de cambios

Todos los cambios notables de este proyecto se documentarán en este archivo.

El formato se basa en [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
y este proyecto sigue [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [1.0.0] — Sin publicar

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
- **Servidor MCP** (`leina mcp`, stdio): el registro de capacidades versionado (14
  contratos) expuesto como 15 herramientas; `init --mcp` lo registra en el `.mcp.json`
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
