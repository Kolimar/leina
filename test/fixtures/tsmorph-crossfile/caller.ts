import { target } from "./callee";
import { target as aliased } from "./callee";
import defaultTarget from "./callee";
import { target as reTarget } from "./reexport";
import * as ns from "./callee";

export function caller(): void {
  target();
  aliased();
  defaultTarget();
  reTarget();
  ns.target();
}
