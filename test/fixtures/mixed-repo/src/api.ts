// Fixture: src/api.ts — código TypeScript para el fixture mixed-repo.
// El docker-compose.yml referencia este archivo vía build.context,
// generando el bridge real código→infra que testea impact analyze.

export function apiHandler(req: { path: string }): { status: number; body: string } {
  if (req.path === "/health") {
    return { status: 200, body: "ok" };
  }
  return { status: 404, body: "not found" };
}

export function parseRequest(raw: string): { path: string } {
  return { path: raw.split(" ")[1] ?? "/" };
}
