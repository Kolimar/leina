// Fixture: src/api.test.ts — archivo de test para el fixture mixed-repo.
// Importa apiHandler para que el BFS pueda alcanzarlo desde el módulo api.ts.

import { apiHandler } from "./api.ts";

// Minimal test fixture (no test runner needed — solo verifica que compila).
const result = apiHandler({ path: "/health" });
if (result.status !== 200) throw new Error("expected 200");
