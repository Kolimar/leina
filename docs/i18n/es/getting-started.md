# Primeros pasos

¿Es tu primera vez con leina? Seguí esta guía de arriba abajo — son tres comandos y un par de
preguntas.

> 🌐 **¿Preferís un recorrido estilo preguntas y respuestas** ("qué le puedo pedir a la IA"), más
> un tour completo de SDD? Mirá [`docs/guides/usage-guide.md`](guides/usage-guide.md).

**leina es una CLI.** No hay ningún servicio en segundo plano que levantar ni mantener. La instalás una vez, la apuntás a un
código para construir un **grafo de conocimiento** (qué depende de qué, qué se rompe si tocás algo)
y obtenés una **memoria de proyecto** (decisiones, causas raíz de bugs, descubrimientos) que
sobrevive entre sesiones. Tu host de IA — Devin, Claude Code, Cursor, Windsurf — razona sobre esa
estructura en vez de re-leer el repo en cada conversación.

> **Un placeholder usado abajo** — reemplazalo por tu ruta real:
> - `<your-project>` — la ruta absoluta al código que querés que la IA entienda
>   (por ejemplo `/home/you/my-app`, o `D:\work\my-app` en Windows).

---

## Inicio rápido

Tres comandos y listo:

```bash
npm install -g @kolimar/leina        # 1. instalar (necesita Node 22.13+, se recomienda 24+)
leina tui                            # 2. elegí "install" → tu host de IA + MCP
leina build <your-project>           # 3. construí el grafo de tu código
```

Eso es todo — tu IA ya conoce tu código. Opcional: `leina visualize <your-project>` para *ver* el
grafo en tu navegador. El resto de la guía explica cada paso y qué pedirle a tu IA.

---

## 1. Instalá Node 22.13+ (se recomienda Node 24+)

```bash
node --version      # tiene que ser v22.13.0 o superior
```

leina usa el `node:sqlite` incorporado (sin dependencias nativas) y corre TypeScript directamente
— sin paso de build. Node 22.13.0 es el mínimo; **se recomienda fuertemente Node 24+** — en 22/23
la búsqueda en memoria corre en modo degradado LIKE (match por substring, sin ranking BM25) e
imprime un warning en cada comando `memory`. Actualizá con `fnm install 24 && fnm use 24`,
`nvm install 24 && nvm use 24`, o bajalo de https://nodejs.org.

## 2. Instalá leina y abrí la consola de setup

```bash
npm install -g @kolimar/leina
leina tui
```

`leina tui` es la base interactiva — manejás todo el setup desde un menú en vez de memorizar flags.
Elegí **install** y te va guiando por:

- **qué grupos de assets** instalar (skills, agents, hooks — `core` siempre va incluido);
- **en qué hosts de IA** enlazar los skills/agents — **Devin** y **Claude Code**, los dos hosts que
  consumen los archivos de skill/agent de leina de forma nativa;
- **modo blanket** — cada repo se auto-configura con un prompt de consentimiento único, así nunca
  más das de alta un proyecto a mano;
- **registro MCP** — expone las herramientas de leina (`graph_affected`, `memory_search`, …) como
  tools nativas a **Claude Code, Cursor, Windsurf** — y, a mano, a *cualquier* IA compatible con MCP
  (Codex, Gemini CLI, LM Studio, …; ver paso 7).

El mismo TUI después maneja todo: **status** (resumen de salud), **this project**
(init/deinit + `.mcp.json` por repo), **repair**, **env vars** (credenciales enmascaradas para
skills) y **uninstall**. Cada acción mapea a un comando no-interactivo, así que nada acá es
exclusivo del TUI.

> **¿Preferís un solo comando sin prompts?** `leina setup --hosts devin,claude` hace la
> instalación recomendada (todos los assets + modo blanket) de una; agregá `--mcp --mcp-hosts
> claude` para registrar el server MCP también. Deshacé todo más tarde con `leina disable`.

Verificá que quedó bien:

```bash
leina --help
leina doctor        # chequea versión de Node, el share global y los enlaces a los hosts
```

## 3. Apuntá leina a tu proyecto

```bash
leina build <your-project>
```

Esto escribe `<your-project>/.leina/graph.db` — ese archivo `.db` **es** el grafo. Rara vez
reconstruís a mano: las consultas reconstruyen solas un grafo desactualizado antes de responder, y
los hooks instalados lo refrescan tras cada edición.

> ✅ Chequeo rápido: `leina stats <your-project>` debería imprimir conteos de nodos/aristas.
> `0 nodes` significa que la ruta está mal o el proyecto no tiene archivos soportados.

**Dar de alta un proyecto.** Con el modo blanket encendido (del paso 2), no lo hacés a mano — la
primera vez que usás tu IA en un repo te pregunta una vez, *"¿usás leina acá?"*, y lo configura por
vos. Cada repo guarda un flag de consentimiento local y git-ignored (`.leina/consent`): `unknown` →
te pregunta una vez, `enabled` → activo, `disabled` → silencio. leina nunca construye un grafo en un
repo que no aceptaste. Para hacerlo a mano: `leina init <your-project> --hosts claude --profile devin` (agregá `--build` para
construir ahora) / `leina deinit <your-project>`.

## 4. Mirá tu código como un grafo

Hay **dos** herramientas distintas para ver el grafo — se parecen (mismo visor) pero **no** son
intercambiables. Elegí según lo que necesites:

**`leina visualize`** — exporta un **archivo HTML** estático, offline y autocontenido que podés
compartir, commitear o abrir para siempre:

```bash
leina visualize <your-project>          # escribe <your-project>/.leina/graph.html
```

Nodos agrupados y coloreados por capa, dimensionados según qué tan conectados están, con los
principales "god nodes" etiquetados. Clic en un nodo para su panel de detalle; búsqueda, filtro por
carpeta, freeze de la física. Es un *snapshot* de un proyecto — ideal para onboarding o mandarle a
alguien la arquitectura real.

**`leina graph serve`** — levanta un **server local en vivo** con cosas que un archivo estático no
puede tener: un **selector multi-proyecto** y la **memoria anclada** de cada nodo (con badge de drift):

```bash
leina graph serve <your-project>        # explorador HTTP read-only en http://127.0.0.1:7423 (Ctrl+C para cortar)
```

|  | `leina visualize` | `leina graph serve` |
|---|---|---|
| Salida | un **archivo** `.html` | un **server** corriendo (`:7423`) |
| Vive | para siempre, offline | solo mientras corre el proceso |
| Alcance | el proyecto que le pasás | todos los proyectos construidos (selector) |
| Muestra memoria | no | sí — por nodo, con badge de drift |
| Compartir / commitear | sí (es un archivo) | no (solo loopback) |
| Usalo para | compartir un snapshot, onboarding, offline | explorar en vivo, ver memoria, varios repos |

**Un vistazo al explorador** — `graph serve` corriendo sobre el propio código de leina:

![El explorador con GraphStore seleccionado: su panel de detalle lista las conexiones agrupadas (llama a, lo referencian, implementa, métodos) y las últimas memorias ancladas al nodo, cada una con un badge de drift.](assets/screenshots/graph-serve-node-detail.jpg)

Seleccioná cualquier nodo para abrir su panel de detalle: arriba sus conexiones agrupadas, y abajo las últimas decisiones y notas **ancladas** a él — cada una con badge de drift, para ver de un vistazo si la nota sigue coincidiendo con el código actual.

![Una vista ampliada del grafo: clases y tipos individuales con las aristas entre ellos.](assets/screenshots/graph-serve-graph.jpg)

Al hacer zoom el mapa se lee claro — los nodos están coloreados por tipo (function, class, interface, module…) y las aristas muestran quién llama, implementa o referencia a quién.

## 5. Consultá el grafo

```bash
leina affected <your-project> "GraphStore"      # blast radius: quién depende de esto
leina query <your-project> "cómo llega el CLI a la base de datos"
leina path <your-project> "run" "GraphStore"    # camino más corto entre dos símbolos
leina status <your-project>                     # ¿está el grafo desactualizado vs el código?
leina stats <your-project>                      # conteos de nodos/aristas + confianza
leina refresh <your-project>                    # fuerza un rebuild completo
```

`query` / `affected` / `path` pasan por el **freshness gate**: bajo la posture `auto` (por defecto)
reconstruyen un grafo stale antes de responder; bajo `refuse` te dicen que corras `refresh` primero
(usá `refuse` para setups con grafo commiteado / CI).

## 6. Memoria de proyecto (el *porqué*)

La memoria persiste decisiones, causas raíz de bugs y descubrimientos en una DB **global** en
`~/.leina/memory.db` (respeta `$LEINA_HOME`), particionada por una clave de proyecto derivada — así
sobrevive entre sesiones y se comparte entre todos tus repos.

```bash
leina memory save <your-project> --title "..." --content "..." [--type decision] [--anchors Sym1,Sym2]
leina memory search <your-project> "una pregunta"
leina memory verified <your-project> "una pregunta"   # drift-check: USABLE / WARNING / DO-NOT-USE
leina memory context <your-project>                   # sesiones recientes + últimas observaciones
leina memory session <your-project> --content "resumen de la sesión"
```

`--anchors` liga una nota a símbolos reales del grafo, así `memory verified` puede re-chequearla
contra el grafo vivo después — si el código anclado cambió, la nota se marca stale en vez de
confiarse en silencio.

## 7. Conectalo a tu IA

leina llega a tu IA por dos vías. **MCP es el camino universal — arrancá por ahí, y configurá solo
el/los host(s) que realmente usás.**

### A. Server MCP — anda con cualquier IA compatible con MCP (recomendado)

leina trae un server MCP estándar, que se lanza por stdio como `leina mcp`. Cualquier host que hable
MCP llama sus herramientas (`graph_affected`, `memory_search`, `graph_visualize`, …) de forma nativa
— sin protocolo de shell.

**Hosts que leina configura por vos** — un comando (o elegí "MCP" en `leina tui`, o `leina setup --mcp --mcp-hosts claude`):

```bash
leina mcp register --hosts claude,cursor,windsurf   # listá solo los que usás
leina mcp status                                    # por host: registrado o no
leina mcp unregister --hosts cursor                 # inverso
```

**Cualquier otro host** — agregás leina a la config MCP propia de ese host. El entry del server es
siempre el mismo comando; solo cambian el archivo y la clave que lo envuelve. La mayoría usa la forma
estándar `mcpServers`:

```json
{ "mcpServers": { "leina": { "command": "leina", "args": ["mcp"] } } }
```

| Host | Cómo agregarlo | Archivo de config · clave |
|---|---|---|
| Claude Code | `leina mcp register --hosts claude` (o `claude mcp add --scope user leina -- leina mcp`) | `~/.claude.json` / proyecto `.mcp.json` · `mcpServers` |
| Cursor | `leina mcp register --hosts cursor` | `~/.cursor/mcp.json` o `.cursor/mcp.json` · `mcpServers` |
| Windsurf | `leina mcp register --hosts windsurf` | `~/.codeium/windsurf/mcp_config.json` · `mcpServers` |
| VS Code (Copilot) | `code --add-mcp '{"name":"leina","command":"leina","args":["mcp"]}'` | `.vscode/mcp.json` · **`servers`** † |
| OpenAI Codex CLI | `codex mcp add leina -- leina mcp` | `~/.codex/config.toml` · **`[mcp_servers.leina]`** (TOML) † |
| Gemini CLI | `gemini mcp add leina leina mcp` | `~/.gemini/settings.json` o `.gemini/settings.json` · `mcpServers` |
| LM Studio | editar config y reiniciar la app | `~/.lmstudio/mcp.json` · `mcpServers` |
| Zed | Agent Panel → Add Custom Server, o editar settings | `~/.config/zed/settings.json` o `.zed/settings.json` · **`context_servers`** † |
| Cline (VS Code) | ícono MCP Servers → Configure | `cline_mcp_settings.json` de Cline · `mcpServers` |
| JetBrains AI Assistant / Junie | Settings → Tools → AI Assistant → MCP, o el `mcp.json` de Junie | `~/.junie/mcp/mcp.json` / `.junie/mcp/mcp.json` · `mcpServers` |

† Tres hosts lo envuelven distinto — mismo command/args, otra forma:

```jsonc
// VS Code — la clave es `servers`, agregá "type": "stdio"
{ "servers": { "leina": { "type": "stdio", "command": "leina", "args": ["mcp"] } } }
```
```toml
# OpenAI Codex — ~/.codex/config.toml
[mcp_servers.leina]
command = "leina"
args = ["mcp"]
```
```jsonc
// Zed — la clave es `context_servers`, agregá "source": "custom"
{ "context_servers": { "leina": { "source": "custom", "command": "leina", "args": ["mcp"], "env": {} } } }
```

Una vez registrado, solo preguntá — *"¿cuál es el blast radius de `GraphStore`?"* — y la IA llama
`graph_affected` sola. Cada tool toma un argumento `root`, que por defecto es el directorio donde el
host lanzó el server. (Los formatos de config cambian seguido — si un host rechaza el entry, mirá su
doc MCP actual; el comando de lanzamiento `leina mcp` no cambia nunca.)

### B. Hooks — contexto de sesión automático (solo Devin y Claude Code)

Además de MCP, dos hosts pueden **inyectar** automáticamente la memoria reciente + el estado del
grafo al arrancar cada sesión (y mantener el grafo fresco tras cada edición), así la IA conoce el
proyecto antes de que escribas — sin llamar ninguna tool:

- **Devin** lee el `AGENTS.md` commiteado + `.devin/hooks.v1.json` automáticamente (cloud + CLI).
  Para Devin cloud (una VM), hacé que `leina` esté disponible en el snapshot vía Repository Setup →
  *Install Dependencies* (`npm install -g @kolimar/leina`).
- **Claude Code** obtiene lo mismo vía `.claude/settings.json` — incluí `claude` en `--hosts`
  al instalar (`leina init <your-project> --hosts claude --profile devin`, o elegí Claude Code
  durante la instalación). Si querés forzar los hooks de Claude Code aunque el host `claude` no
  esté en `--hosts`, agregá `--claude-hooks` (por ejemplo,
  `leina init <your-project> --hosts devin --profile devin --claude-hooks`).

Cualquier otro host no tiene mecanismo de hooks, así que no puede auto-inyectar — pero por MCP la IA
trae el mismo contexto on-demand (`memory_context`, `graph_status`). Por eso MCP es el camino que
recomendamos para todos.

Para un grafo commiteado (CI, o compartir con Devin cloud), corré `leina build . --json` y commiteá
`.leina/graph.json` — el `.db` está git-ignored; el `.json` portable es lo que commiteás — y después
`init` con `--freshness refuse`.

---

> **¿Contribuís a leina o corrés código sin publicar?** Ese es el único motivo para trabajar desde
> un clon en vez de la instalación global — el setup de desarrollo (`git clone`, `npm install`,
> `npm run cli -- <cmd>`) vive en [`CONTRIBUTING.md`](../CONTRIBUTING.md), no acá.

---

## Solución de problemas

**`command not found: leina`**
- La instalación global no está en el PATH; reinstalá con `npm install -g @kolimar/leina`, o usá la
  forma de clon (`npm run cli -- <cmd>`).

**`No graph at <...>` al correr una consulta**
- Todavía no hiciste `build` de ese proyecto (paso 3): `leina build <your-project>`.

**`Graph is stale (...) but freshness posture is "refuse"`**
- Corriste `init --freshness refuse`. Reconstruí explícitamente: `leina refresh <your-project>`.

**`No node matches "..."` desde `affected`/`path`**
- Las etiquetas se matchean por display label; las funciones se muestran como `name()`. Revisá
  `leina stats` o probá otra capitalización, por ejemplo `affected . "GraphStore"`.

**Llamadas C# / Java se ven sintácticas / EXTRACTED bajo**
- Estas obtienen resolución nivel-compilador de los sidecars semánticos (Roslyn para C#, JavaParser
  para Java). Construí uno on demand con `leina sidecar build [csharp|java]`, que cachea un binario
  autocontenido bajo `~/.leina/sidecars/<lang>/dist` (no hace falta .NET/JVM para correrlo después).
  Sin sidecar el lenguaje cae a tree-sitter e igual construye — solo que sintácticamente. Mirá la
  sección "Semantic sidecars" del README.
