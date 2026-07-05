# Benchmarks

Arnés reproducible: `npm run bench -- <repoDir> [--symbol <name>] [--runs N]`
(`scripts/benchmark.ts`). Cada ejecución cronometrada es un **proceso CLI nuevo**, de
modo que el arranque del proceso queda incluido — que es exactamente lo que un agente
paga por cada comando. Los comandos de lectura reportan la mediana de N ejecuciones;
los builds se ejecutan una vez en frío (grafo + caché de extracción borrados) y una
vez en caliente.

## Qué medir en tus propios repos

- **build (en frío)** — primer build: parseo completo de todos los archivos.
- **rebuild (en caliente)** — el mismo build con la caché de extracción por archivo ya
  poblada: solo los archivos modificados se vuelven a parsear (TypeScript igual
  ejecuta su chequeo de tipos de programa completo — eso es lo que hace que sus edges
  sean de calidad de compilador).
- **stats / affected / query** — la ruta de lectura que un agente realmente usa a
  mitad de sesión.

## Ejecución de referencia (el propio repo de leina, dogfooding)

258 archivos, 1.8k nodes, 4.1k edges — Node 26, linux-x64:

| medición | mediana ms |
|---|---:|
| build (en frío, sin caché) | ~2500 |
| rebuild (caché de extracción en caliente) | ~2200 |
| stats | ~120 |
| affected (un símbolo) | ~130 |
| query (lenguaje natural) | ~150 |

Notas sobre la forma de estos números:

- La ruta de lectura se mantiene cerca del piso de arranque de ~0.15s: la pesada pila
  del extractor solo la cargan `build`/`refresh`.
- Este repo está dominado por TypeScript (241/258 archivos vía ts-morph), así que el
  rebuild en caliente ahorra poco aquí — la caché se amortiza en repos políglotas donde
  predominan los archivos de tree-sitter. `leina build <dir> --profile` muestra
  exactamente en qué se va el tiempo en tu repo.

## Comparación frente a un flujo basado en grep

La comparación honesta no es el tiempo de reloj, son **tokens y turnos**: `affected`
responde "¿qué se rompe si toco X?" en un solo comando con una respuesta transitiva y
determinista; un flujo de grep necesita una búsqueda por salto además de que el modelo
lea cada coincidencia. Ejecuta ambos contra un símbolo con dependientes indirectos y
cuenta lo que el agente tuvo que ingerir.

Los números para repos públicos (zod, gson, Dapper — el conjunto de validación de
precisión de extracción) pertenecen a este archivo tal como se (re)midan; ejecuta el
arnés y envía la tabla en un PR.
