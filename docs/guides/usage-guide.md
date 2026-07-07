# Guía de uso — leina

> **¿Qué es leina?** Es una herramienta **de línea de comandos (CLI)** que le da a tus asistentes de IA (Devin, Claude Code, Cursor, VS Code, Codex, Gemini CLI, LM Studio y cualquier otro host compatible con MCP) **dos capacidades** que por defecto no tienen:
>
> - un **grafo de conocimiento** del código — saber qué depende de qué, qué se rompe si tocás algo, cómo se conectan las piezas;
> - una **memoria persistente** del proyecto — decisiones, fixes, descubrimientos y contexto que sobreviven entre sesiones.
>
> Con leina instalado, la IA deja de re-leer el repo en cada conversación y empieza a razonar sobre la estructura y la historia real del proyecto, ejecutando comandos `leina` por su shell.

> ℹ️ **leina ofrece una interfaz de línea de comandos.** Cada comando opera sobre un `<dir>` explícito. El camino de consulta arranca rápido (~0.15s) porque el stack pesado de extracción (tree-sitter + ts-morph) se carga solo en `build`/`refresh`.

La guía tiene **tres partes**:

1. **Requisitos** — qué tiene que estar instalado en tu máquina antes de empezar.
2. **Parte 1 — Setup** — un solo comando (`setup`) una vez por máquina; los repos se dan de alta solos cuando la IA te pregunta.
3. **Parte 2 — Qué le podés pedir a la IA una vez instalado** — el catálogo de cosas que ahora sabe hacer, incluyendo SDD (Spec-Driven Development).
4. **Parte 3 — Uso diario** — el flujo de una sesión típica: hooks automáticos, memoria + grafo + SDD en el día a día.

> 🧠 **¿Querés entender cómo funciona por dentro?** La guía conceptual en
> [`docs/concepts/`](../concepts/README.md) explica la mecánica del grafo, la memoria, la
> búsqueda, el *drift* y los hooks, con diagramas y analogías estilo storytelling. Esta guía es
> el *cómo usarlo*; aquella es el *cómo funciona*.

---

## Requisitos

Estos los tenés que verificar **una sola vez** en tu máquina:

| Requisito | Para qué sirve | Cómo verificar |
|---|---|---|
| **Node.js ≥ 22.13** | Es el motor sobre el que corre leina. Con Node 22/23 los comandos `memory` funcionan pero la búsqueda corre en modo degradado (LIKE, sin stemming ni BM25). **Se recomienda Node ≥ 24** para obtener búsqueda full-text completa (SQLite FTS5); el comando `leina doctor` indica si hay que actualizar. | `node --version` |
| **Git** *(opcional)* | Solo si vas a correr leina desde un clon (contribuidores). Para el uso normal con `npm install -g` no hace falta. | `git --version` |
| **Un host de IA** | La IA que consume leina. Dos formas de conectarla: **MCP** (universal — Claude Code, Cursor, Windsurf, VS Code, Codex, Gemini CLI, LM Studio, Zed, …) o los **hooks** de auto-inyección (solo Devin y Claude Code). Ver el paso 7 de [`getting-started`](../GETTING_STARTED.md#7-connect-it-to-your-ai). | según el host |

> 💡 Si usás un manejador de versiones de Node (`fnm`, `nvm`, `Volta`, `scoop`), no necesitás cambiar nada — leina corre como cualquier comando de tu PATH.

Si te falta alguno, instalalo antes de seguir.

---

## Parte 1 — Setup

El setup es **un solo comando, una sola vez por máquina**. Después de eso no tenés que acordarte de nada por proyecto: cuando uses Devin o Claude Code en un repo, la propia IA te pregunta (vía el skill `leina-setup`) si querés usar leina ahí.

### El comando mágico (una sola vez por máquina)

**Opción recomendada — instalar el binario en tu PATH:**

```bash
npm install -g @kolimar/leina
leina tui                # consola interactiva: elegís "install" → assets + hosts + MCP, sin flags
```

`leina tui` es la forma más fácil: un menú te guía por qué assets instalar, en qué hosts de IA
(Devin, Claude Code, Cursor, Windsurf), el modo blanket y el registro MCP. ¿Preferís un solo
comando sin prompts? `leina setup` hace la instalación recomendada de una (todos los assets +
blanket; agregá `--mcp` para registrar el server MCP también).

Con eso leina queda disponible en **cualquier** sesión de tu IA en la máquina. ¿Querés deshacerlo todo más adelante? Un comando:

```bash
leina disable            # revierte setup por completo (symlinks, config user-global, blanket)
```

> **¿Contribuís a leina o querés correr lo último sin publicar?** Ese es el único motivo para
> trabajar desde un clon en vez de la instalación global — el setup de desarrollo (`git clone`,
> `npm install`, `npm run cli -- <cmd>`) vive en [`CONTRIBUTING.md`](../../CONTRIBUTING.md), no acá.

**Verificar que quedó bien:**

```bash
leina --help     # lista setup/disable, activate/deactivate, init/deinit, build, query, memory, doctor, ...
leina doctor     # diagnostica versión de Node, share global y symlinks
```

> **¿Querés las piezas por separado en vez del comando mágico?** `setup` compone dos cosas, y cada una tiene su inverso: `activate` ⟷ `deactivate` (share + symlinks + config user-global, **sin** encender blanket). `install-global` quedó como alias deprecado de `activate`.

### Por proyecto: no hay nada que recordar

Con el modo blanket encendido, **no necesitás inicializar cada repo a mano**. La primera vez que uses Devin en un repo, el skill `leina-setup` te pregunta una vez:

> *"leina está disponible, ¿lo usás en este workspace?"*

- Si decís **que sí**, corre `init` (deja un flag local `enabled`) y a partir de ahí leina actúa: el grafo se construye solo la primera vez que lo consultás, la memoria queda disponible y los hooks inyectan contexto.
- Si decís **que no**, corre `deinit` (flag `disabled`) y no vuelve a molestarte en ese repo.

El consentimiento es **tri-estado** y vive local (git-ignored, en `.leina/consent`): `unknown` → te pregunta una vez · `enabled` → activo · `disabled` → silencio total. leina **nunca** se pone a construir un grafo en un repo que no aceptaste.

Si lo querés hacer a mano:

```bash
leina init <dir>          # adaptativo (ver abajo)
leina init <dir> --build  # además construye el grafo ahora, en foreground
leina deinit <dir>        # saca este repo (consent=disabled) y revierte el wiring
```

**`init` es adaptativo** — escribe solo lo necesario según si blanket está encendido:

- **Con blanket** (lo normal tras `setup`): solo el flag `enabled` + el bloque en `.gitignore`. No escribe `AGENTS.md` ni `.devin/*` porque el share/grant/hooks globales ya cubren el repo.
- **Standalone** (sin `setup`, querés leina solo en este repo sin tocar la máquina): además escribe `AGENTS.md` (protocolo), `.devin/hooks.v1.json` y un grant `Exec(leina)` **local** en `.devin/config.json`. El repo queda autosuficiente y **nunca** se toca el config user-global.

**Probar:**

> "Usando leina, dame el blast radius de `<una función o clase del proyecto>` y mostrame qué memoria tiene cargada."

Si responde con resultados reales del proyecto → **leina está andando**.

#### Otros proyectos

No hay que repetir nada: con blanket, cada repo nuevo te lo ofrece la IA la primera vez. El comando mágico ya está hecho de por vida.

---

## Parte 2 — Qué le podés pedir a la IA una vez instalado

Con leina activo, tu IA (Devin) gana capacidades nuevas que ejecuta como comandos `leina`. Acá está el catálogo.

> 💡 **Tip de subagentes en SDD.** Los hosts con subagentes (Devin, Claude Code) pueden delegar cada fase de SDD a un subagente dedicado con su propio contexto limpio. Para cambios serios (features, refactors, migraciones) eso mejora la calidad: el orquestador integra resultados sin "ensuciarse" con los detalles intermedios.

### 2.1 — Entender el código sin grepearlo

**"¿Qué se rompería si cambio esta función / clase / módulo?"** — La IA usa el grafo (`leina affected`) para calcular el _blast radius_ real: todo lo que depende de ese símbolo, directa o indirectamente. Es lo primero que querés preguntar **antes de renombrar o refactorizar**.

**"¿Cómo se conectan estos dos módulos?"** — Camino más corto entre dos piezas del código (`leina path`), útil para flujos que cruzan muchas capas.

**"¿Dónde se usa este símbolo? / ¿Quién llama a esta función?"** — Respuestas basadas en el grafo, no en `grep`: no pierde llamadas dinámicas ni se confunde con falsos positivos.

**"Explicame qué hace este módulo y con qué interactúa."** — Combina lectura del archivo con la vista estructural del grafo (`leina query`).

### 2.2 — Memoria del proyecto entre sesiones

**"¿Qué decidimos sobre <X> la última vez?"** — La IA consulta la memoria persistente (`leina memory search`) y trae decisiones, bugfixes y descubrimientos guardados.

**"Guardá esta decisión / este descubrimiento para futuras sesiones."** — La IA persiste algo importante (`leina memory save`). Queda disponible para vos y para cualquiera que abra el proyecto en el futuro.

**"Recordame en qué estábamos trabajando."** — Al empezar una sesión, la IA recupera el contexto reciente (`leina memory context`): qué se tocó, qué se decidió, qué quedó pendiente.

**"¿Esta nota sigue siendo válida con el código actual?"** — `leina memory verified` reclasifica cada resultado contra el grafo vivo: **USABLE**, **WARNING** (el código anclado cambió — stale) o **DO-NOT-USE** (una afirmación que el código ahora contradice).

### 2.3 — Spec-Driven Development (SDD) con `leina-sdd`

Para cambios importantes — features nuevas, refactors grandes, migraciones — podés invocar el flujo **SDD**:

> **"Aplicá leina-sdd para <descripción del cambio>."**

#### ¿Qué es SDD?

**Spec-Driven Development** es una forma estructurada de encarar un cambio no trivial. En vez de tirarse a codear directamente, el cambio pasa por **ocho fases** ordenadas:

| Fase | Qué se hace |
|---|---|
| **1. Explore** | Investigar la zona del código, opciones técnicas, restricciones. |
| **2. Propose** | Escribir una propuesta corta: intención, alcance, enfoque. |
| **3. Spec** | Definir los requerimientos y escenarios formales del cambio. |
| **4. Design** | Decidir la arquitectura y el enfoque técnico. |
| **5. Tasks** | Romper el trabajo en una lista ordenada de tareas concretas. |
| **6. Apply** | Implementar las tareas en código. |
| **7. Verify** | Validar que el resultado cumple la spec y el diseño. |
| **8. Archive** | Cerrar el cambio: fusionar specs, dejar todo persistido. |

#### ¿Por qué usarlo?

- **No te saltás pasos**: la IA no empieza a codear sin antes entender qué hay que hacer y por qué.
- **Todo queda documentado** en la memoria del proyecto bajo claves estables (`sdd/<nombre-del-cambio>/<fase>`). Si alguien retoma el cambio mañana, todo el razonamiento está ahí.
- **Decisiones de diseño antes que código**: errores de arquitectura se atrapan en Design, no después de implementar todo. En Design y Tasks, el alcance se mide contra el grafo (`leina affected`) para no adivinar dependencias.
- **Verificación contra la spec**: al final hay un check formal de que lo implementado cumple lo pedido.
- **Reanudable**: si te interrumpen a mitad de fase, podés volver mañana y la IA retoma desde donde dejaste.

#### ¿Cuándo usarlo?

- **Sí**: features nuevas, refactors de arquitectura, migraciones, cambios que tocan varios módulos.
- **No**: fixes triviales, cambios cosméticos, ajustes de un solo archivo. Para esos, una conversación normal con la IA alcanza.

### 2.4 — Trabajar con la salud del grafo

**"¿Está actualizado el grafo del proyecto?"** — `leina status`. Si está desactualizado, las consultas lo reconstruyen solas (modo `auto`, por defecto) o te avisan para refrescarlo explícitamente (modo `refuse`, recomendado en CI).

**"Reconstruí el grafo."** — `leina refresh` regenera el grafo desde cero tras cambios grandes.

---

## Parte 3 — Uso diario

Una vez instalado, el uso diario es sobre todo **no hacer nada**: los hooks trabajan solos y
vos hablás con la IA como siempre. Esta parte cubre el flujo de una sesión típica y los
hábitos que hacen que el sistema rinda de verdad.

### El flujo de una sesión

**Al arrancar** no tenés que preparar nada **en Devin y Claude Code**: ahí el hook de
`SessionStart` ya hizo dos cosas por vos (solo en repos con consentimiento `enabled`):

- **inyectó contexto**: la IA arranca sabiendo las decisiones y sesiones recientes del
  proyecto (el equivalente de `leina memory context`) y el estado del grafo;
- **auto-reparó el grafo**: si no existía o estaba desactualizado, disparó un build en
  segundo plano — la próxima consulta ya lo encuentra fresco.

> **En los demás hosts (vía MCP)** no hay hooks, así que la inyección automática no ocurre —
> pero el efecto es el mismo pidiéndolo: la IA llama las tools `memory_context` / `graph_status`
> on-demand. En cualquier host, forzás el repaso con: _"¿qué sabemos ya de este proyecto? ¿En qué
> quedamos la última vez?"_ — eso se traduce en `memory context` + `memory verified`.

**Durante la sesión**, los dos hábitos que más pagan:

1. **Preguntá antes de tocar.** _"¿Qué se rompe si cambio la firma de `PaymentService`?"_
   (→ `affected`), _"¿cómo llega el CLI a la base de datos?"_ (→ `path`), _"¿qué partes del
   código hablan de reintentos?"_ (→ `query`). Son consultas de milisegundos contra el grafo,
   no re-lecturas del repo — usalas sin culpa, todo el tiempo.
2. **Guardá el porqué apenas lo descubras.** Cuando la IA (o vos) encuentra la causa raíz de
   un bug o toma una decisión de diseño, pedile: _"guardá esto en memoria, anclado a
   `<símbolo>`"_. El anclaje es lo que después permite que `memory verified` te avise si el
   código cambió por debajo de esa decisión.

**Para cambios grandes**, invocá el flujo SDD: _"encaremos esto con SDD"_. La IA orquesta
explore → propose → spec → design → tasks → apply → verify, y en las fases de diseño y
tareas **mide el impacto real con `leina affected`** antes de decidir. Los artefactos de
cada fase quedan en memoria, así que podés cortar y retomar en otra sesión sin perder nada.

**Al cerrar**, si la sesión tuvo sustancia, pedí un resumen: _"cerrá la sesión y guardá un
resumen de lo que hicimos"_ (→ `memory session`). Es lo que la próxima sesión va a leer al
arrancar.

### Qué hacen los hooks sin que se lo pidas (Devin y Claude Code)

> Los hooks son la integración de **Devin y Claude Code** — los dos hosts con un mecanismo de
> hooks. En el resto de los hosts leina se conecta por **MCP**: las mismas capacidades como tools,
> que la IA llama on-demand (sin auto-inyección). Ver el paso 7 de
> [`getting-started`](../GETTING_STARTED.md#7-connect-it-to-your-ai).

| Momento | Qué pasa |
|---|---|
| `SessionStart` | Inyecta memoria reciente + stats del grafo; auto-build en background si el grafo falta o está stale. |
| Durante la sesión | Advisories no bloqueantes: nudges de frescura, sugerencias de memoria relevante. |
| Siempre | Todo es **advisory y fail-open**: un hook jamás bloquea tu trabajo, y en repos sin opt-in (`unknown`/`disabled`) es un no-op silencioso. |

Desactivables: `LEINA_DISABLE_AUTOBUILD=1` apaga el auto-build; `leina deinit` apaga
todo para un repo; `leina disable` para toda la máquina.

### Credenciales para skills que llaman servicios

Cuando una tarea necesita llamar una API autenticada (SonarQube, Jira, una API interna), la
credencial se maneja bajo el contrato **names-not-values**: la IA solo conoce el *nombre* de
la variable, nunca el valor. El flujo:

1. **Vos, una sola vez**: `leina env set SONAR_TOKEN` (prompt oculto — no queda en la
   historia del shell ni en la conversación). También desde `leina tui` → "env vars".
2. **La IA, cada vez**: verifica que el nombre exista (`leina env list` muestra
   `SONAR_TOKEN=squ****`, enmascarado) y lo consume por inyección de proceso:
   `leina env exec --only SONAR_TOKEN -- sh -c 'curl -u "$SONAR_TOKEN:" https://sonar.../api/...'`
   — las comillas simples hacen que el valor se expanda en el proceso hijo, nunca en el
   contexto del modelo.

Si la IA alguna vez te pide que pegues un token en el chat, negate: el patrón correcto es
que te pida correr `leina env set`. La skill incluida `authenticated-api` le enseña este
contrato completo, incluyendo POST con token en el header y las variantes más estrictas.

### Herramientas visuales para vos (no para la IA)

- `leina visualize <dir>` — un HTML interactivo y offline del grafo (búsqueda, filtros,
  comunidades). Ideal para onboarding: _ver_ la arquitectura real, no la del diagrama viejo
  de la wiki.
- `leina audit <dir> --format html` — rutas candidatas source→sink para triage de
  seguridad.
- En monorepos / carpetas con varios repos: `leina workspace visualize` muestra la
  constelación de repos y sus dependencias cruzadas.

---

## Apéndice — Referencia técnica

> Esta sección es para usuarios más técnicos o para troubleshooting. En el uso normal con la IA no la necesitás.

### A.1 — Comandos de la CLI

| Comando | Para qué |
|---|---|
| `leina setup` | **Comando mágico** (una vez por máquina): activate + enciende blanket. |
| `leina disable` | Revierte `setup` por completo (symlinks, config user-global, blanket). |
| `leina activate` / `deactivate` | Pieza global de `setup` (share/symlinks/config user-global) y su inverso. `install-global` = alias deprecado de `activate`. |
| `leina init <dir>` | Da de alta el repo (consent `enabled`). Adaptativo: LIGHT con blanket, FULL standalone. `--build` construye el grafo ahora. |
| `leina deinit <dir>` | Saca el repo (consent `disabled`) y revierte el wiring (strip-inverso). |
| `leina build <dir>` | Construye / re-construye el grafo del proyecto. |
| `leina refresh <dir>` | Fuerza un rebuild completo del grafo. |
| `leina status <dir>` | Indica si el grafo está al día. |
| `leina stats <dir>` | Cuenta nodos y aristas del grafo. |
| `leina affected <dir> <símbolo>` | Blast radius de un símbolo (auto-rebuild si está stale). |
| `leina path <dir> <de> <a>` | Camino más corto entre dos símbolos. |
| `leina query <dir> "<pregunta>"` | Subgrafo relevante a una pregunta. |
| `leina impact analyze <dir> <símbolo>` | Impacto que cruza código→tests→configs→servicios. |
| `leina visualize <dir>` | Exporta un visor HTML interactivo y offline del grafo. |
| `leina memory <dir> <sub>` | Memoria local (`save`/`update`/`search`/`verified`/`get`/`context`/`session`/`session-start`/`suggest-topic`/`current-project`/`merge-projects`/`migrate`). |
| `leina workspace <sub> [dir]` | Multi-repo: `build`/`status`/`detect`/`memory context\|search`/`visualize`. |
| `leina audit [dir]` | Rutas candidatas source→sink + findings (`--format md\|json\|html`). |
| `leina env <sub>` | Credenciales para skills (names-not-values): `set`/`list`/`get`/`unset`/`exec`. |
| `leina sidecar <sub>` | Sidecars C#/Java de precisión compilador: `build`/`status`/`clean`/`verify`. |
| `leina doctor [<dir>]` | Diagnóstico de salud (Node, share, symlinks, proyecto). Read-only. |
| `leina repair [<dir>]` | Rearregla lo que `doctor` encontró roto (solo sobre instalaciones previas). |
| `leina verify [<dir>]` | Mismos checks que `doctor` con exit code accionable (gate de CI). |
| `leina tui` | Consola interactiva: instalar/actualizar, init/deinit, estado, repair, env. |
| `leina events tail [dir]` | Outbox local de eventos (apagado salvo `LEINA_EVENTS_PERSIST=1`). |
| `leina capabilities list` | Las 17 capacidades transport-agnósticas con sus schemas. |

`memory save`/`update`/`get` aceptan `--batch` (array JSON por stdin; `--atomic` en save/update).

### A.2 — Troubleshooting

Si algo no anda — comando no encontrado, "No graph at ...", grafo stale, tests fallando — la receta es siempre la misma:

1. Posicionate en la **raíz del repositorio de leina** (donde clonaste/instalaste la herramienta).
2. Abrí tu IA ahí mismo y **contale el problema con el mensaje de error exacto**.

Con la herramienta apuntando a su propio repo, la IA tiene a mano el código, las skills y la memoria del proyecto, así que en la gran mayoría de los casos diagnostica y soluciona sola (versión de Node, binario fuera del PATH, proyecto sin `build`, posture `refuse`, etc.).

Atajos a mano:

- `command not found: leina` → no está en el PATH; reinstalá con `npm install -g @kolimar/leina` o usá `npm run cli -- <cmd>` desde el clon.
- `No graph at <...>` → no corriste `leina build <dir>` para ese proyecto.
- `Graph is stale (...) posture "refuse"` → corré `leina refresh <dir>`.

#### Windows + Git Bash — `Cannot find module '...\dist\cli\index.js'`

Síntoma típico en Windows cuando se ejecuta el comando **desde Git Bash**: tras un `npm i -g` correcto, `leina` muere con un `MODULE_NOT_FOUND` apuntando a una ruta con la raíz de Git prependida, por ejemplo:

```
Error: Cannot find module 'C:\Program Files\Git\Users\<user>\AppData\Roaming\npm\node_modules\leina\dist\cli\index.js'
```

**No es un problema del paquete** (`leina doctor` lo confirma con el check _CLI entrypoint_). Es que el shim POSIX que genera npm resuelve mal su propio `$0` bajo MSYS/Git Bash y MSYS lo expande anteponiendo `C:\Program Files\Git`. Soluciones (cualquiera sirve):

1. **Ejecutar desde cmd.exe o PowerShell** (no Git Bash). Ahí npm usa los shims `.cmd`/`.ps1`, que resuelven la ruta bien:
   ```cmd
   leina --help
   ```
2. **Llamar a node directo** sobre el archivo instalado (saltea el shim por completo):
   ```cmd
   node "%APPDATA%\npm\node_modules\leina\dist\cli\index.js" --help
   ```
3. **Wrapper en `~/.bashrc`** si querés seguir en Git Bash:
   ```bash
   leina() { node "$APPDATA/npm/node_modules/leina/dist/cli/index.js" "$@"; }
   ```

> Los comandos de ciclo de vida (`leina setup`/`activate`/`init`) detectan Git Bash en Windows y `leina doctor` agrega un check _shell interop_ (warn) que reimprime esta misma receta con la ruta exacta de tu instalación. (El paquete no usa `postinstall` a propósito: pnpm y bun omiten los scripts de dependencias por defecto.)

### A.3 — Cómo fluye la información (mental model corto)

- **El grafo** se construye **localmente** y vive en `<tu-proyecto>/.leina/graph.db`. Es un índice estructural del código (qué llama a qué, qué importa a qué, qué hereda de qué). Cuando le preguntás a la IA _"¿qué se rompe si toco esto?"_, no está releyendo el repo: corre `leina affected`, que consulta ese grafo. Se reconstruye solo cuando detecta que los fuentes cambiaron.
- **La memoria** vive en una DB **global**, en `~/.leina/memory.db` (respeta `$LEINA_HOME`), particionada por una clave de proyecto derivada — o sea, es compartida entre todos tus repos, no por-proyecto. Ahí se guardan decisiones, bugfixes, descubrimientos y los artefactos de SDD. La IA escribe con `leina memory save` y lee con `leina memory context`/`search`/`verified`. (Una `memory.db` heredada por-repo se puede migrar a la global con `leina memory migrate <dir>`.)
- **No hay puente intermedio**: la IA corre el binario `leina` por su shell, recibe la respuesta acotada (un subgrafo o un puñado de observaciones) y deja de grepear el repo entero.

#### ¿Y la memoria del equipo? ¿Se commitea o no?

La carpeta `.leina/` del proyecto (que contiene `graph.db`) **no se commitea por defecto** — es runtime, pesa, y el grafo se regenera solo. La memoria **no vive ahí**: está en la DB global `~/.leina/memory.db`. Lo que **sí** se commitea es la configuración (`AGENTS.md`, `.gitignore`, `.devin/hooks.v1.json`) para que cualquiera que clone el repo arranque con leina activo. Si querés compartir el grafo con la VM de Devin cloud, podés commitear el artefacto portable: `leina build . --json` genera `.leina/graph.json` (commiteable, a diferencia del `.db`).
