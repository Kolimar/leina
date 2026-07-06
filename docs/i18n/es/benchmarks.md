# Benchmarks

Números reales y reproducibles — sin redondeo de marketing. Cada cifra de abajo es la
salida directa del arnés, re-ejecutable a demanda.

Arnés reproducible: `npm run bench -- <repoDir> [--symbol <name>] [--runs N] [--json]`
(`scripts/benchmark.ts`). Cada ejecución cronometrada es un **proceso CLI nuevo**, así
que el arranque del proceso queda incluido — que es exactamente lo que un agente paga
por cada comando. Los comandos de lectura corren un calentamiento descartado (absorbe el
costo, una vez por sesión, de la primera lectura en frío de `graph.db`) y luego N
ejecuciones cronometradas; reportamos **mediana (p50)** y **p95** de la latencia en
estado estacionario. Los builds corren una vez en frío (grafo + caché de extracción
borrados) y una vez en caliente.

## Qué significa cada medición

- **build (en frío)** — primer build: parseo completo de todos los archivos.
- **rebuild (en caliente)** — el mismo build con la caché de extracción por archivo ya
  poblada: solo los archivos modificados se vuelven a parsear (TypeScript igual ejecuta
  su chequeo de tipos de programa completo — eso es lo que hace sus edges de calidad de
  compilador).
- **ruta de lectura** — `stats / affected / query / impact / audit / memory / context`:
  los comandos que un agente realmente invoca a mitad de sesión.

## Ejecución de referencia — el propio repo de leina (dogfooding)

**316 archivos · 2.085 nodes · 4.648 edges** — Node 26.4, linux-x64, AMD Ryzen 9 7900X3D,
21 ejecuciones, medido el 2026-07-06. JSON crudo: [`bench/results/leina-selfhost.json`](../../../bench/results/leina-selfhost.json).

### Ruta de lectura — cada comando responde en ~⅛ de segundo

<!-- barras generadas desde bench/results/leina-selfhost.json (p50); escala = 200ms -->
<div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5rem 0">
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">stats</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:62%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">123 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">affected</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:64%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">128 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">impact analyze</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:64%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">127 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">memory search</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:66%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">131 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">context build (hook)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:66%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">132 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">query (lenguaje natural)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:78%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">156 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">audit (source→sink)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:96%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">191 ms</span></div>
</div>

| medición | p50 ms | p95 ms |
|---|---:|---:|
| stats | 123 | 128 |
| affected `main` | 128 | 132 |
| impact analyze `main` | 127 | 133 |
| memory search | 131 | 137 |
| context build (hook de sesión) | 132 | 138 |
| query (lenguaje natural) | 156 | 161 |
| audit (source→sink) | 191 | 196 |

Toda la ruta de lectura queda dentro de **~70 ms del piso de arranque de proceso de
~120 ms** — la pesada pila del extractor solo la cargan `build`/`refresh`, nunca las
lecturas.

### Build — frío vs caliente, y en qué se va el tiempo

<!-- barras generadas desde bench/results/leina-selfhost.json; escala = 3000ms -->
<div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5rem 0">
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">build (frío, sin caché)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:98%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 5rem;opacity:.7">2930 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">rebuild (caché caliente)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:94%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 5rem;opacity:.7">2808 ms</span></div>
</div>

Desglose por etapa del build en frío (`build --profile`, 2.602 ms total) — **el 80 % es
el chequeo de tipos de programa completo de TypeScript**, que es lo que compra los edges
de calidad de compilador:

<!-- barras generadas desde bench/results/leina-selfhost.json profile; escala = total 2602ms -->
<div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5rem 0">
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">extract: ts-morph (291 arch.)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:80%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#8b5cf6,#ec4899)"></span></span><span style="flex:0 0 5rem;opacity:.7">2079 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">extract: sidecar java (2)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:13%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#8b5cf6,#ec4899)"></span></span><span style="flex:0 0 5rem;opacity:.7">340 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">extract: tree-sitter (14)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:3.4%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#8b5cf6,#ec4899)"></span></span><span style="flex:0 0 5rem;opacity:.7">89 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">communities (Louvain)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:1.2%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#8b5cf6,#ec4899)"></span></span><span style="flex:0 0 5rem;opacity:.7">32 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">persist (SQLite)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:1%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#8b5cf6,#ec4899)"></span></span><span style="flex:0 0 5rem;opacity:.7">26 ms</span></div>
</div>

Este repo está dominado por TypeScript (291/316 archivos vía ts-morph), así que la caché
en caliente ahorra poco aquí — se amortiza en repos políglotas donde predominan los
archivos de tree-sitter. `leina build <dir> --profile` muestra exactamente en qué se va
el tiempo en tu repo.

### Cross-corpus — el read path es plano sin importar el tamaño del repo

El mismo arnés, corrido contra [`zod`](https://github.com/colinhacks/zod) (un repo externo
de TypeScript no relacionado, 418 archivos). Crudo: [`zod-speed.json`](../../../bench/results/zod-speed.json),
[`zod-tokens.json`](../../../bench/results/zod-tokens.json).

| corpus | archivos | build frío | read path (rango p50) | respuesta token vs piso grep |
|---|---:|---:|---:|---:|
| leina (propio) | 316 | 2.93 s | 123–191 ms | 504 tok vs 123k (**244×**) |
| zod (externo) | 418 | 5.07 s | 122–188 ms | 651 tok vs 100k (**154×**) |

El build escala con la cantidad de archivos (repo más grande → parseo más largo), pero **el
read path casi no se mueve** — las lecturas pegan a índices SQLite, no al extractor, así que
`affected`/`impact`/`query` quedan cerca del mismo piso de ~130 ms tenga el grafo 2k o 6k
edges. zod además invierte el modo de fallo de grep de la Fase 2: ahí un grep textual de
`ZodType` matchea **38** archivos pero solo **27** son dependientes reales — grep sobre-matchea
(comentarios, strings) donde en leina sub-matcheaba. leina devuelve los 27 exactos igual.

## Ejecútalo en tu propio repo

```
npm run bench -- /ruta/a/tu/repo --symbol algunaFuncion --runs 21 --json
```

El bloque `--json` del final es machine-readable — commitéalo junto a este archivo y
envía la tabla en un PR. Los corpus de validación externos (zod, gson, Dapper — el
conjunto de precisión de extracción) van aquí a medida que se midan.

## Ahorro de tokens — responder "¿qué se rompe si toco X?"

El tiempo de reloj es la mitad fácil. El número que de verdad mueve el costo de un agente
son los **tokens gastados en responder una pregunta estructural**. `leina impact analyze X`
devuelve el *conjunto de impacto* de X — los archivos conectados estructuralmente a él (lo
que depende de X y lo que X usa) — como una lista JSON compacta. Sin grafo, un agente tiene
que *leer código fuente* para derivar, y verificar, el mismo conjunto. Arnés: `bench/tokens.ts`.

Tres baselines deterministas, sin LLM en el loop, todos contados con el **mismo
tokenizer** (`gpt-tokenizer`, cl100k, exacto):

<!-- barras generadas desde bench/results/tokens-buildGraph.json; escala lineal, max = 847.101; leina con piso visible -->
<div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5rem 0">
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">leina <code>impact analyze</code></span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:0.9%;min-width:6px;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#10b981,#34d399)"></span></span><span style="flex:0 0 8rem;opacity:.85">504 tok · 1 cmd</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">a mano (grep + abrir hits)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:6.2%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 8rem;opacity:.7">52.3k tok ⚠</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">piso grep-flow (leer impactados)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:14.5%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 8rem;opacity:.7">123k tok</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">volcado del repo (cota sup.)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:100%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 8rem;opacity:.7">847k tok</span></div>
</div>

Símbolo `buildGraph` (45 archivos en su conjunto de impacto), el propio repo de leina — 307
archivos fuente, 847k tokens en total. Crudo: [`bench/results/tokens-buildGraph.json`](../../../bench/results/tokens-buildGraph.json).

| baseline (misma pregunta, sin grafo) | tokens | archivos a leer | vs leina |
|---|---:|---:|---:|
| leina `impact analyze --json` | **504** | 0 (la respuesta *es* la lista) | 1× |
| a mano — grep del símbolo, abrir cada hit | 52.321 | 18 ⚠ | 104× |
| piso grep-flow — leer cada archivo impactado | 123.146 | 45 | 244× |
| volcado del repo entero | 847.101 | 307 | 1681× |

**Leé las salvedades honestas — importan más que el multiplicador:**

- Esto es **costo de descubrimiento, no de edición.** leina te dice *cuáles* 45 archivos
  se afectan en 504 tokens; si después tenés que editar los 45, los leés igual. El ahorro
  está en *encontrar* el conjunto, que es justo donde un agente grep quema tokens y turnos.
- **⚠ el "a mano" es más barato porque está *mal*.** El grep textual encuentra 18 archivos;
  leina encuentra 45. Los 27 que se pierde son dependientes transitivos/indirectos que grep
  no puede seguir. Así que el baseline más barato es también el incompleto — el ahorro de
  tokens y el acierto de *corrección* son la misma historia (ver precisión, abajo).
- **El tokenizer casi no importa.** Cambiar el tokenizer exacto cl100k por una estimación
  cruda `chars/3.6` mueve cada ratio menos de 2% — porque el ahorro es un ratio y cada fila
  usa el mismo estimador. El multiplicador no es un artefacto del tokenizer.

Ejecútalo en tu repo: `node --experimental-strip-types bench/tokens.ts <repo> <símbolo> --json`.

## Recall de recuperación — ¿`affected` recupera los dependientes verificables?

Para un grafo de dependencias, la pregunta de precisión honesta es el recall: cuando
preguntás "¿quién depende de X?", ¿`affected` devuelve los archivos que realmente lo hacen?
El oráculo es verificable y no circular — todo archivo con un `import` directo de X desde
dentro del repo (una *cota inferior* estricta de los dependientes reales). Arnés:
`bench/precision/run.ts`. También cuenta los dependientes **transitivos** que leina revela
*más allá* de ese piso de imports — los indirectos que un flujo grep-de-imports nunca alcanza.

El resultado se parte nítido, y honestamente, por tipo de símbolo:

<!-- barras desde bench/results/precision-{value,type}.json; escala = 100% recall -->
<div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5rem 0">
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">símbolos-valor (fn / clase)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:95%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#10b981,#34d399)"></span></span><span style="flex:0 0 7rem;opacity:.85">95.1% recall</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">símbolos solo-tipo (interfaz)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:4.5%;min-width:6px;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 7rem;opacity:.7">4.5% recall</span></div>
</div>

| tipo de símbolo | dependientes-import verificables | recuperados | recall |
|---|---:|---:|---:|
| valor (funciones, clases) — calls/refs/implements | 41 | 39 | **95.1%** |
| solo-tipo (interfaces, type aliases) | 111 | 5 | **4.5%** |

Crudo: [`precision-value.json`](../../../bench/results/precision-value.json), [`precision-type.json`](../../../bench/results/precision-type.json).

**Qué dice esto de verdad — la limitación es el titular, no una nota al pie:**

- **En dependencias de valor leina es casi completo (95%)** y suma alcance transitivo real:
  recupera casi todo archivo que llama, referencia o implementa un símbolo, *más* los
  dependientes indirectos que una búsqueda textual de imports se pierde.
- **En dependencias solo-tipo leina está hoy ciego (~5%).** `affected GraphNode` reporta
  "nada depende de él" mientras 50 archivos importan ese tipo. leina modela aristas de
  *valor* (call/reference/implements), no de *anotación de tipo* — así que cambiar la forma
  de una interfaz aún no lo avisa `affected`. Es un gap real y documentado, no un error de
  redondeo, y el benchmark existe justo para mantenernos honestos sobre eso.
- El arnés también atrapó una anomalía específica — una función muy llamada reportando cero
  dependientes — ahora registrada como bug de extracción. Un benchmark que nunca encuentra
  nada mal no está midiendo nada.

Límites del método, dichos claro: el oráculo cuenta `import`s internos de una y varias
líneas (se pierde re-exports e imports dinámicos), y es una *cota inferior* — así que el
recall acá es conservador. Extender el corpus a repos externos y a un set etiquetado por
commits se registra bajo `bench/precision/`.
