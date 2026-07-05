# Audit Report — demo
> Generado: 1970-01-01T00:00:00.000Z

⚠ NOTICE: This output is evidence for triage — these are CANDIDATE PATHS, NOT confirmed vulnerabilities or exploits. They represent potential data-flow routes that require qualified human review before any action is taken. leina audit does not generate exploits, payloads, or attack code.

---

## Resumen

| Severity | Findings |
|----------|----------|
| HIGH     | 1      |
| MEDIUM   | 0      |
| LOW      | 0      |

---

## Findings
<!-- Orden: HIGH → MEDIUM → LOW; dentro de cada severity: id ASC (lexicográfico) -->

### [HIGH] command-injection: handleRequest → child_process.exec

**ID:** `abcdef1234567890`  **Tipo:** `command-injection`  **Confianza:** `INFERRED`

Potential command-injection vulnerability: tainted data flows from handleRequest to child_process.exec through 2 hop(s).

**Ruta de evidencia:**

| # | De | A | Relación | Confianza |
|---|----|----|----------|-----------|
| 1 | `fn:handleReq` | `fn:process` | `calls` | `EXTRACTED` |
| 2 | `fn:process` | `__sink__exec` | `calls` | `INFERRED` |

**Repos:** repo-a, repo-b

**Nodos relacionados:** fn:process

**Acciones sugeridas:**
- Nunca interpolar input del usuario en comandos de shell.
- Usar APIs parametrizadas (execFile con array de args, sin shell: true).
- Aplicar validación de input y allowlist de comandos permitidos.

---
