import { Factory, hostSpec, parser } from "./collisions";

export function useCollisions(): void {
  hostSpec("x");
  parser().parse();
  new Factory().create();
}
