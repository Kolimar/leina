// Language detection by extension. Drives which extractor handles a file.

export type Lang =
  | "javascript"
  | "typescript"
  | "tsx"
  | "go"
  | "python"
  | "java"
  | "csharp"
  | "kotlin"
  | "rust"
  | "ruby"
  | "php";

const EXT_TO_LANG: Record<string, Lang> = {
  ".js": "javascript",
  ".jsx": "tsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".go": "go",
  ".py": "python",
  ".pyi": "python",
  ".java": "java",
  ".cs": "csharp",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
};

// Languages that ALSO have a semantic sidecar (Roslyn/JDT). When a sidecar is
// configured they use it (compiler-grade); otherwise they fall back to the
// tree-sitter path above.
export type SemanticLang = "csharp" | "java";

export function detectLang(path: string): Lang | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

export function semanticLangOf(path: string): SemanticLang | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot).toLowerCase();
  if (ext === ".cs") return "csharp";
  if (ext === ".java") return "java";
  return null;
}
