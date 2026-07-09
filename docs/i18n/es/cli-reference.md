# leina — Referencia de la CLI

Esta es la referencia canónica de la interfaz de línea de comandos `leina`: cada
comando, sus flags y qué imprime.

**leina expone una interfaz de línea de comandos.** Cada comando opera sobre un
`<dir>` explícito (por defecto `.`) y corre en un proceso de vida corta.

- **Invocación:** `leina <command> [args]`.
- **Graph DB:** `<dir>/.leina/graph.db` (por proyecto, git-ignored).
- **Memory DB:** `~/.leina/memory.db` (global, indexada por la project key derivada).

---

## Comandos de grafo

Todos los comandos de lectura (`query`, `affected`, `path`) pasan por la **freshness gate**:

- fresh → se sirve tal cual;
- stale + posture `auto` → reconstruye y luego sirve (imprime una nota `rebuilding ...` en stderr);
- stale + posture `refuse` → falla e indica que corras `refresh`.

La posture se configura por proyecto (`.leina/config.json`, clave `freshness`).

### `build <dir> [--json]`
Construye el grafo de `<dir>` en `.leina/graph.db`. Con `--json`, además exporta un
dump node-link a `.leina/graph.json`. Imprime el recuento de nodes/edges/archivos.

### `refresh <dir>`
Fuerza una reconstrucción ahora mismo, ignorando la freshness.

### `status <dir>`
Reporta la freshness (`fresh`/`STALE` + motivo), la posture, la hora del último build y el
recuento de archivos rastreados. No reconstruye.

### `stats <dir>`
Imprime el recuento de nodes, el recuento de edges y un desglose de confianza de edges.

### `query <dir> <question>`
Subgrafo puntuado por términos para una pregunta en texto libre. Imprime los seeds resueltos
y las edges `source --relation--> target` del subgrafo.

### `affected <dir> <label> [depth]`
Blast radius — qué depende (transitivamente, hasta `depth`, por defecto 3) del símbolo que
matchea `<label>`. **Ejecutá esto antes de renombrar o migrar un símbolo.** Imprime cada
dependiente con su relation y su ubicación de origen.

### `path <dir> <from> <to>`
Camino de dependencia más corto entre dos símbolos. Imprime cada salto como
`--relation(confidence)--> node`.

### `impact analyze [<dir>] <symbol> [--json]`
**Análisis de impacto** de primer nivel: un BFS bidireccional desde el node que matchea
`<symbol>` sobre el conjunto de impact relations (code relations ∪ infra relations
`deploys|reads|configures|exposes`), categorizando cada node alcanzado en
`{files, tests, services, configs}`. Cruza code→test→config→service a través de **edges
reales del grafo** (por ejemplo, un service de `docker-compose` cuyo `build.context` apunta
a un módulo emite una edge `reads` hacia ese node de código). Con `--json` imprime
`{"impacted":{"files":[…],"tests":[…],"services":[…],"configs":[…]}}`; siempre sale con
código 0 (un symbol desconocido produce una forma vacía). Pasa por la freshness gate igual
que las demás lecturas de grafo.

### `visualize <dir> [--out <path>] [--drilldown] [--single|--workspace]`
Exporta un visor de grafo HTML interactivo y autocontenido (vis-network incluido inline,
offline) a `<path>` (por defecto: `<dir>/.leina/graph.html`). Los nodes se colorean y agrupan
por carpeta/layer de nivel superior (leyenda legible: `domain`, `application`,
`infrastructure`, `cli`, …) y se dimensionan por el grado bidireccional no-`contains`. Los 12
god nodes principales se etiquetan y listan en la HUD sidebar. Las edges INFERRED se
renderizan como líneas punteadas. **Al hacer clic en un node se abre un drawer lateral
derecho** con su detalle estructurado (label, kind, layer, file, degree, signature y la
Louvain community detectada como dato) — no hay tooltip al pasar el mouse. El HTML también
incluye búsqueda, filtros por carpeta, un toggle de freeze de física y un botón de
fit-to-view. La Louvain community se calcula y persiste durante el build y se muestra como
dato en el drawer.

Pasa por la **freshness gate** (igual que `query`/`affected`):
- stale + posture `auto` → reconstruye automáticamente antes de exportar;
- stale + posture `refuse` → falla con la instrucción de correr `leina refresh <dir>`.

Al tener éxito imprime: `Exported graph.html ({N} nodes, {E} edges) -> {outPath}`.

> **`visualize` vs `graph serve`:** no son intercambiables. `visualize` es un **archivo `.html`
> estático** de un solo proyecto (sin memoria, sin server); `graph serve` es un **server local en
> vivo** con selector multi-proyecto y la memoria anclada de cada nodo, que corre solo mientras el
> proceso está arriba. Mismo visor, herramienta distinta — tabla comparativa en el paso 4 de
> [`getting-started`](../../GETTING_STARTED.md#4-see-your-code-as-a-graph).

**Workspace-aware:** si `<dir>` es la raíz de un workspace (ver *Comandos de workspace* más
abajo), se evita la freshness gate de repo único (rompería el grafo fusionado) y la
exportación usa en su lugar el store de workspace fusionado. El render por defecto es modo
**constellation** (cada repo como super-node, edges entre repos); pasá `--drilldown` para el
grafo fusionado completo coloreado por repo. `--single` / `--workspace` invalidan la
autodetección.

### `graph serve [<dir>] [--port <n>] [--host <h>]`
Levanta un servidor HTTP **read-only, en foreground** (`node:http`, sin dependencias de framework)
que expone el grafo + la memoria anclada de `<dir>` como una API JSON, más una UI exploradora en JS
vanilla en `/` (el mismo visor `vis-network` vendoreado que `visualize`). Pasa por la misma freshness
gate que las otras lecturas del grafo antes de arrancar, y auto-registra `<dir>` en el registro
global de proyectos (`~/.leina/projects.json`) — el mismo registro que `build`/`refresh`/`init`
actualizan de forma oportunista, que alimenta el selector de proyectos de la UI.

La config resuelve **port → host → token** con una precedencia de 3 niveles (env >
`.leina/config.json` clave `"serve"` > defaults): `LEINA_SERVE_PORT`/`LEINA_SERVE_HOST`/
`LEINA_SERVE_TOKEN`, con default a port `7423`, host `127.0.0.1`, sin token. El bind es
**estrictamente loopback** — un valor de `--host`/config/env no-loopback se rechaza antes de que el
servidor bindee. Si hay un token configurado, los requests sin token coincidente reciben `401`; la
comparación es de tiempo constante.

API JSON (todo read-only; no-GET → `405`; los errores son `{"error":{"code","message"}}`):

| Método | Path | Notas |
|---|---|---|
| GET | `/api/projects` | todos los proyectos del registro global |
| GET | `/api/projects/:key/stats` | conteos de nodos/aristas por kind y por relación |
| GET | `/api/projects/:key/tree` | árbol de carpetas/archivos para el selector de proyectos |
| GET | `/api/projects/:key/search?q=` | búsqueda por label |
| GET | `/api/projects/:key/nodes/:id` | detalle de nodo + aristas `declaredBy`/`invokedBy` |
| GET | `/api/projects/:key/nodes/:id/memories?limit=` | últimas observaciones ancladas, clasificadas por drift |

Corre en **foreground** hasta Ctrl+C (`SIGINT` cierra cada conexión abierta y libera el puerto — sin
proceso zombie).

> **`graph serve` vs `visualize`:** no son intercambiables. `visualize` exporta un **archivo `.html`
> estático y compartible** de un solo proyecto; `graph serve` es un **server en vivo** (selector
> multi-proyecto + memoria anclada por nodo) que corre solo mientras el proceso está arriba.

---

## Comandos de workspace (multi-repo)

`leina workspace <build|status|detect|memory|visualize> [dir]` opera sobre un **workspace
multi-repo**: un directorio marcado por un `workspace.json` en su raíz, o que contiene ≥2
subdirectorios inmediatos con `.git` (el source se reporta como `flag` / `workspace.json` /
`child-git-auto` / `git-root`). Los flags `--single` / `--workspace` invalidan la detección.
Un workspace está stale cuando **cualquier** repo miembro está stale.

### `workspace build [dir] [--json]`
Construye el grafo de cada repo miembro y el store de workspace fusionado. Con `--json`
también exporta `<dir>/.leina/workspace-graph.json` (dump node-link del grafo fusionado).
Imprime los recuentos fusionados de nodes/edges.

### `workspace status [dir]`
Reporta el modo detectado; en modo workspace lista cada miembro como
`[fresh|STALE] <repoKey> (<dir>)`.

### `workspace detect [dir] [--single|--workspace]`
Imprime el resultado de la detección como JSON: `{mode, source, members[]}`.

### `workspace memory context [dir]` / `workspace memory search [dir] <query>`
**Memoria federada** entre todos los repos miembro: `context` muestra las sesiones y
observaciones recientes de cada miembro; `search` corre una búsqueda de texto completo sobre
las observaciones de todos los miembros (límite 20).

### `workspace visualize [dir] [--out <path>] [--drilldown]`
Equivalente a `visualize <dir> --workspace` (ver arriba).

---

## Comandos de memoria

`leina memory <sub> <dir> [flags]`. La memoria vive en la DB **global**
(`~/.leina/memory.db`), particionada por la project key derivada del git remote / la raíz / el
nombre del directorio del repo. La resolución de anchors está respaldada por el grafo, con
verificación de drift.

Si la project key es ambigua (múltiples repos git), los comandos fallan con una indicación
de crear `.leina/config.json` con `{"project_name":"<name>"}`.

Valores de `--type` de observación: `decision`, `bugfix`, `discovery`, `pattern`,
`architecture`, `config`, `manual` (por defecto). `--scope` es uno de nueve valores —
`project` (por defecto), `personal`, `workspace`, `path`, `skill`, `process`, `technology`,
`security`, `infra`. Search/`verified` usan por defecto `--scope project`; pasá un `--scope`
explícito para recuperar observaciones guardadas bajo los scopes más ricos. El schema de la
DB migra de forma idempotente.

### `memory save <dir> --title "..." --content "..." [--type t] [--topic key] [--scope s] [--anchors a,b]`
Guarda (o hace upsert de) una observación. Pasar `--topic <key>` evoluciona la entrada
existente con ese topic en su lugar (imprime `evolved rev N`); en caso contrario crea una
nueva. `--anchors` es una lista separada por comas de símbolos del grafo sobre los que trata
la observación (se resuelven contra el grafo vivo al guardar).

**Batch:** `memory save <dir> --batch [--atomic]` lee desde stdin un array JSON de
`{title, content, type?, topicKey?, scope?, anchors?}`.

### `memory update <dir> <id> [--title ..] [--content ..] [--type ..] [--anchors a,b]`
Actualiza una observación in place por id, incrementando su revisión.
**Batch:** `--batch [--atomic]` lee desde stdin un array JSON de
`{id, title?, content?, type?, anchors?}`.

### `memory search <dir> <query> [--type t] [--scope s] [--limit N]`
Búsqueda de texto completo (límite por defecto 10). Imprime `#id [type] [topic] title` más
un snippet por hit.

### `memory verified <dir> <query> [--type t] [--scope s] [--limit N]`
Búsqueda **más clasificación de drift** contra el grafo vivo. Agrupa los resultados en
`USABLE` / `WARNING` / `DO NOT USE` con un motivo por hit. Preferí este comando sobre `search`
cuando estés por actuar sobre contexto recordado. Si el grafo no está disponible, los
veredictos degradan a no verificados (igual se imprimen).

### `memory get <dir> <id>`
Imprime la observación completa (title, type, topic_key, timestamps, revision, content).
**Batch:** `memory get <dir> --batch` lee desde stdin un array JSON de strings de id.

### `memory context <dir> [--limit N]`
Sesiones recientes + últimas observaciones del proyecto. **Ejecutá esto al inicio de cada
sesión** para restaurar decisiones previas.

### `memory session <dir> --content "summary" [--title "..."]`
Guarda un resumen de sesión. Ejecutar al **final** de una sesión.

### `memory session-start <dir> [--title "..."]`
Abre una sesión al inicio, para agrupar las observaciones posteriores.

### `memory suggest-topic <dir> --title "..." [--type t]`
Sugiere un `topic_key` normalizado para un title, más near-matches con topics existentes.
Usalo antes de `add --topic` para evitar topics duplicados.

### `memory current-project <dir>`
Imprime el `project_key` derivado, el `method` de detección y el nombre crudo — sin acceso a
la DB. Útil para depurar fallas de proyecto ambiguo.

### `memory merge-projects <dir> --from <key> --to <key> [--dry-run]`
Mueve/fusiona todas las observaciones de una project key a otra (por ejemplo, tras un rename
del remote). `--dry-run` reporta qué se movería.

### `memory reanchor <dir> <id>`
Vuelve a resolver los anchors de una observación contra el grafo vivo, actualizando a qué
nodes apunta después de que el código se movió o cambió de nombre.

### `memory export <dir> [--out file.jsonl]`
Vuelca las observaciones + anchors de este proyecto como JSONL (a `--out` o a stdout).

### `memory import <dir> [--in file.jsonl]`
Fusiona un export desde stdin (o `--in file.jsonl`); gana la revisión más nueva.

### `memory sync <dir>`
Merge bidireccional con un snapshot commiteable `.leina/memory-export.jsonl`.

---

## Audit, findings y artifacts

`leina audit [<sub>] [dir] [flags]` corre un análisis de rutas candidatas source→sink sobre
el grafo (posiblemente fusionado). La salida es **evidencia para triage** — rutas
candidatas de flujo de datos, nunca vulnerabilidades confirmadas (siempre se imprime un
banner de disclaimer). El audit pack lleva `schemaVersion` y un array `findings[]`.

### `audit [dir] [--format md|json|html] [--json] [--from <id,...>] [--max-pack-kb <N>]`
Corre el audit y lo renderiza. El format elige el renderer:
- sin `--format` → el texto UX humano;
- `--format md` → reporte Markdown a stdout;
- `--format json` (o el alias `--json`) → `AuditPack` legible por máquina a stdout,
  incluyendo `findings[]` (`Finding` = `{severity, evidence, relatedNodes, suggestedActions,
  confidence}`) y `schemaVersion`;
- `--format html` → escribe un `audit-graph.html` offline y autocontenido (roles
  source/sink, rutas candidatas, lista de rutas clickeable).

`--from <id,...>` invalida los entry points; `--max-pack-kb <N>` limita el tamaño del pack
JSON. Emite un evento `audit.completed` (ver Events) tras escribir el pack.

### `audit catalog|reachability|pack|visualize [dir] [flags]`
Subcomandos de audit multi-repo / workspace: `catalog` (repos/nodes/edges agrupados por
repo), `reachability --from <id,...> [--backward]` (conjunto alcanzable desde los entry
points), `pack` (reporte completo = catalog + reachability), `visualize` (subgrafo de audit
en HTML offline). Corré `leina workspace build` primero para tener un grafo a nivel workspace
fresco.

---

## Events (outbox local)

Un **event outbox** local de solo-append registra domain events (`schemaVersion: 1`). Está
**apagado por defecto** — stdout/UX no cambian a menos que optés por activarlo.

### `events tail [dir] [--json]`
Imprime los eventos más recientes del outbox. Con `--json` imprime los objetos JSONL crudos
del evento. Cuando la persistencia está apagada, imprime una indicación para activarla.

**Activar la persistencia:** seteá `LEINA_EVENTS_PERSIST=1`. Los eventos se agregan entonces
como JSONL a `~/.leina/events/outbox.jsonl` y se emiten tras operaciones exitosas de
`graph.built`, `audit.completed` y `memory.created`. Los payloads se mantienen libres de
contenido sensible; el outbox es la costura desde la cual una futura sincronización cloud
opt-in podría drenar — hoy no existe ninguna dependencia de nube.

---

## Env store (nombres, no valores)

`leina env <sub>` gestiona credenciales de servicio para skills que llaman a servicios
autenticados, bajo el **contrato names-not-values**: un agente de IA solo maneja *nombres*
de variables — los valores nunca viajan por argv, el contexto del modelo ni el stdout
capturado. El almacenamiento es un `~/.leina/.env` global (0600, texto plano). `env list`
advierte si los permisos del archivo son legibles por grupo/otros.

### `env set <KEY>`
Guarda un valor. Interactivo: prompt oculto en la TTY (el input no se hace echo).
No interactivo: primera línea del stdin canalizado (`echo "$V" | leina env set KEY`). Nunca
vía argv — argv queda en el historial de la shell y en las transcripciones del agente. Los
nombres de key deben matchear `[A-Za-z_][A-Za-z0-9_]*`.

### `env list`
Imprime los nombres de variables guardadas con valores **enmascarados**.

### `env get <KEY> [--reveal]`
Enmascarado por defecto. `--reveal` imprime el valor plano **solo cuando stdout es una TTY
real** — un agente que esté conduciendo no puede capturarlo canalizándolo; el comando falla
con una indicación hacia `env exec`.

### `env unset <KEY>`
Elimina la variable.

### `env exec [--only K1,K2] -- <cmd...>`
Corre `<cmd>` con las variables guardadas inyectadas en su entorno (todas, o solo el subset
de `--only`). El secreto viaja **de proceso a proceso**: con comillas simples, la shell
*hija* expande la variable y el proceso padre (y el modelo) nunca ven el valor:

```bash
leina env exec --only MY_TOKEN -- sh -c 'curl -H "Authorization: Bearer $MY_TOKEN" https://api...'
```

Sale con el código de salida del hijo.

---

## Comandos de sidecar (extracción Java / C# de precisión de compilador)

`leina sidecar [build|install|status|clean|verify] [csharp|java] [--force]` gestiona los sidecars
opcionales de compilador bajo demanda. Sin sidecar, Java/C# igual se extraen vía tree-sitter
(SYNTACTIC — call edges best-effort); el sidecar agrega precisión de compilador.

- `sidecar status` — reporta si cada sidecar está configurado y si el toolchain está presente.
- `sidecar install [csharp|java]` — descarga un binario de sidecar precompilado y verificado con
  sha256 desde los release assets y lo cachea (no requiere toolchain local de .NET/JDK);
  `sidecar build` es la alternativa con toolchain local.
- `sidecar build <csharp|java>` — construye el sidecar (necesita el toolchain local: dotnet
  SDK para C#; JDK 17+ con `jpackage` para Java).
- `sidecar clean [csharp|java]` — elimina los sidecars construidos.
- `sidecar verify <java|csharp>` — verifica el extractor contra un fixture mínimo.
  **Skip honesto**: si falta el toolchain imprime `<lang>: skip — …` y sale con `0` (nunca una
  falla espuria); con el toolchain presente corre una extracción normal y reporta `ok`/`fail`
  más un `VerificationCheck`.

---

## Comandos SCIP (ingesta de precisión de compilador vía indexadores de terceros)

`leina scip [status|verify|install] [go]` detecta/verifica/instruye la instalación de
**binarios de indexadores SCIP de terceros** (SCIP = [protocolo SCIP](https://sourcegraph.com/docs/scip),
un formato de índice de code intelligence de precisión de compilador). A diferencia de los
sidecars C#/Java de arriba — que leina construye y empaqueta él mismo a partir de templates —,
los indexadores SCIP (por ejemplo, `scip-go`) son herramientas que el USUARIO instala mediante
el package manager de su propio lenguaje; leina nunca descarga, construye ni autoinstala uno.
Sin un indexador, el lenguaje igual se extrae vía tree-sitter (SYNTACTIC); un indexador
disponible eleva ese lenguaje a precisión de compilador, por delante de tree-sitter en el
orden de extractores.

- `scip status [go]` — reporta si cada indexador SCIP se encuentra en `PATH` (o vía su
  override de env), imprimiendo el comando de instalación en caso contrario.
- `scip install [go]` — **solo detecta + instruye**: imprime el comando para instalar el
  indexador (por ejemplo, `go install github.com/scip-code/scip-go/cmd/scip-go@latest`);
  nunca descarga ni ejecuta nada en nombre del usuario.
- `scip verify [go]` — verifica el extractor contra un fixture mínimo. **Skip honesto**: si no
  se encuentra el indexador imprime `<lang>: skip — …` y sale con `0` (nunca una falla
  espuria); con el indexador presente corre un indexado + parseo real y reporta `ok`/`fail`
  más el recuento de nodes/edges.

El extractor SCIP (id `scip-<lang>`, por ejemplo `scip-go`) corre a nivel de proyecto
completo: invoca al indexador contra la raíz del proyecto, transmite el índice protobuf
`.scip` resultante Document por Document, y traduce cada symbol SCIP a un id de grafo leina
idéntico al que producirían tree-sitter/ts-morph para el mismo symbol, así que nada se
duplica — se fusiona. La salida `.scip` siempre cae en un directorio efímero de `os.tmpdir()`
que se elimina inmediatamente tras leerse — nunca bajo la raíz del proyecto. Si al indexador
le falta, falla, o produce un índice parcial/corrupto, reporta errores no fatales y no reclama
nada, dejando que tree-sitter procese esos archivos.

---

## MCP server y tools (transporte dual)

Cada capacidad de lectura/escritura se expone dos veces: como los comandos de CLI de arriba
**y** como MCP tools servidas por `leina mcp` (stdio). Ambos transportes llaman a los mismos
casos de uso a través del registro de capacidades, así que no pueden divergir. Los agentes
deberían preferir las MCP tools cuando el host las expone (JSON estructurado, sin round-trip
de shell); cada tool toma un `root` opcional — el argumento `<dir>` de la forma CLI (por
defecto: el cwd en el que el host lanzó el server, es decir, la raíz del workspace).

| CLI | MCP tool | Notas |
|---|---|---|
| `query` | `graph_query` | construye el grafo en el primer uso |
| `affected` | `graph_affected` | |
| `path` | `graph_path` | |
| `stats` | `graph_stats` | |
| `status` | `graph_status` | |
| `build` / `refresh` | `graph_build` | |
| `impact analyze` | `impact_analyze` | |
| `visualize` | `graph_visualize` | devuelve el PATH del HTML generado |
| `audit` | `audit_run` | |
| `doctor` | `doctor_run` | exento de consentimiento (el diagnóstico siempre está permitido) |
| `memory save` | `memory_add` | batch: `items[]` + `atomic` |
| `memory search` | `memory_search` | |
| `memory verified` | `memory_verified` | |
| `memory context` | `memory_context` | |
| `memory get` | `memory_get` | batch: `ids[]` |
| `memory update` | `memory_update` | |
| `memory suggest-topic` | `memory_suggest_topic` | |
| `memory session` | `memory_session` | |
| `agent-hook SessionStart` | `context_build` | |

Solo-CLI, por diseño: `env exec` (el contrato names-not-values inyecta secretos de proceso a
proceso; el resultado de una MCP tool traería los valores al contexto del modelo),
`merge-projects`, `reanchor`, y los comandos de instalación/ciclo de vida.

Consentimiento: el server respeta el opt-out por-repo — una llamada a una tool cuyo `root`
tenga `.leina/consent = disabled` falla con un error accionable (`doctor_run` sigue
disponible).

### Registro

`leina mcp register` toma hosts MCP (`claude`, `cursor`, `windsurf`) y `--hosts` es
**obligatorio** — este conjunto es distinto de los hosts de instalación (`devin`, `claude`).

```bash
leina mcp register --hosts claude,cursor,windsurf     # USER-GLOBAL: una entrada por host,
                                                      # disponible en todo proyecto
leina mcp unregister --hosts claude,cursor,windsurf   # inverso
leina mcp status                                      # estado de solo lectura por host
leina activate --hosts claude --mcp --mcp-hosts claude   # registra durante la instalación
leina setup --hosts claude --mcp --mcp-hosts claude
leina init <dir> --hosts claude --profile devin --mcp    # .mcp.json A NIVEL PROYECTO
                                                         # (commiteable, para equipos)
```

Mecánica por host: Cursor (`~/.cursor/mcp.json`) y Windsurf
(`~/.codeium/windsurf/mcp_config.json`) se fusionan in place (solo la entrada `leina` es
propia; los servers de terceros y las keys desconocidas sobreviven; un JSON malformado nunca
se pisa; un host solo se toca si su directorio de config ya existe). El registro de Claude
Code delega en `claude mcp add --scope user leina leina mcp` (su `~/.claude.json` es estado
propiedad del host que nunca escribimos) y otorga `mcp__leina` (a nivel server, todas las
tools) en `~/.claude/settings.json`. `deactivate`/`disable` eliminan los registros
user-global; `deinit` elimina el del proyecto. `leina doctor` reporta el estado de registro
por host y solo falla cuando existe un registro pero `leina` no resuelve en el PATH.

---

## Comandos de instalación / ciclo de vida

leina expone un modelo de comandos **por capas, totalmente reversible** — cada comando de
instalación tiene un inverso explícito, y nada actúa en un repo sin consentimiento. Los hosts
de instalación son `devin` y `claude`, y todo comando que toca hosts **exige `--hosts`
explícito** — leina nunca elige un host por vos.

| Capa | Comando | Inverso | Blast radius |
|---|---|---|---|
| **Machine** (una vez) | `setup` | `disable` | a nivel máquina: share global + symlinks + config user-global + blanket sentinel |
| **Global** (granular) | `activate` | `deactivate` | a nivel máquina: share global + symlinks + grant `Exec` user-global + hooks |
| **Repo** (granular) | `init` | `deinit` | un repo: consent flag (+ `AGENTS.md`/`.devin/*` si es standalone) |
| **Repo** | `build` | — | un repo: `graph.db` (bajo demanda) |

**Blanket + consentimiento tri-estado.** `setup` activa un **blanket sentinel** a nivel
máquina (`~/.leina/.blanket`). De forma independiente, cada repo lleva un **consent flag
local, git-ignored** (`.leina/consent`) con tres estados:

- `unknown` (sin flag) — la gate de Devin se mantiene **silenciosa** (sin inyección, sin
  advisories); el skill `leina-setup` le pregunta al usuario una vez ("leina disponible —
  ¿usar este workspace?").
- `enabled` — leina actúa: la gate inyecta memoria + stats del grafo, disparan los
  advisories y (bajo blanket) el grafo se autorrepara en `SessionStart`. Lo escribe `init`.
- `disabled` — no-op silencioso permanente. Lo escribe `deinit`.

Un repo que solo tiene un `.devin/hooks.v1.json` pero sin consent flag resuelve a `unknown`,
así que se le vuelve a preguntar una vez en lugar de quedar silenciado sin más.

### `setup --hosts <devin|claude>[,...] [--mcp --mcp-hosts <claude|cursor|windsurf>[,...]] [--no-user-hooks]`
El comando "mágico" de una sola vez (una vez por máquina). Compone `activate` (share +
symlinks + grant `Exec` user-global + hooks) **y** activa el blanket sentinel. `--hosts` es
obligatorio. Idempotente. Tras `setup`, leina está disponible en toda sesión de los hosts
elegidos y cada repo se gobierna por su consent flag. Agregá `--mcp` (con su `--mcp-hosts`
acompañante) para registrar el server MCP durante la instalación. `--no-user-hooks` omite la
fusión de los hooks user-global.

```bash
leina setup --hosts claude
leina setup --hosts devin,claude --mcp --mcp-hosts claude
```

### `disable`
Inverso de `setup` (una vez por máquina). Desactiva el blanket sentinel y corre el teardown
global (desenlaza los hosts, revoca el grant `Exec` user-global y elimina los hooks
user-global). Solo strip-inverse — elimina las entradas gestionadas por leina preservando
cualquier symlink/grant/hook de terceros; **no** depende de archivos `.bak`. Idempotente (un
segundo `disable` sale con 0).

### `init [dir] --hosts <devin|claude>[,...] --profile <devin|windsurf> [--freshness auto|refuse] [--build] [--mcp] [--name <project-name>] [--claude-hooks]`
Opt-in por-repo — **adaptativo** según si blanket está activo. Siempre escribe el consent flag
`enabled` y asegura el bloque de `.gitignore`. Luego:

- **LIGHT** (blanket activo): nada más. El share/grant/hooks a nivel máquina de `setup` ya
  cubre este repo, así que `AGENTS.md` y `.devin/*` son redundantes y **no** se escriben; en
  este modo `--hosts`/`--profile` no hacen falta.
- **FULL** (standalone, sin blanket): **exige `--hosts` y `--profile devin|windsurf`** (el
  estilo del protocolo `AGENTS.md`). También escribe el bloque de protocolo `AGENTS.md`,
  `.devin/hooks.v1.json` y un grant `Exec(leina)` **repo-local** en `.devin/config.json` —
  dejando el repo autocontenido. **Nunca** modifica el `~/.config/devin/config.json`
  user-global.

`init` **no** hace auto-build. Pasá `--build` para correr un graph build **sincrónicamente en
foreground** (con progreso) justo después del wiring. `--name <project-name>` escribe un
`.leina/config.json` commiteable que fija la project key. `--profile windsurf` agrega la
sección de capabilities de Windsurf a `AGENTS.md` (solo FULL). `--mcp` escribe un `.mcp.json`
de proyecto commiteable. `--claude-hooks` fuerza los hooks de Claude Code aunque el host
`claude` no esté en `--hosts`.

```bash
leina init <dir> --hosts claude --profile devin
leina init <dir> --hosts devin,claude --profile devin --build
```

### `deinit [dir]`
Inverso de `init` (por repo). Escribe el consent flag `disabled` y, en modo strip-inverse,
elimina los artefactos gestionados del repo: el bloque de protocolo `AGENTS.md`, el bloque de
`.gitignore`, el grant `Exec` local y `.devin/hooks.v1.json`. El contenido del usuario fuera de
los marcadores gestionados se preserva. Idempotente — cuando no hay nada que revertir (por
ejemplo, tras un init LIGHT) sale con 0 con una nota de "nothing to revert".

### `activate --hosts <devin|claude>[,...] [--mcp --mcp-hosts <claude|cursor|windsurf>[,...]]`
La mitad global de `setup` (una vez por máquina), sin activar el blanket sentinel. `--hosts`
es obligatorio. Puebla `~/.leina/share/{skills,agents,workflows}` a partir de los assets
empaquetados y symlinkea cada entrada en los directorios globales de cada host elegido (para
Devin, `~/.config/devin/{skills,agents}`), y escribe la config user-global (el grant
`Exec(leina)` + hooks). Agregá `--mcp` (con `--mcp-hosts`) para registrar el server MCP.

```bash
leina activate --hosts devin,claude
```

### `deactivate`
Inverso de `activate` (una vez por máquina). Corre el teardown global (desenlaza los hosts,
revoca el grant `Exec` user-global y elimina los hooks user-global) pero **deja el blanket
sentinel intacto** (eso es competencia de `disable`). Strip-inverse, idempotente.

### `version` (alias: `--version`, `-v`)
Imprime la versión instalada del paquete y sale. Sin acceso a proyecto ni a DB.

### `help` (alias: `--help`, `-h`)
Imprime el texto de uso raíz. Se imprime el mismo texto para cualquier comando desconocido.

### `doctor [dir] [--json]`
Diagnostica la salud de la instalación + del proyecto. Reporta **cada check en una de cuatro
severidades — `ok` / `info` / `warn` / `fail`** (con color) y agrupa lo opcional o no
aplicable en una sección `info` al final. Sin `--json` imprime el reporte humano; con `--json`
emite el `DoctorReport` completo — incluyendo el agregado `repoIdentity` (`{projectKey,
strategy, confidence: "high"|"medium"|"low", pathHash, rootCommit?, normalizedRemote?}`).
`pathHash` es un SHA-256 determinístico entre SO de la ruta absoluta normalizada;
`normalizedRemote` es la forma canónica `host/org/repo`. `doctor` es informativo — nunca
cambia su exit code.

### `verify [dir] [--json]`
Vuelve a correr los mismos checks que `doctor` pero con un **exit code accionable** — sale
con `1` si algún check es `fail`, `0` en caso contrario (solo-warn igual sale con 0). Con
`--json` devuelve el `DoctorReport` (con el mismo `repoIdentity`) más un campo `exitCode`,
para gating de CI.

### `repair [dir] [--no-user-hooks]`
La **contraparte de escritura de `doctor`**: vuelve a correr los writers idempotentes de
instalación para todo lo que doctor encuentre roto, acotado estrictamente por **evidencia de
una instalación previa** — nunca instala algo que el usuario nunca pidió:

- **Global** (share + symlinks + grant/hooks user-global): solo cuando existe evidencia de
  activación (share poblado o blanket sentinel activo). Nunca una instalación de primera vez.
- **Project** (wiring de `AGENTS.md` / `.gitignore` / `.devin/*` / consent): solo cuando
  existe evidencia de init (consent flag, archivo de hooks gestionado, o bloque de protocolo
  `AGENTS.md`) **y** el consent no es `disabled` — un opt-out de `deinit` siempre se
  respeta. El profile original (Devin/Windsurf) se preserva.

Nunca toca `graph.db` / `memory.db`. Termina volviendo a correr doctor; los fails restantes
determinan un exit code distinto de cero.

### `tui [dir]`
Consola interactiva. Menús para: status (resumen de doctor), install/update con **selección
de asset-group** (catalog presets / skills y agents individuales), init/deinit del repo
actual, repair, gestión de variables de entorno (prompt estilo password, listado enmascarado)
y desinstalación. Una capa de presentación fina **por diseño**: cada acción despacha a los
mismos handlers que usan los comandos basados en flags, así que la TUI nunca puede divergir del
comportamiento de la CLI. Requiere una terminal interactiva real en stdin+stdout; en caso
contrario falla apuntando a los equivalentes no interactivos.

### `capabilities list [--json]`
Lista las **17 capacidades del sistema** que exponen los casos de uso centrales como
contratos agnósticos de transporte (por ejemplo `graph.query`, `graph.status`, `memory.add`,
`memory.search`, `context.build`, `audit.run`) — corré el comando para ver la lista completa
y actualizada en vez de confiar en este doc, ya que el registro crece con el tiempo. Con
`--json` imprime un array de `{id, description, inputSchema, outputSchema, schemaVersion,
transports}`. Cada output schema está versionado (`schemaVersion: 1`). Este registro es la
costura que le permite a un futuro transporte alternativo (HTTP, SDK, TUI, …) resolver los
mismos casos de uso que la CLI llama hoy, sin duplicar lógica.

### `agent-hook <Event>` (alias: `devin-hook`)
Gate de agent hook agnóstica de host; lee el payload JSON por stdin (`devin-hook` es un alias
de compatibilidad — las instalaciones de `.devin/hooks.v1.json` lo invocan). Events:
`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `PostCompaction`, `Stop`.
**Solo advisory** — nunca bloquea. **Scope-aware**: la gate es un no-op silencioso a menos que
el consent flag del repo sea `enabled`, así que un hook user-global se mantiene callado en
repos que no optaron in (`unknown`/`disabled`).

**Auto-build self-heal (SessionStart)**: en cada `SessionStart` **para un repo con consent
(`enabled`)**, si `graph.db` falta o el manifest está stale, se lanza un `leina build`
desatendido en segundo plano antes de inyectar el contexto. Nunca se dispara en repos
`unknown`/`disabled`, así que leina nunca construye un grafo en un workspace en el que no diste
tu opt-in. El build en segundo plano materializa un grafo fresco para la siguiente sesión. Es
advisory/fail-open — cualquier error de spawn se traga en silencio y la inyección de contexto
continúa normalmente. Suprimilo con `LEINA_DISABLE_AUTOBUILD=1`.

**Lock file**: tanto `init` como el auto-build de `SessionStart` se coordinan vía
`.leina/graph.build.lock` (JSON `{ pid, startedAt }`), escrito con `O_EXCL` para serializar
disparadores concurrentes. Un lock stale (PID muerto, o `startedAt` con más de 15 min) se
reclama automáticamente.
