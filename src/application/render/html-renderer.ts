// application/render/html-renderer.ts
// HtmlRenderer — thin adapter over renderAuditHtml; delegates 100% (D4).
//
// Design D4: byte-idéntico a llamada directa a renderAuditHtml.
// Golden audit.html NOT affected: renderAuditHtml never reads pack.findings.
//
// Implements Renderer<AuditPack>:
//   path    = "audit-graph.html"
//   content = output of renderAuditHtml(pack, visJs, opts)
//
// Note: no TypeScript parameter properties — incompatible with --experimental-strip-types.

import type { Renderer } from "../../domain/artifact/renderer.ts";
import type { AuditPack } from "../audit/pack.ts";
import { renderAuditHtml, type AuditRenderOpts } from "../audit/audit-html-export.ts";

export class HtmlRenderer implements Renderer<AuditPack> {
  private readonly visJs: string;
  private readonly opts: AuditRenderOpts;

  constructor(visJs: string, opts: AuditRenderOpts) {
    this.visJs = visJs;
    this.opts = opts;
  }

  render(pack: AuditPack): { path: "audit-graph.html"; content: string } {
    const { content } = renderAuditHtml(pack, this.visJs, this.opts);
    return { path: "audit-graph.html", content };
  }
}
