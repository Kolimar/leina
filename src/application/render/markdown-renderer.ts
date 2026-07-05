// application/render/markdown-renderer.ts
// MarkdownRenderer — renders an AuditPack as Markdown using the normative format from spec.
//
// Implements Renderer<AuditPack>:
//   path    = "" (caller writes content to stdout)
//   content = full Markdown document (deterministic — sorted HIGH→MEDIUM→LOW, id ASC)
//
// Normative format (spec §Formato Markdown):
//   # Audit Report — {projectName}
//   > Generado: {builtAt ISO 8601}
//   ⚠ {DISCLAIMER}
//   ---
//   ## Resumen   (table HIGH/MEDIUM/LOW counts)
//   ---
//   ## Findings  (HIGH → MEDIUM → LOW; id ASC within each group)
//   ### [{SEVERITY}] {title}
//   ...
//   ---

import type { Renderer } from "../../domain/artifact/renderer.ts";
import type { AuditPack } from "../audit/pack.ts";
import type { Finding, FindingSeverity } from "../../domain/findings/model.ts";

export interface MarkdownRendererOpts {
  projectName?: string;
}

const SEV_ORDER: Record<FindingSeverity, number> = {
  HIGH:   0,
  MEDIUM: 1,
  LOW:    2,
};

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sevDiff = SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function countBySeverity(findings: Finding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

function renderFinding(f: Finding): string {
  const lines: string[] = [];

  lines.push(`### [${f.severity}] ${f.title}`, "");
  lines.push(`**ID:** \`${f.id}\`  **Tipo:** \`${f.type}\`  **Confianza:** \`${f.confidence}\``, "");
  lines.push(f.description, "");

  lines.push("**Ruta de evidencia:**", "");
  lines.push("| # | De | A | Relación | Confianza |");
  lines.push("|---|----|----|----------|-----------|");
  f.evidence.steps.forEach((step, i) => {
    lines.push(`| ${i + 1} | \`${step.from}\` | \`${step.to}\` | \`${step.relation}\` | \`${step.confidence}\` |`);
  });
  lines.push("");

  const repos = f.evidence.reposTraversed.length > 0
    ? f.evidence.reposTraversed.join(", ")
    : "(ninguno)";
  lines.push(`**Repos:** ${repos}`, "");

  const related = f.relatedNodes.length > 0
    ? f.relatedNodes.join(", ")
    : "_(ninguno)_";
  lines.push(`**Nodos relacionados:** ${related}`, "");

  lines.push("**Acciones sugeridas:**");
  for (const action of f.suggestedActions) {
    lines.push(`- ${action}`);
  }
  lines.push("", "---");

  return lines.join("\n");
}

export class MarkdownRenderer implements Renderer<AuditPack> {
  private readonly projectName: string;

  constructor(opts?: MarkdownRendererOpts) {
    this.projectName = opts?.projectName ?? "";
  }

  render(pack: AuditPack): { path: ""; content: string } {
    const { findings = [], disclaimer, builtAt } = pack;
    const sorted = sortFindings(findings);
    const counts = countBySeverity(findings);
    const generatedAt = new Date(builtAt).toISOString();

    const header = this.projectName ? `# Audit Report — ${this.projectName}` : "# Audit Report";

    const lines: string[] = [
      header,
      `> Generado: ${generatedAt}`,
      "",
      `⚠ ${disclaimer}`,
      "",
      "---",
      "",
      "## Resumen",
      "",
      "| Severity | Findings |",
      "|----------|----------|",
      `| HIGH     | ${counts.HIGH}      |`,
      `| MEDIUM   | ${counts.MEDIUM}      |`,
      `| LOW      | ${counts.LOW}      |`,
      "",
      "---",
      "",
      "## Findings",
      "<!-- Orden: HIGH → MEDIUM → LOW; dentro de cada severity: id ASC (lexicográfico) -->",
      "",
    ];

    if (sorted.length === 0) {
      lines.push("_(Sin findings)_", "");
    } else {
      for (const f of sorted) {
        lines.push(renderFinding(f));
        lines.push("");
      }
    }

    // Trailing newline
    const content = `${lines.join("\n").trimEnd()  }\n`;
    return { path: "", content };
  }
}
