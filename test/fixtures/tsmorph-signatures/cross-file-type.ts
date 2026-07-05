// Cross-file type used WITHOUT explicit annotation on the parameter.
// Exercises the resolved-fallback cleanup path that strips `import("...").`.
import type { Payload } from "./other-types";

// No annotation on `p` — relies on inference + cleanup.
export function process(p = { id: "" } as Payload) {
  return p.id;
}
