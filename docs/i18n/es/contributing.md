# Contribuir a leina

¡Gracias por tu interés en mejorar leina! Los issues y pull requests son bienvenidos.

## Setup de desarrollo

Requisitos: **Node ≥ 22.13** (se recomienda Node ≥ 24 — ver el readme para saber por qué). No
hace falta ningún paso de build para desarrollar: la CLI corre TypeScript directamente.

```bash
git clone <repo-url> && cd leina
npm install
npm run cli -- --help        # run the CLI from source
npm test                     # full test suite (node:test, no external runner)
npm run typecheck            # tsc --noEmit
npm run lint                 # eslint (zero warnings tolerated); lint:fix autofixes
```

Útil durante el desarrollo:

```bash
npm run cli -- build src          # dogfood: build the graph of leina itself
npm run cli -- affected src "GraphStore"
npm run test:coverage             # lcov + spec reporters into coverage/
```

## Arquitectura en dos minutos

El árbol de código es hexagonal — las dependencias apuntan solo hacia adentro:

```
domain/          types + ports (no I/O, no Node APIs beyond types)
application/     use cases over the ports
infrastructure/  adapters (SQLite, tree-sitter, filesystem, sidecars)
cli/             driving adapter: dispatcher + handlers + composition root (wiring.ts)
```

Empezá por [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md) — cada comando documenta el
punto de entrada de implementación que hay detrás, y la tabla *Implementation map* al final
es la forma más rápida de encontrar el archivo que necesitás. Las reglas de capas se hacen
cumplir dos veces: por `test/architecture.test.ts` y por los bloques `no-restricted-imports`
en `eslint.config.js` — una dependencia que apunta en el sentido equivocado falla en ambos.
Si cambiás uno de los dos mecanismos de control, cambiá el otro.

## Pautas para pull requests

- **Los tests acompañan al comportamiento.** Los comandos, flags o fixes nuevos vienen con un
  test en `test/` (la suite es `node:test` plano; seguí el nombrado `(prefix-N)` que usan los
  tests vecinos).
- **`npm test`, `npm run typecheck` y `npm run lint` tienen que pasar.** CI corre los tres en
  Node 22 y 24. El gate de lint tolera cero warnings; un hallazgo de una regla de seguridad
  que revisaste y juzgaste seguro recibe un `eslint-disable-next-line` inline con el
  razonamiento después del `--`, nunca un cambio de regla general.
- **Mantené rápido el camino de lectura.** El stack pesado de extracción (tree-sitter,
  ts-morph) se importa de forma perezosa a propósito; no agregues imports estáticos de eso al
  dispatcher ni a los handlers del camino de consulta.
- **La reversibilidad es una característica.** Cualquier cosa que escriba en la máquina o el
  repo de un usuario necesita un inverso y debe respetar el flag de consentimiento (ver los
  handlers de instalación para el patrón).
- **La documentación viaja con el cambio.** Si agregás o cambiás un comando o flag, actualizá
  `docs/CLI_REFERENCE.md` (y la ayuda raíz en `src/cli/handlers/system.ts` — un test verifica
  que cada familia de comandos esté listada ahí).

## Reportar bugs

Abrí un issue con el comando que corriste, la salida completa (incluyendo stderr), tu sistema
operativo y `node --version`. La salida de `leina doctor` casi siempre es útil — es de solo
lectura y muestra de dónde se resuelve cada cosa.
