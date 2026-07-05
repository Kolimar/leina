# Primeros pasos — para quien nunca usó leina

Esta guía asume que nunca usaste leina antes. Seguila de arriba abajo.

> 🌐 **¿Preferís un recorrido guiado, estilo preguntas y respuestas, en español?** Mirá
> [`docs/guides/usage-guide.md`](guides/usage-guide.md) — mismo terreno, otro ángulo ("qué
> le puedo pedir a la IA"), más un recorrido completo de SDD.

**leina es una CLI** — no hay ningún servidor que conectar. Construís un grafo una vez y
después lo consultás (junto con una memoria de proyecto local) a través de comandos `leina`. Un
host de IA como Devin ejecuta esos mismos comandos por su shell; el `AGENTS.md` commiteado le
indica cómo hacerlo.

> **Placeholders usados en toda la guía** — reemplazalos por tus rutas reales:
> - `<leina>` — la carpeta donde clonaste/descargaste este repo (solo aplica a la forma de clon).
> - `<your-project>` — la ruta absoluta al código que querés que la IA entienda
>   (por ejemplo `D:\work\my-app` en Windows, `/home/you/my-app` en Linux/macOS).

---

## 1. Instalá Node 22.13+ (se recomienda Node 24+)

```bash
node --version      # debe ser v22.13.0 o superior
```

leina usa el `node:sqlite` incorporado (sin dependencias nativas) y ejecuta TypeScript
directamente — no hace falta paso de build. Node 22.13.0 es el mínimo (el primer 22.x Active LTS
donde `node:sqlite` está disponible sin el flag `--experimental-sqlite`).

**Se recomienda fuertemente Node 24+.** En Node 22/23, la búsqueda de memoria corre en modo
degradado LIKE (sin porter stemming ni ranking BM25 — solo coincidencia de substring). Se imprime
una advertencia en stderr en cada comando `memory`. Para obtener la calidad completa de búsqueda
de texto, actualizá:

```bash
# con fnm
fnm install 24 && fnm use 24

# con nvm
nvm install 24 && nvm use 24
```

O descargalo desde https://nodejs.org.

## 2. Instalá y configurá leina (una vez por máquina)

**Recomendado — instalación global.** Pone el binario `leina` en tu PATH, y luego `setup` hace
todo a nivel de máquina en un solo paso — puebla el share de skills/agents, lo symlinkea en los
directorios globales de Devin, escribe el grant `Exec` user-global + los hooks, y activa el
**modo blanket**:

```bash
npm install -g leina
leina setup              # el comando "mágico" de un solo paso
```

Después de `setup`, leina está disponible en cada sesión de Devin. Para deshacer todo a nivel de
máquina más adelante, ejecutá `leina disable`.

**O desde un clon** (contribuidores, o para correr el último código sin publicar):

```bash
cd <leina>
npm install
npm run cli -- setup
```

> Los comandos de más abajo están escritos como `leina <cmd>` (instalación global). Desde un
> clon, usá `npm run cli -- <cmd>` en su lugar — por ejemplo `npm run cli -- build <your-project>`.

> **¿Preferís las piezas por separado?** `setup` compone `activate` (share/symlinks/config
> user-global globales, sin blanket); su inverso es `deactivate`. `install-global` es un alias
> deprecado de `activate`.

## 3. Construí el grafo de TU proyecto

```bash
leina build <your-project>
```

Esto escribe `<your-project>/.leina/graph.db`. Ese archivo `.db` *es* el grafo. Rara vez lo
reconstruís a mano: `query`/`affected`/`path` reconstruyen automáticamente un grafo stale antes
de responder, y los hooks de Devin que instala `init` ejecutan un `refresh` después de cada
edición.

> ✅ Chequeo de salud: `leina stats <your-project>` debería imprimir un conteo de nodos/aristas.
> Si dice 0 nodos, la ruta está mal o el proyecto no tiene archivos soportados.

---

## 4. Sumá un proyecto — `leina init` (generalmente automático)

Con el modo blanket activo (desde `setup`), **normalmente no ejecutás esto a mano**. La primera
vez que usás Devin en un repo, la skill `leina-setup` pregunta una sola vez — "¿usar leina acá?"
— y ejecuta `init` (Sí) o `deinit` (No) por vos. Cada repo mantiene un **flag de consentimiento
local, git-ignored** (`.leina/consent`): `unknown` → se pregunta una vez, `enabled` → activo,
`disabled` → silencio. leina nunca construye un grafo en un repo al que no te sumaste.

Para hacerlo a mano:

```bash
leina init <your-project> [--profile devin|windsurf] [--freshness auto|refuse] [--build] [--name <project-name>]
leina deinit <your-project>    # opt out: consent=disabled + retira el wiring
```

`init` es **adaptativo** — siempre escribe el flag de consentimiento `enabled` y el bloque de
`.gitignore`, y luego escribe solo lo que hace falta:

- **LIGHT (blanket activo):** nada más. El share/grant/hooks a nivel de máquina de `setup` ya
  cubren el repo, así que `AGENTS.md` y `.devin/*` serían redundantes.
- **FULL (standalone, sin blanket):** también escribe el bloque de protocolo `AGENTS.md`
  commiteable, el `.devin/hooks.v1.json` con alcance de proyecto, y un grant `Exec(leina)`
  **repo-local** en `.devin/config.json` — dejando el repo autocontenido. **Nunca** toca el
  `~/.config/devin/config.json` user-global.

`init` **no** hace auto-build; pasá `--build` para construir el grafo sincrónicamente ahora
(de lo contrario se construye a demanda la primera vez que consultás). `--name <project-name>`
fija la clave del proyecto en un `.leina/config.json` commiteable. Usá `--freshness refuse` para
configuraciones de grafo commiteado / CI (una lectura stale pide un rebuild en vez de dispararlo).

---

## 5. Consultá el grafo

```bash
leina affected <your-project> "GraphStore"      # blast radius: quién depende de esto
leina query <your-project> "how does the CLI reach the database"
leina path <your-project> "run" "GraphStore"    # camino más corto entre dos símbolos
leina status <your-project>                     # ¿está stale el grafo respecto del código?
leina stats <your-project>                      # conteo de nodos/aristas + confianza
leina refresh <your-project>                    # fuerza un rebuild completo
```

`query` / `affected` / `path` pasan por la **freshness gate**: bajo la postura por defecto
`auto` reconstruyen un grafo stale antes de responder; bajo `refuse` te indican que corras
`refresh` primero.

## 6. Memoria de proyecto (el *porqué*)

La memoria persiste decisiones, causas raíz de bugs y descubrimientos en una DB **global** en
`~/.leina/memory.db` (respetando `$LEINA_HOME`), particionada por una clave de proyecto
derivada — así que sobrevive entre sesiones y se comparte entre todos tus repos. (Una
`<your-project>/.leina/memory.db` heredada por-repo se puede plegar en la DB global con
`leina memory migrate <your-project>`.)

```bash
leina memory save <your-project> --title "..." --content "..." [--type decision] [--topic key] [--anchors Sym1,Sym2]
leina memory search <your-project> "a question"
leina memory verified <your-project> "a question"   # drift-checked: USABLE / WARNING / DO-NOT-USE
leina memory get <your-project> <id>
leina memory context <your-project>                 # sesiones recientes + últimas observaciones
leina memory update <your-project> <id> [--content "..."]
leina memory session <your-project> --content "session summary"
```

`--anchors` vincula una observación a símbolos reales del grafo, de modo que `memory verified`
pueda después re-chequear cada nota guardada contra el grafo vivo (detección de drift: si el
código anclado cambió, la nota se marca como stale/WARNING en vez de confiarse silenciosamente).

**Batch (JSON por stdin).** `save`, `update` y `get` aceptan `--batch` para colapsar muchas
escrituras/lecturas en un solo proceso (`--atomic` para save/update):

```bash
echo '[{"title":"a","content":"x"},{"title":"b","content":"y"}]' \
  | leina memory save <your-project> --batch --atomic
echo '["id1","id2"]' | leina memory get <your-project> --batch
```

---

## 7. Usalo con Devin

No hay nada que registrar: el `AGENTS.md` commiteado lo lee Devin automáticamente (cloud +
CLI), así que el protocolo de uso viaja con el repo, y el `init` que escribe el
`.devin/hooks.v1.json` mantiene el grafo fresco después de las ediciones y empuja al agente
hacia la CLI. Simplemente hacele preguntas a Devin sobre el código — por ejemplo *"¿cuál es el
blast radius de `GraphStore`?"* — y va a correr `leina affected` / `query` por su cuenta.

Para Devin (cloud, corre en una VM), hacé que `leina` esté disponible en el snapshot de la VM
vía Repository Setup → *Install Dependencies* (por ejemplo `npm install -g leina`). Para un
grafo commiteado, corré `leina build . --json` y commiteá `.leina/graph.json` (el `.db` está
git-ignored; el `graph.json` portable es lo que se commitea) e inicializá con
`init` con `--freshness refuse`.

---

## Solución de problemas

**`command not found: leina`**
- La instalación global no está en el PATH; reinstalá con `npm install -g leina`, o usá la
  forma de clon (`npm run cli -- <cmd>` desde `<leina>`).

**`No graph at <...>` al correr una consulta**
- Todavía no hiciste `build` de ese proyecto (paso 3): `leina build <your-project>`.

**`Graph is stale (...) but freshness posture is "refuse"`**
- Corriste `init --freshness refuse`. Reconstruí explícitamente: `leina refresh <your-project>`.

**`No node matches "..."` desde `affected`/`path`**
- Las etiquetas se emparejan por display label; las funciones se muestran como `name()`.
  Revisá `leina stats` o probá con otra capitalización, por ejemplo `affected . "GraphStore"`.

**Las llamadas de C# / Java se ven sintácticas / EXTRACTED bajo**
- Estas obtienen resolución de nivel compilador de los sidecars semánticos (Roslyn para C#,
  JavaParser para Java). Sus fuentes se distribuyen como plantillas `.tmpl`; construí uno a
  demanda con `leina sidecar build [csharp|java]`, que cachea un binario autocontenido bajo
  `~/.leina/sidecars/<lang>/dist` (no hace falta .NET/JVM para ejecutarlo después). Sin un
  sidecar, el lenguaje cae de vuelta a tree-sitter y de todos modos construye — solo que de
  forma sintáctica (~23% de las aristas de llamada de C# / ~15% de Java quedan AMBIGUOUS).
  Sobreescribí la ubicación del binario con `LEINA_CSHARP_SIDECAR` / `LEINA_JAVA_SIDECAR`.
  Mirá la sección "Semantic sidecars" del README.
