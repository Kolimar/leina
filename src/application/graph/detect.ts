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

// Directories whose code is not the project's own product code: tests and their fixtures,
// vendored third-party code, examples/samples/demos, benchmarks. A language that only
// appears there (leina's own test/fixtures/Sample.cs) must not trigger "install a compiler
// sidecar for <lang>" advice.
const AUXILIARY_DIRS = new Set([
  "test", "tests", "__tests__", "spec", "specs", "e2e", "testdata", "test-data",
  "fixture", "fixtures", "__fixtures__", "__mocks__",
  "vendor", "third_party", "third-party", "thirdparty",
  "example", "examples", "sample", "samples", "demo", "demos",
  "bench", "benchmark", "benchmarks",
]);

// Test files by naming convention (Go, JS/TS, Python, Java, C#, Ruby, PHP, Rust tests dir aside).
const TEST_FILE_RE = /(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|[\\/])test_[^\\/]*\.py|_test\.py|(?:^|[\\/])conftest\.py|Tests?\.(?:java|cs|kt)|_spec\.rb|Test\.php)$/;

/**
 * True for a source path (relative to the project root, either separator) that belongs to
 * tests, fixtures, vendored code or examples rather than the project's own product code.
 */
export function isAuxiliarySourcePath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/);
  segments.pop();
  if (segments.some((s) => AUXILIARY_DIRS.has(s.toLowerCase()))) return true;
  return TEST_FILE_RE.test(relPath);
}

export function semanticLangOf(path: string): SemanticLang | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot).toLowerCase();
  if (ext === ".cs") return "csharp";
  if (ext === ".java") return "java";
  return null;
}
