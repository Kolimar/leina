// Test-support path classification shared by the graph reads (seed ranking, query
// relevance, impact categorisation).
//
// A node whose source file lives under a test/mock/fixture directory, or is named like a
// test file, is "test-like": it should never win a seed tie against production code and it
// is noise in a query answer unless the caller asks for tests.

// Directory segments that hold tests or test doubles (case-insensitive, any depth).
const TEST_DIR_RE =
  /(^|\/)(test|tests|__tests__|spec|specs|__mocks__|mocks?|fixtures?|__fixtures__|testdata|e2e)(\/|$)/i;
// File names: foo.test.ts, foo.spec.js, foo_test.go, test_foo.py.
const TEST_FILE_RE = /\.(test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+$/i;

/** True when `path` (repo-relative or absolute, either separator) is test-like. */
export function isTestLikePath(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  return TEST_DIR_RE.test(p) || TEST_FILE_RE.test(p);
}
