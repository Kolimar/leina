# Contribuir a leina

¡Gracias por tu interés en mejorar leina! Los issues y pull requests son bienvenidos.
Leé también el [Código de Conducta](CODE_OF_CONDUCT.md).

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

Empezá por [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md) para saber qué hace cada comando.
Para encontrar el código detrás de uno, seguí el dispatcher: `src/cli/main.ts` enruta cada
comando a un handler en `src/cli/handlers/<familia>.ts` (`graph.ts`, `memory.ts`, `harness.ts`,
`install.ts`, …), que llama a los use-cases de `src/application/`.
`npm run cli -- query src "<pregunta>"` responde lo mismo desde el grafo del propio leina.
Las reglas de capas se hacen
cumplir dos veces: por `test/architecture.test.ts` y por los bloques `no-restricted-imports`
en `eslint.config.js` — una dependencia que apunta en el sentido equivocado falla en ambos.
Si cambiás uno de los dos mecanismos de control, cambiá el otro.

## Pautas para pull requests

- **Los tests acompañan al comportamiento.** Los comandos, flags o fixes nuevos vienen con un
  test en `test/` (la suite es `node:test` plano; seguí el nombrado `(prefix-N)` que usan los
  tests vecinos). `npm test` corre `test/*.test.ts` y `test/use-cases/*.test.ts`.
- **Los tests no dejan rastro.** Un test que corre la CLI o toca estado global apunta `HOME`
  y `LEINA_HOME` a un directorio temporal, y un test que construye o extrae un grafo de
  `test/fixtures/*` trabaja sobre una copia (`copyFixture` en `test/helpers/fixture-copy.ts`):
  un build escribe `.leina/` bajo la raíz que extrae, y una caché de extracción vieja que
  quede en un fixture la reusaría la corrida siguiente.
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
  `docs/CLI_REFERENCE.md` y su entrada en la tabla de comandos `src/cli/commands.ts` — la
  única fuente de la ayuda raíz, de `leina <command> --help` y de la validación de flags del
  dispatcher (un flag no declarado se rechaza como error de uso; `test/cli-help.test.ts`
  cubre la tabla).

## Reportar bugs

Abrí un issue con el comando que corriste, la salida completa (incluyendo stderr), tu sistema
operativo y `node --version`. La salida de `leina doctor` casi siempre es útil — es de solo
lectura y muestra de dónde se resuelve cada cosa.
