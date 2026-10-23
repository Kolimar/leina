# Registro de cambios

Todos los cambios notables de este proyecto se documentarán en este archivo.

El formato se basa en [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
y este proyecto sigue [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Sin publicar

### Cambiado
- **`leina-sdd` enruta cada cambio antes de ejecutar fases.** *Directo*: se entiende en un solo lote de lecturas, sin ítem de alto riesgo y se termina con el pedido más `git diff` — se resuelve en línea, sin fases, subagentes ni artefactos. *Compacto*: falla la prueba de reanudación pero no hay decisión de producto o diseño abierta — un único artefacto de plan `sdd/{change}/plan` (Specs S#, Tasks T#, Log cuyo L1 es el pedido del usuario textual); `sdd-apply` solo corre por un motivo explícito y recibe el plan por referencia. *Completo*: hay una decisión de producto o diseño abierta, o el usuario lo pide — las 8 fases. Seis ítems de alto riesgo nombrados (datos irrecuperables, seguridad, contratos que consumen otros, concurrencia, entrega/CI, código que ningún test cubre) deciden la escalada; el tamaño nunca se deduce de la cantidad de archivos o líneas.
- Los briefs de cada fase llevan el pedido del usuario textual y las fases citan sus cadenas exactas en lugar de parafrasearlas (`sdd-propose` suma la sección `Request (verbatim)`).
- `sdd-verify` usa por defecto el modelo sonnet; el modelo más potente se usa solo ante un ítem de alto riesgo nombrado.
- El bloque de protocolo de `AGENTS.md` que escribe `leina init` pasó de 8,9 KB a 5,4 KB (mismas reglas, sin duplicación, con los comandos de administración poco usados delegados a `--help`), protegido por un test de presupuesto en bytes. Ahora enruta todo cambio de código: uno directo igual revisa consumidores con `leina affected`, ve su test fallar y luego pasar y cierra con `Risk: none`; cualquier otro invoca `leina-sdd` antes de la primera edición. Los repos existentes lo reciben con `leina init` o `leina repair`.

### Agregado
- **Respaldo antes de migrar el esquema de la memoria.** Antes de que una actualización de esquema reescriba `memory.db` en el lugar, leina lo copia a su lado como `memory.db.bak-v<from>-<ISO>` (`VACUUM INTO`). Una DB nueva, una en memoria o una que ya está al día no genera copia. Si la copia falla, no se migra nada y el error nombra la DB, ambas versiones y la causa. Toda la actualización (copia, esquema y migraciones) corre ahora en una sola transacción: los procesos que abren la DB a la vez la esperan y la encuentran al día, así que hay una sola copia y nunca una DB a medio actualizar.

### Corregido
- **`leina activate` (y `repair`/`init`) reconstruye el share global cuando cambian las skills o los agentes incluidos sin subir la versión.** Un checkout de desarrollo seguía sirviendo prompts viejos hasta borrar a mano `~/.leina/share/.version`. Ahora el share también registra una huella de los assets incluidos (`share/.assets.sha256`) y se repuebla cuando difiere; `.version` sigue guardando la versión pelada que compara `leina doctor`.
- **La skill `leina-sdd` ya no duplica el pedido del usuario en el prompt cargado.** Escribía el placeholder de argumentos en su prosa y Claude Code lo sustituye, así que el pedido aparecía dos veces. Ahora la skill nombra "los argumentos de la skill" y Claude Code los agrega una sola vez.

## [3.0.0] — Sin publicar

3.0.0 publica el trabajo de la 2.1.0, que nunca salió (el harness de tareas y una revisión de seguridad), junto con una revisión funcional de la detección, la ergonomía para el agente y el rendimiento. Cambiaron varios defaults, salidas de la CLI y payloads de MCP: leé primero *Actualizar desde 2.x*.

### Actualizar desde 2.x
- **Corré `leina setup --hosts …` (o `leina activate --hosts …`) una vez.** Reescribe los hooks user-global con la forma de comando 3.0 (`leina agent-hook <Event> --host claude|devin --scope user`) y ahora también cablea **Claude Code** (`~/.claude/settings.json`); `--no-user-hooks` lo evita. Después corré `leina doctor`: ahora marca los hooks que todavía ejecutan otra instalación de leina.
- **Corré `leina init` una vez en cada repo donde uses leina en esta máquina** (también después de moverlo o re-clonarlo). Los hooks, la inyección de memoria y la automatización del harness ahora requieren un registro de confianza del workspace fuera del repo que solo escribe `init`; un `.leina/consent` commiteado no otorga nada.
- **El harness de tareas es opt-in.** `leina init` lo arma solo con `--harness` (o `--harness-preset`); los repos que ya tienen `.harness/config.json` lo conservan.
- **La primera lectura del grafo después de actualizar lo reconstruye una vez** (manifest v3, esquema nuevo del extractor de TypeScript).
- **La base de memoria se migra al abrirla por primera vez** (esquema v8): las observaciones guardadas con el tipo inválido `note` pasan a `discovery`, los snapshots de topics que dejó varados un `merge-projects` anterior se reubican y se agregan columnas de ciclo de vida. Copiá `~/.leina/memory.db` antes si querés un respaldo.
- **Scripts que usan la CLI:** los errores de uso ahora salen con **2** (un comando desconocido antes imprimía la ayuda raíz y salía con 0); `<dir>` es opcional y se resuelve a la raíz del proyecto, así que `leina build packages/x` en un paquete que no es un proyecto leina propio actúa sobre el repositorio (`leina init packages/x` lo convierte en uno); un `<dir>` explícito que no existe es un error de uso; la profundidad de `affected` es `--depth N`; `stats` sale con 1 si no hay grafo; `status` y `memory current-project` imprimen primero `root:`.
- **Consumidores de MCP:** las tools de grafo y memoria responden en JSON compacto con formas nuevas (ver *Cambiado*), `root` queda confinado al workspace del server y las búsquedas tipo `affected` aceptan solo símbolos exactos.

### Agregado
- **Ayuda por comando y un contrato de uso.** `leina <comando> --help`, `-h` y `leina help <comando>` imprimen el uso de ese comando, generado desde una única tabla de comandos que también maneja el dispatch y el control de flags. Exit codes: 0 éxito, 1 falla en ejecución, 2 error de uso (`leina <comando>: <mensaje>` + `run 'leina <comando> --help' for usage`), con sugerencias `did you mean` para comandos y flags, una pista cuando el orden del subcomando está invertido y `--flag=valor` para los flags con valor.
- **`<dir>` opcional** en todos los comandos por proyecto, resuelto a la raíz del proyecto: el proyecto leina más cercano hacia arriba (grafo, flag de consentimiento o name lock), si no el toplevel de git, sin cruzar nunca un toplevel de git. Las reglas de posicionales son fijas por comando (`query [<dir>] <texto…>`, `affected [<dir>] <símbolo>`, `path [<dir>] <desde> <hasta>`, `memory get [<dir>] <id>`, …); `init`, `deinit` y los comandos de workspace toman `<dir>` tal cual.
- `impact analyze --depth`.
- **Harness de tareas (absorbido del `harness-framework` independiente), opt-in.** Rules de ciclo de vida (intake → plan → execute → verify → deliver) con gates ejecutables, contracts de tarea controlados contra el diff real de git y sync multi-plataforma — nativos de leina, sin dependencias nuevas (validadores propios en lugar de zod, front matter JSON en lugar de YAML, `safe-exec` en lugar de execa, matcher de globs propio calibrado contra picomatch).
  - `leina init --harness [--harness-preset generic|leina-native]` siembra `.harness/config.json` y sincroniza los archivos de plataforma; `deinit` lo revierte usando el lockfile del sync.
  - `leina harness contract new|show|edit|end`, `verify`, `sync [--check|--force|--platforms]`, `list`, `hook <event>`.
  - 14 rules builtin en `assets/harness/rules/`. Presets: `leina-native` (default) conserva las cuatro rules de leina (`memory-first`, `graph-consult`, `graph-fresh`, `session-summary`); `generic` las deja afuera para usar el harness sin adoptar el resto de leina.
  - Enforcement en el agent gate en workspaces confiados, en Claude Code y Devin: el sello de integridad aplica siempre; el control de scope, el guard de commit/push y el gate de Stop (tope de reintentos y después cesión honesta) aplican con un contract activo, en modo strict o cuando la config no se puede leer.
  - 5 capabilities nuevas (22 en total), expuestas como tools MCP: `harness_contract_new/show/end`, `harness_verify`, `harness_rules_list`.
  - `leina tui` → **flujo de harness**: entrevista guiada del contract, sugerencia de recipes, selección de rules con restricciones de no-debilitamiento y paneles de status/verify/sync.
  - Adapters de plataforma (bloques gestionados en CLAUDE.md / AGENTS.md, skills, cableado de hooks de Cursor/Windsurf/OpenCode vía `leina harness hook`) con el formato de lockfile y marcadores del framework independiente.
- **Confianza del workspace.** Un registro fuera del repo (`$LEINA_HOME/trust/`, indexado por la ruta real del repo) que escribe `leina init` y borra `deinit`. Todo camino automático del harness, todo gate ejecutable de capa project y los hooks advisory lo requieren. `leina doctor` lo informa.
- **Cableado de Claude Code.** `setup`/`activate` fusionan los hooks gestionados en `~/.claude/settings.json` (respaldo en el primer cambio; un archivo mal formado queda intacto y se informa); el cableado de proyecto (`init --hosts claude`) suma **PreToolUse** para Edit/Write/MultiEdit/NotebookEdit/Bash, así que el enforcement del harness por fin corre en Claude Code.
- **Ciclo de vida de la memoria.** `leina memory resolve <dir> <id> [--note …] [--obsolete]`, `leina memory reopen <dir> <id>` (ambos con `--batch`), `memory update --status/--resolution`, MCP `memory_update {status, resolution}`. Las notas resueltas y obsoletas salen del contexto inyectado; search, `get` y `verified` las siguen devolviendo, etiquetadas y relegadas. Los ids cortos funcionan en todos los verbos que reciben id.
- `leina memory compact <dir> [--keep N] [--sessions-older-than DAYS] [--keep-sessions N] [--dry-run]` — recolecta los snapshots superseded de cada topic (las filas vivas se conservan siempre), opcionalmente purga sesiones inactivas (las N más nuevas, 5 por defecto, sobreviven siempre) y después hace `VACUUM`.
- **Selectores de símbolo** para `affected`, `path` e `impact`: un id de nodo crudo, `ruta/al/archivo.ts:nombre` (sufijo de ruta o ruta absoluta), `nombre` / `nombre()`, `Clase.metodo` / `Clase#metodo`, o un sufijo de ruta de archivo para el módulo.
- `leina query --json` (se anunciaba pero no estaba implementado) e `--include-tests` (MCP `includeTests`).
- **Grafo de TypeScript:** nodos para type aliases, enums, variables y accessors; los miembros de object literals como métodos y un default export anónimo como `default()`; aristas `implements` y `overrides` a nivel de miembro; aristas `imports` de módulo a módulo.
- `leina doctor`: diagnóstico del cableado de hooks — hooks que ejecutan otra instalación de leina o una CLI inexistente, entradas de refresh por edición que quedaron, hosts de IA sin ningún hook, archivos `.leina` commiteables ocultos por `.gitignore` — y un chequeo de preparación para la inyección que exige consentimiento, confianza y cableado. `leina repair` arregla los del lado de la instalación.
- `leina status` y `graph_status` por MCP listan la extracción con precisión reducida (`degraded`).

### Cambiado
- **Hooks**
  - Los comandos de hook gestionados nombran su host y su scope: `agent-hook <Event> --host claude|devin [--scope user]`. Las entradas que escribió la 2.x siguen funcionando (el host se infiere) y `setup`/`activate`/`init`/`repair` las reescriben.
  - Un hook user-global se queda en silencio para un evento que ya atiende el cableado propio del proyecto, así cada evento se responde una sola vez.
  - Los hooks actúan sobre el proyecto cuando se disparan en un subdirectorio, en un worktree bajo `.claude/worktrees/` o en un worktree vinculado de git.
  - Los avisos llegan a Claude Code como `hookSpecificOutput.additionalContext` (Claude Code nunca le muestra al modelo el stderr de un hook que sale con 0). El recordatorio de guardado del Stop aparece como mucho una vez por sesión y nunca con `stop_hook_active`; el fallback de inyección, como mucho una vez por sesión.
  - Los marcadores de sesión sobreviven a `resume` y a la compactación; solo `startup`/`clear` los reinician.
  - Los hooks de proyecto de Devin ya no corren `leina refresh` después de cada edición — el read path reconstruye de forma perezosa, incremental y bajo un lock entre procesos.
  - El gate de Stop reutiliza el último verify completo cuando HEAD, el working tree, las rules, la config, el contract y la confianza no cambiaron.
- **Lecturas del grafo**
  - `affected`, `path` e `impact` matchean símbolos exactos: un nombre ambiguo usa el mejor match e imprime las alternativas; sin match imprime `no exact match for "X"; did you mean: …` y sale con 1 (MCP: `seed: null` + `suggestions`). Ya no hay fallback por substring.
  - `affected` sobre una implementación también informa los llamadores del miembro de interfaz o método base que implementa o sobreescribe (`via Interfaz.miembro`).
  - `affected`/`path` imprimen el `archivo:línea` del sitio de llamada que trae la arista; `path` imprime la dirección real (`--rel-->` / `<--rel--`).
  - `query` ordena por relevancia (stopwords EN/ES, separación de identificadores, ponderación IDF), excluye nodos de test/mock/fixture salvo con `--include-tests`, lista cada nodo y arista con `archivo:línea`, devuelve como mucho 25 nodos por defecto y omite las aristas `contains`/`method`; `--json` es `{seeds, nodes, edges, testsExcluded}`.
- **MCP**
  - `graph_query`, `graph_affected`, `graph_path` e `impact_analyze` responden en JSON compacto: nodos `{id, label, kind, at}`, aristas `{source, target, relation, at}`; `graph_affected.dependents` y `graph_path` (`{path: {nodes, edges}}`) cambiaron de forma. Las tools `memory_*` también responden en JSON compacto.
  - Las tools de grafo y memoria actúan sobre el proyecto al que pertenece su root (el proyecto leina más cercano hacia arriba, si no el toplevel de git), igual que el `<dir>` de la CLI: un server lanzado en un subdirectorio usa el grafo, la memoria y el flag de consentimiento del repositorio en lugar de construir un segundo grafo ahí.
  - `memory_context` devuelve previews ordenadas y solo de notas activas (límite por defecto 20; `full: true` para los cuerpos completos).
  - `root` queda confinado al workspace del server después de resolver symlinks; los roots de afuera se rechazan salvo que estén permitidos con `LEINA_MCP_ALLOW_ROOTS`. El `out` de `graph_visualize` se confina igual y tiene que terminar en `.html`. Los argumentos numéricos son enteros acotados a límites fijos; `root` es opcional en todas las tools.
- **Memoria**
  - El contexto inyectado ordena las notas activas por tipo × recencia, conserva como mucho 2 por prefijo de topic, muestra ids cortos y fechas e incluye el último resumen de sesión; `memory context` por CLI, `memory_context` por MCP y los hooks comparten un mismo renderer.
  - La búsqueda usa un solo ranking para FTS5 y para el fallback LIKE de Node 22: insensible a acentos, los matches por prefijo completan debajo de los exactos, pesan la recencia y el estado, y un score más alto es mejor.
  - El tipo y el scope se validan en todos los caminos de escritura (CLI, batch, MCP).
  - El chequeo de drift toma la huella de las líneas propias del símbolo anclado (anclas `sym1:`) en lugar del archivo entero; un `decision`/`preference` con drift queda en WARNING, `resolved` llega como mucho a WARNING y `obsolete` es DO NOT USE. `memory reanchor` actualiza en el lugar las anclas de la 2.x y ya no fabrica anclas basura (nombres cortos o genéricos, matches solo en tests).
  - Los subdirectorios y los worktrees vinculados comparten la clave de proyecto del repositorio; `.leina/config.json` se busca subiendo por los directorios.
  - `merge-projects` también mueve el historial de topics; `memory import`/`sync` validan cada línea, recortan timestamps, omiten ids de otros proyectos y no resucitan snapshots compactados; `memory get`/`update` solo ven los ids del proyecto actual.
- **Build y freshness**
  - `leina refresh` siempre re-extrae todos los archivos en lugar de reutilizar la caché de extracción.
  - Un grafo que cayó a tree-sitter por falta de sidecar de compilador queda stale en cuanto uno se construye, se instala o se configura, así que la próxima lectura lo usa; `leina scip install` y el aviso de precisión reducida recuerdan correr `leina refresh` después de instalar un indexer SCIP.
  - Las fuentes se descubren con `git ls-files` (trackeados + no trackeados que no están ignorados), con un walker de respaldo fuera de git; ya no se indexan los directorios ocultos (salvo los de configuración de CI), los repositorios anidados, los submódulos ni los archivos ignorados por git.
  - El manifest (v3) registra la versión de leina, el esquema del extractor y los hashes de los archivos de configuración: actualizar leina o editar `tsconfig*.json`/`jsconfig.json`/`package.json` deja el grafo stale.
  - Ids de nodo: las declaraciones cuyos nombres colisionan sin distinguir mayúsculas llevan un sufijo `:<tag>` (los ids sin colisión no cambian); los miembros static y de instancia son nodos distintos; las llamadas en un inicializador de nivel superior pertenecen a esa variable.
  - `build`/`refresh` rechazan un root inexistente o que no es un directorio (exit 1) en lugar de crearlo y registrarlo.
  - Los avisos de precisión reducida (sin indexer SCIP ni sidecar) se imprimen una sola vez y solo para código de producto; los rebuilds del read path no hacen ruido.
- **Config y verify del harness:** los overrides `rules.<id>` solo aceptan `enabled`/`severity`; las capas user y local no pueden debilitar una rule bloqueante ni bajar `strictness`; una config inválida falla cerrado. Solo las corridas completas de `verify` actualizan el reporte del guard de commit; los errores de uso salen con 2; fuera de git verify falla cerrado; los archivos cambiados son relativos a la raíz del harness; `--json` incluye `loadErrors`; `contract new --max-retries` va de 1 a 10 y cuenta bloqueos por cadena de Stop. El guard de commit juzga la frescura por el contenido del working tree. `sync --platforms` solo toca las plataformas nombradas y compila solo las capas commiteadas; `init --hosts` conserva las plataformas ya sincronizadas; `deinit` borra la config que escribió `init` mientras siga sin cambios.
- Las tools de harness por MCP resuelven la raíz del harness de su root (confinado) igual que `leina harness` lo hace con su cwd, y `harness_verify` controla la confianza a nivel del repositorio, así que un subdirectorio o un worktree anidado de un repo confiado corre y un clon independiente anidado no; un root no confiado queda `skipped` con el comando `leina init` a correr.
- El bloque de protocolo de AGENTS.md que escribe `init` documenta `[<dir>]`, `--help` y el exit 2, `--include-tests`, `--depth`, los selectores exactos, el refresh completo, el requisito de init + confianza para la inyección y una sección del harness opt-in; el registro de capabilities describe `query` como ordenado por relevancia.
- El writer de `.gitignore` de `init` reescribe una línea `.leina/` a secas que ocultaba `.leina/config.json` de git.
- Se subió el rango de `@modelcontextprotocol/sdk` a `^1.32.1`.

### Seguridad
- Un repo clonado podía ejecutar código propio a través del harness sin `leina init`: con un override de `gate` en `.harness/config.json`, con un `.leina/consent` commiteado o con un módulo en la raíz del repo que tapaba un gate js builtin. Corregido con el store de confianza fuera del repo, rechazando los overrides de gate en la config y resolviendo los módulos por capa.
- Un `.harness/harness.lock.json` manipulado podía hacer que `deinit` / `sync --force` borraran o escribieran archivos fuera del repo; las rutas del lockfile se validan y toda escritura o borrado se confina por ruta real.
- MCP: un symlink dentro del workspace escapaba del confinamiento de `root`, y `graph_visualize` podía sobreescribir cualquier archivo escribible por el usuario.
- `memory import`/`sync` de un `.leina/memory-export.jsonl` incluido en un repo podía sobreescribir memorias de otro proyecto (que después se inyectaban en las sesiones de ese proyecto); las búsquedas por id cruzaban proyectos.
- XSS almacenado en el visor offline del grafo a través de nombres de carpetas / claves de repo.
- Las regex que vienen de las rules (gates command, diff-content y file) corren con un timeout duro (ReDoS); las fallas de diff-content solo informan `archivo:línea` y un prefijo enmascarado, nunca el secreto detectado; el escaneo de archivos sin trackear nunca sigue symlinks; la rule no-secrets detecta más formas de credenciales.
- El agente no puede editar `$LEINA_HOME/harness` (rules del usuario) ni el store de confianza; el guard de integridad de pre-bash razona sobre destinos de escritura en lugar de menciones.
- El env store se escribe de forma atómica con permisos solo para el dueño.
- Se resolvieron todos los avisos de `npm audit` (stack express/hono/ajv transitivo del SDK de MCP, brace-expansion, js-yaml, undici, source-map-js).

### Corregido
- Con `leina setup`, Claude Code nunca recibía la inyección de memoria (solo Devin tenía hooks user-global); el enforcement del harness nunca corría en Claude Code (no había hook PreToolUse); todos los avisos eran invisibles para Claude Code (stderr con exit 0).
- Los hooks de Devin seguían ejecutando la instalación de leina con la que se escribieron, y `doctor` informaba todo como sano.
- Los hooks se quedaban en silencio en subdirectorios y worktrees de un repo inicializado.
- Después de una compactación, el recordatorio del Stop pedía guardar una sesión que ya estaba guardada; una inyección fallida reinyectaba su fallback en cada prompt.
- `affected` no veía los llamadores que llegaban por imports dinámicos desestructurados (`const { f } = await import(…)`) y renombres locales, ni ningún llamador que pasara por una interfaz; las declaraciones homónimas que solo diferían en mayúsculas (`hostSpec` / `HostSpec`) se fusionaban en un solo nodo.
- `affected`/`path` informaban en silencio otro símbolo cuando el nombre no tenía match exacto (fallback por substring) y elegían mocks de test para los nombres ambiguos.
- El YAML siempre se parseaba con el fallback por líneas: la gramática incluida necesitaba símbolos del runtime de C++ que web-tree-sitter 0.25 no exporta.
- `sidecar verify` / `scip verify` estaban rotos en una instalación publicada (sus fixtures no se distribuían; las de C#/Java estaban vacías).
- `leina build <dir inexistente>` creaba el directorio, construía un grafo vacío y lo registraba.
- Las lecturas concurrentes de un grafo stale corrían cada una un rebuild completo (un proceso por lector).
- En la raíz de un workspace multi-repo, `query`/`affected`/`path` la reconstruían como un solo repo — sin indexar ninguno de sus miembros — y pisaban el grafo fusionado con uno vacío; lo mismo hacían `build`/`refresh` (y `graph_build` por MCP). Ahora construyen los miembros stale y los fusionan, y `status` lista los miembros; un repositorio git nunca se trata como workspace.
- Un grafo construido por un leina anterior seguía leyéndose como fresco después de actualizar.
- Se indexaban los worktrees bajo `.claude/worktrees/` y la salida ignorada por git, duplicando símbolos.
- `memory save`/`update` aceptaban tipos inválidos, que después rompían `memory export` → `import`; `memory search` mezclaba los valores de los flags en la consulta.
- `merge-projects` dejaba varados los snapshots de topics bajo la clave vieja y podía dejar entradas fantasma en el índice full-text.
- La caché de extracción de TypeScript nunca acertaba en Node 22 (node:sqlite cortaba su clave en un NUL).
- `graph_visualize` podía terminar todo el server MCP ante un grafo stale rechazado; las llamadas MCP concurrentes sobre un grafo stale lo reconstruían cada una (y `graph_stats` podía leer un grafo a medio escribir) — los builds son single-flight por root.
- `impact_analyze` por MCP no devolvía nada para un nombre de símbolo; `memory_verified` ignoraba `type`.
- Los archivos fuente de más de 4 MiB se omiten de forma consistente en el build y en el chequeo de freshness.
- El retrofit del índice NOCASE de labels ya no bloquea una lectura cuando otro proceso tiene el lock de escritura.
- Un gate js trabado en una promesa que nunca resuelve se informa como timeout en lugar de dejar que verify termine antes de tiempo (visto en Node 22).
- `memory compact` informa una db bloqueada o un `VACUUM` fallido sin stack trace y no informa una db más grande mientras otro proceso la tiene abierta.
- `env set`/`unset` matchean las claves que acepta el parser (`KEY =valor`) y colapsan duplicados.
- Harness: la detección de commits y el guard de integridad manejan `&`, subshells y backticks; el hook de shell de Cursor toma la misma decisión que pre-bash; el plugin de OpenCode bloquea solo con exit status 2; `.harness/state/` se ignora solo; `hookCommand` tiene que ser una forma de lanzar leina; la TUI escribe los overrides de rules recién cuando se confirma el contract; deinit preserva el JSON del usuario tal cual y escribe de forma atómica.
- La ayuda raíz y la de `memory` mostraban `memory <dir> <sub>`; el dispatcher lee `memory <sub> <dir>`. Los comandos y subcomandos de memory desconocidos imprimían la ayuda y salían con 0; otros problemas de uso salían con 1.
- Los valores de flags se leían como el proyecto o el símbolo: `visualize --out x.html`, `audit --from id`, `init --hosts devin <dir>` y `workspace memory search` tomaban la palabra equivocada. `tui` tomaba cualquier primera palabra como su directorio, `impact analyze` ignoraba su profundidad, `workspace build/status` ignoraban `--single`/`--workspace`, se aceptaban valores inválidos de `--format`/`--max-pack-kb`/`--type`/`--scope`/`--status`, y `stats` creaba un graph.db vacío.
- Windows: el build de self-heal en segundo plano corría en el directorio del hook (dejándolo tomado) y podía abrir una ventana de consola en cada inicio de sesión; crear el lock de build podía lanzar un error mientras otro proceso lo reclamaba; un worktree anidado podía perder la confianza de su repositorio cuando git y Node escribían la misma ruta distinto (nombres largos vs 8.3); las llamadas a git fijadas corrían sin SYSTEMROOT/USERPROFILE.
- Windows: el sello de integridad del harness no detectaba una escritura por shell a una ruta absoluta de `$LEINA_HOME/harness` o del trust store escrita con barras invertidas, y un `"C:\…"` entre comillas dobles perdía sus separadores al parsearse; un `hookCommand` con un nombre corto 8.3 en la ruta (`C:\PROGRA~1\…`) se rechazaba como si tuviera metacaracteres de shell.
- Los tests ya no escriben en el `~/.leina` real del desarrollador ni dejan `.leina/` en `test/fixtures` (los fixtures se construyen desde copias temporales); los 51 tests de `test/use-cases` y el del fake-agent-runner, que `npm test` nunca corría, vuelven a correr.

### Rendimiento
- **Extracción incremental de TypeScript.** Solo se re-extraen los archivos editados, más sus importadores cuando cambia la forma visible, el conjunto de archivos o la resolución de un import; una declaración global, un archivo no TypeScript que lee el checker, tsconfig, package.json, un lockfile, la versión de leina, `leina refresh` o `LEINA_TS_FULL_EXTRACT=1` fuerzan una extracción completa. El grafo incremental es idéntico al completo. `leina build` entero, antes → después:

  | Repo | Build | 2.x | 3.0 |
  |---|---|---|---|
  | leina (372 archivos TS) | sin cambios | 7,7 s · 807 MiB | 0,55 s · 259 MiB |
  | leina | edición de 1 archivo | ~8 s · ~830 MiB | ~0,9 s · ~300 MiB |
  | app Next.js (751 archivos TS) | sin cambios | 21 s · 1,8 GiB | 0,8 s · 278 MiB |
  | app Next.js | edición de 1 archivo | 19,5 s · ~1,8 GiB | 1,8–2,8 s · 464–620 MiB |
  | app Next.js | en frío | 26 s · 1,9 GiB | 10 s · 1,5 GiB |
- Los rebuilds de un grafo stale se serializan entre procesos: cuatro lecturas concurrentes después de una edición pasaron de cuatro rebuilds (≈ 4,5 GB de RSS sumado) a uno (≈ 1,5 GB); los lectores que esperan reutilizan su resultado.
- Un índice NOCASE de labels sirve las búsquedas exactas de símbolos; el chequeo de staleness lista el proyecto una sola vez y comparte ese listado con el rebuild que dispara.
- Los payloads de grafo por MCP se achicaron entre 3 y 8 veces (p. ej. `graph_query` ≈ 50 KB → 5–9 KB).

### Documentación
- Referencia de la CLI (EN/ES): una sección de ayuda y exit codes, las reglas de posicionales de cada comando y el exit code de `doctor`; el readme, la guía de uso y los conceptos muestran `[<dir>]`. La superficie de instalación de AGENTS.md ya no afirma que `init` corre `activate` ni que escribe la config user-global de Devin. CONTRIBUTING: los tests aíslan HOME/LEINA_HOME y construyen los fixtures desde una copia.
- Referencia de la CLI (EN/ES) para todos los cambios anteriores y para `memory compact`, `graph gc`, `init --harness-preset` y la selección de assets en `setup`/`activate`, incluidas las reglas de confinamiento y argumentos de MCP, las reglas de import/sync de memoria, los límites del env store, el comportamiento del harness y la confianza, los selectores de símbolo y el ciclo de vida de la memoria.
- Conceptos (EN/ES): ids del grafo, tipos de nodo y relaciones, extracción incremental; presets del harness, el mapa de vocabulario de hooks y gates y la confianza del workspace.
- Benchmarks: se corrigieron las afirmaciones sobre la caché en caliente y la escala del read path y se agregaron los números del build incremental.

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
