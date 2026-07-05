// application/render/json-renderer.ts
// JsonRenderer — serializes an AuditPack as pretty-printed JSON.
//
// Implements Renderer<AuditPack>:
//   path    = "" (caller writes content to stdout)
//   content = JSON.stringify(pack, null, 2)

import type { Renderer } from "../../domain/artifact/renderer.ts";
import type { AuditPack } from "../audit/pack.ts";

export class JsonRenderer implements Renderer<AuditPack> {
  render(pack: AuditPack): { path: ""; content: string } {
    return {
      path: "",
      content: JSON.stringify(pack, null, 2),
    };
  }
}
