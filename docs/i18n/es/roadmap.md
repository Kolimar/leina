# Hoja de ruta

En qué se enfoca leina a continuación, en orden. Basado en una lectura honesta de dónde
la herramienta es fuerte (blast radius determinista, memoria con verificación de drift,
instalación sin fricción) y dónde todavía no lo es. Los ítems pasan al changelog cuando
se publican — este archivo nunca hace propaganda del pasado.

## Publicado

- **Servidor MCP** — `leina mcp` (stdio): el registro de capacidades como herramientas MCP;
  `init --mcp` lo registra en el `.mcp.json` del proyecto. La CLI sigue siendo el
  transporte principal (más económico en tokens).
- **CI en todos los sistemas operativos** — matriz Linux/macOS/Windows × Node 22/24;
  flujo de release con procedencia (provenance) verificada.
- **Kotlin, Rust, Ruby, PHP** vía tree-sitter (11 lenguajes en total).
- **Memoria de proyecto portable** — `memory export/import/sync` con un snapshot
  `.leina/memory-export.jsonl` versionable y merge determinista.
- **Hook gate neutral respecto al host** — `agent-hook` + `init --claude-hooks` escribe
  hooks de Claude Code en `.claude/settings.json`; un único gate sirve tanto a Devin
  como a Claude Code.
- **Cache de extracción incremental** — reutilización por archivo basada en hash de
  contenido para todos los lenguajes de tree-sitter; `build --profile` muestra los
  tiempos por etapa.
- **Puntuación de consultas por palabra** — subtokens camelCase/snake_case en ambos
  lados del match, que cierra la mayor parte del "vocabulary gap" sin usar embeddings.
- **Arnés de benchmarks** — `npm run bench` (docs/benchmarks).
- **Sidecars semánticos preconstruidos** — `sidecar install <lang>`: descargas verificadas
  con sha256 de un binario por plataforma publicado por CI, sin necesitar .NET/JDK local;
  `sidecar build <lang>` sigue siendo la alternativa con toolchain local.

## Próximo (alcance y profundidad)

- **Puerto de proveedor de embeddings** — búsqueda semántica opt-in detrás de un puerto
  de comando externo (modelo local / API de host); nunca una dependencia nativa dura.
- **Estrategia incremental de ts-morph** — el profile muestra que el type-check de TS
  domina los rebuilds en repos con mucho TS; investigar la reutilización de programa
  sin perder precisión.
- **Tablas de benchmarks para repos públicos** — números de zod/gson/Dapper,
  re-medidos y enviados como PR.
- Clustering / manejo de god nodes para grafos muy grandes.

## No-objetivos

- Sin dependencia de la nube. El outbox de eventos local sigue siendo la costura para
  una futura sincronización **opt-in**.
- Sin pasos de compilación nativa ni scripts de instalación — las instalaciones deben
  seguir funcionando en todos lados con pnpm/bun/`--ignore-scripts`.
- Sin bajar el piso de Node ≥ 22.13: es lo que permite `node:sqlite` sin dependencias
  nativas, y Node 20 dejó de tener mantenimiento en abril de 2026.
