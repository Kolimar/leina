// eslint.config.js — flat config: clean-code presets + the hexagonal layering rules.
//
// The layering blocks mirror test/architecture.test.ts (the runtime guard) rule for
// rule, so a violation fails BOTH the linter and the test suite. If you change one,
// change the other.

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

// The heavy extractor stack must stay out of the startup module graph (arch-rule-2/5):
// static imports are allowed only inside src/infrastructure/extractors/.
const HEAVY_EXTRACTOR_LIBS = [
  {
    name: "web-tree-sitter",
    message: "Lazy-load the extractor stack: use `await import(...)` (static imports allowed only in src/infrastructure/extractors/).",
  },
  {
    name: "ts-morph",
    message: "Lazy-load the extractor stack: use `await import(...)` (static imports allowed only in src/infrastructure/extractors/).",
  },
];

export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", "node_modules/", "assets/", "docs/", "test/fixtures/", "*.html"],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  security.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // -- clean code -------------------------------------------------------
      // node:test's test()/suite() return a Promise by design; calling them bare at
      // top level is the canonical runner idiom, not a lost promise.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", name: ["test", "suite", "describe", "it"], package: "node:test" },
          ],
        },
      ],
      eqeqeq: ["error", "smart"],
      complexity: ["error", { max: 20 }],
      "max-depth": ["error", 4],
      "no-else-return": "error",
      "prefer-template": "error",
      // disallowTypeAnnotations:false — `typeof import("…")` annotations are the
      // canonical way to type lazy-loaded modules, which this CLI relies on.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports", disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Hexagonal ports are Promise-typed; sync adapters legitimately implement them
      // with `async` and no `await`. The real bugs are caught by no-floating-promises
      // and no-misused-promises, both of which stay on.
      "@typescript-eslint/require-await": "off",
      // For strings, `||` is usually the intent: an EMPTY description/stderr/label must
      // fall through to the fallback, which `??` would keep. Numbers/objects still get ??.
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true } }],

      // A CLI writes to stdout/stderr for a living.
      "no-console": "off",

      // -- security plugin noise control -------------------------------------
      // These two rules flag every dynamic path/index access; in a filesystem-walking
      // CLI that is nearly every line. The remaining security rules stay on.
      "security/detect-object-injection": "off",
      "security/detect-non-literal-fs-filename": "off",
    },
  },

  // -- hexagonal layering (mirrors test/architecture.test.ts) -----------------

  // arch-rule-1: domain/ is pure — no imports from outer layers, no heavy libs.
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: HEAVY_EXTRACTOR_LIBS,
          patterns: [
            {
              group: ["**/application/**", "**/infrastructure/**", "**/cli/**"],
              message: "src/domain/ is the innermost layer: it must not import from application/, infrastructure/, or cli/.",
            },
          ],
        },
      ],
    },
  },

  // arch-rule-3: application/ reaches infrastructure only through ports — never
  // the raw infra modules below (and never the heavy extractor libs statically).
  {
    files: ["src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...HEAVY_EXTRACTOR_LIBS,
            {
              name: "node:sqlite",
              message: "src/application/ must not touch SQLite directly — depend on a domain port and let infrastructure/ implement it.",
            },
            {
              name: "node:child_process",
              message: "src/application/ must not spawn processes directly — depend on a domain port and let infrastructure/ implement it.",
            },
          ],
        },
      ],
    },
  },

  // arch-rule-4: infrastructure/ never imports the cli/ driving adapter.
  {
    files: ["src/infrastructure/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: HEAVY_EXTRACTOR_LIBS,
          patterns: [
            {
              group: ["**/cli/**"],
              message: "src/infrastructure/ must not depend on the cli/ driving adapter (outermost layer).",
            },
          ],
        },
      ],
    },
  },

  // arch-rule-2/5 carve-out: ONLY infrastructure/extractors/ may statically import
  // the heavy libs (still no cli/ imports).
  {
    files: ["src/infrastructure/extractors/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/cli/**"],
              message: "src/infrastructure/ must not depend on the cli/ driving adapter (outermost layer).",
            },
          ],
        },
      ],
    },
  },

  // cli/ may compose everything, but keeps the read path fast: no static heavy libs.
  {
    files: ["src/cli/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: HEAVY_EXTRACTOR_LIBS }],
    },
  },

  // -- tests: pragmatic relaxations -------------------------------------------
  {
    files: ["test/**/*.ts"],
    rules: {
      // Fixtures and assertions legitimately use non-null (`!`) and loose shapes.
      "@typescript-eslint/no-non-null-assertion": "off",
      // E2E tests JSON.parse the CLI's stdout and assert over the untyped result;
      // forcing casts there adds ceremony without safety.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/unbound-method": "off",
      // No-op callbacks and regexes built from expected strings are test staples.
      "@typescript-eslint/no-empty-function": "off",
      "security/detect-non-literal-regexp": "off",
      "security/detect-unsafe-regex": "off",
      "security/detect-child-process": "off",
      complexity: "off",
    },
  },

  // The config file itself is plain JS — no type information available.
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
