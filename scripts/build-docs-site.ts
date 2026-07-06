// build-docs-site.ts — Generate a self-contained, bilingual (EN/ES) static HTML
// site covering leina's whole user-facing documentation. The output is a single
// index.html that embeds every page (both language variants) as JSON and renders
// it client-side with marked + mermaid (loaded from CDN). No build dependencies:
//   node --experimental-strip-types scripts/build-docs-site.ts
//
// Regenerable + idempotent: re-running on unchanged sources yields identical HTML.
//
// Each page has a "native" language (its single source of truth, maintained by
// hand) and a "translated" counterpart under docs/i18n/<lang>/. Both are read
// here; neither is preferred at render time — the site just shows whichever
// language the reader has selected.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const OUT_DIR = join(REPO_ROOT, "site");
const OUT_FILE = join(OUT_DIR, "index.html");

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  repository?: { url?: string };
};
const repoUrl = (pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
const GITHUB_BLOB_BASE = repoUrl ? `${repoUrl}/blob/main/` : null;

type Lang = "en" | "es";
type Section = "overview" | "guides" | "reference" | "concepts" | "project";

interface PageDef {
  id: string;
  section: Section;
  nativeLang: Lang;
  en: string;
  es: string;
}

const p = (...parts: string[]): string => join(REPO_ROOT, ...parts);

const PAGES: PageDef[] = [
  { id: "index", section: "overview", nativeLang: "en", en: p("readme.md"), es: p("docs/i18n/es/index.md") },
  { id: "getting-started", section: "guides", nativeLang: "en", en: p("docs/GETTING_STARTED.md"), es: p("docs/i18n/es/getting-started.md") },
  { id: "usage-guide", section: "guides", nativeLang: "es", en: p("docs/i18n/en/usage-guide.md"), es: p("docs/guides/usage-guide.md") },
  { id: "cli-reference", section: "reference", nativeLang: "en", en: p("docs/CLI_REFERENCE.md"), es: p("docs/i18n/es/cli-reference.md") },
  { id: "concepts-readme", section: "concepts", nativeLang: "es", en: p("docs/i18n/en/concepts/README.md"), es: p("docs/concepts/README.md") },
  { id: "concepts-01-arquitectura", section: "concepts", nativeLang: "es", en: p("docs/i18n/en/concepts/01-arquitectura.md"), es: p("docs/concepts/01-arquitectura.md") },
  { id: "concepts-02-grafo", section: "concepts", nativeLang: "es", en: p("docs/i18n/en/concepts/02-grafo.md"), es: p("docs/concepts/02-grafo.md") },
  { id: "concepts-03-busqueda-y-consultas", section: "concepts", nativeLang: "es", en: p("docs/i18n/en/concepts/03-busqueda-y-consultas.md"), es: p("docs/concepts/03-busqueda-y-consultas.md") },
  { id: "concepts-04-memoria", section: "concepts", nativeLang: "es", en: p("docs/i18n/en/concepts/04-memoria.md"), es: p("docs/concepts/04-memoria.md") },
  { id: "concepts-05-comunicacion-grafo-memoria", section: "concepts", nativeLang: "es", en: p("docs/i18n/en/concepts/05-comunicacion-grafo-memoria.md"), es: p("docs/concepts/05-comunicacion-grafo-memoria.md") },
  { id: "concepts-06-hooks-e-inyeccion", section: "concepts", nativeLang: "es", en: p("docs/i18n/en/concepts/06-hooks-e-inyeccion.md"), es: p("docs/concepts/06-hooks-e-inyeccion.md") },
  { id: "roadmap", section: "project", nativeLang: "en", en: p("docs/ROADMAP.md"), es: p("docs/i18n/es/roadmap.md") },
  { id: "benchmarks", section: "project", nativeLang: "en", en: p("docs/benchmarks/README.md"), es: p("docs/i18n/es/benchmarks.md") },
  { id: "contributing", section: "project", nativeLang: "en", en: p("CONTRIBUTING.md"), es: p("docs/i18n/es/contributing.md") },
  { id: "security", section: "project", nativeLang: "en", en: p("SECURITY.md"), es: p("docs/i18n/es/security.md") },
  { id: "changelog", section: "project", nativeLang: "en", en: p("changelog.md"), es: p("docs/i18n/es/changelog.md") },
];

const SECTION_LABELS: Record<Lang, Record<Section, string>> = {
  en: {
    overview: "Overview",
    guides: "Guides",
    reference: "Reference",
    concepts: "How it works",
    project: "Project",
  },
  es: {
    overview: "Resumen",
    guides: "Guías",
    reference: "Referencia",
    concepts: "Cómo funciona",
    project: "Proyecto",
  },
};

const UI_STRINGS: Record<Lang, { brand: string; loading: string; toggleLabel: string }> = {
  en: { brand: "leina · docs", loading: "Loading…", toggleLabel: "ES" },
  es: { brand: "leina · documentación", loading: "Cargando…", toggleLabel: "EN" },
};

interface RenderedDoc {
  title: string;
  markdown: string;
}

interface RenderedPage {
  id: string;
  section: Section;
  en: RenderedDoc;
  es: RenderedDoc;
}

// Derive a page title from the first markdown H1 ("# Title"), falling back to
// a humanized id.
function titleOf(markdown: string, id: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(markdown);
  if (m) return m[1]!;
  return id.replace(/^concepts-\d*-?/, "").replace(/-/g, " ");
}

// Expand Devin-only <ref_file>/<ref_snippet> tags into inline code so the
// citation path survives in plain HTML (browsers drop unknown empty tags).
function expandRefTags(md: string): string {
  return md
    .replace(/<ref_snippet\s+file="([^"]+)"\s+lines="([^"]+)"\s*\/>/g, "`$1 (L$2)`")
    .replace(/<ref_file\s+file="([^"]+)"\s*\/>/g, "`$1`");
}

// Map from the absolute resolved path of every page's NATIVE source file to its
// site page id, so cross-doc links (in either language) can be rewritten to
// in-page hash routes instead of 404ing on the published site.
const pageByNativePath = new Map<string, string>();
for (const page of PAGES) {
  pageByNativePath.set(resolve(page.nativeLang === "en" ? page.en : page.es), page.id);
}

// Rewrite markdown links: internal cross-doc links become `#<page-id>` hash
// routes; other links that point at a real file in this repo (LICENSE,
// src/**, test/**, ...) become GitHub blob URLs so they still resolve from
// the published site; everything else (external URLs, in-page anchors,
// images) is left untouched. `baseDir` is the directory of the page's NATIVE
// file — translated counterparts keep the exact same relative link text as
// their native source, so links from either language resolve against it.
function resolveTarget(target: string, baseDir: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // absolute URL (http:, mailto:, ...)
  if (target.startsWith("#")) return null; // in-page anchor

  const [pathPart, anchor] = target.split("#");
  if (!pathPart) return null;
  const abs = resolve(baseDir, pathPart);

  const pageId = pageByNativePath.get(abs);
  if (pageId) return `#${pageId}`;

  if (existsSync(abs) && GITHUB_BLOB_BASE) {
    const rel = relative(REPO_ROOT, abs).split(sep).join("/");
    return `${GITHUB_BLOB_BASE}${rel}${anchor ? `#${anchor}` : ""}`;
  }

  return null;
}

function rewriteLinks(md: string, baseDir: string): string {
  // Badge-style links (`[![alt](img)](url)`) nest a `]` inside the outer link
  // text, which the general single-link pass below can't parse correctly —
  // rewrite the outer target first so e.g. the readme's license badge still
  // resolves from the published site.
  const withBadgesRewritten = md.replace(
    /\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)/g,
    (whole, altText: string, imgUrl: string, target: string) => {
      const rewritten = resolveTarget(target, baseDir);
      return rewritten ? `[![${altText}](${imgUrl})](${rewritten})` : whole;
    },
  );

  return withBadgesRewritten.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, bang: string, text: string, target: string) => {
    if (bang) return whole; // image — leave as-is
    const rewritten = resolveTarget(target, baseDir);
    return rewritten ? `[${text}](${rewritten})` : whole;
  });
}

function loadDoc(sourcePath: string, baseDir: string, id: string): RenderedDoc {
  const raw = readFileSync(sourcePath, "utf8");
  const markdown = rewriteLinks(expandRefTags(raw), baseDir);
  return { title: titleOf(raw, id), markdown };
}

function loadPages(): RenderedPage[] {
  return PAGES.map((page) => {
    const baseDir = dirname(page.nativeLang === "en" ? page.en : page.es);
    return {
      id: page.id,
      section: page.section,
      en: loadDoc(page.en, baseDir, page.id),
      es: loadDoc(page.es, baseDir, page.id),
    };
  });
}

function escapeForScriptTag(json: string): string {
  return json.replace(/</g, "\\u003c");
}

function renderHtml(pages: RenderedPage[]): string {
  const payload = escapeForScriptTag(JSON.stringify(pages));
  const sectionLabels = escapeForScriptTag(JSON.stringify(SECTION_LABELS));
  const uiStrings = escapeForScriptTag(JSON.stringify(UI_STRINGS));
  return PAGE_TEMPLATE.replace("/*__PAGES_JSON__*/", payload)
    .replace("/*__SECTION_LABELS_JSON__*/", sectionLabels)
    .replace("/*__UI_STRINGS_JSON__*/", uiStrings);
}

const PAGE_TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>leina — docs</title>
<style>
  :root {
    --bg: #0f1419; --panel: #161b22; --border: #30363d; --text: #e6edf3;
    --muted: #9da7b3; --accent: #4493f8; --accent-soft: #1f6feb33; --code-bg: #1c2128;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.65; }
  #layout { display: flex; min-height: 100vh; }
  #sidebar { width: 300px; flex-shrink: 0; background: var(--panel); border-right: 1px solid var(--border);
    padding: 24px 16px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  #sidebar-head { display: flex; align-items: center; justify-content: space-between; margin: 0 8px 16px; gap: 8px; }
  #brand { font-size: 14px; font-weight: 600; color: var(--muted); flex: 1; }
  #github-link { display: flex; align-items: center; color: var(--muted); }
  #github-link:hover { color: var(--text); }
  #github-link svg { width: 20px; height: 20px; }
  #lang-toggle { background: var(--accent-soft); border: 1px solid var(--accent); color: var(--text);
    border-radius: 6px; padding: 4px 10px; font-size: 12px; font-weight: 600; cursor: pointer; letter-spacing: .04em; }
  #lang-toggle:hover { background: var(--accent); color: #fff; }
  #nav-list h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted);
    margin: 20px 0 8px 8px; }
  #nav-list h2:first-child { margin-top: 4px; }
  .nav-link { display: block; padding: 8px 12px; margin-bottom: 2px; border-radius: 8px; color: var(--text);
    text-decoration: none; font-size: 14px; border: 1px solid transparent; }
  .nav-link:hover { background: var(--accent-soft); }
  .nav-link.active { background: var(--accent-soft); border-color: var(--accent); color: #fff; }
  #main { flex: 1; min-width: 0; display: flex; justify-content: center; }
  #content { max-width: 860px; width: 100%; padding: 48px 40px 120px; }
  #content h1 { font-size: 2rem; border-bottom: 1px solid var(--border); padding-bottom: .3em; margin-top: 0; }
  #content h2 { font-size: 1.5rem; margin-top: 2em; border-bottom: 1px solid var(--border); padding-bottom: .25em; }
  #content h3 { font-size: 1.2rem; margin-top: 1.6em; }
  #content a { color: var(--accent); text-decoration: none; }
  #content a:hover { text-decoration: underline; }
  #content code { background: var(--code-bg); padding: .15em .4em; border-radius: 6px; font-size: 85%;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  #content pre { background: var(--code-bg); padding: 16px; border-radius: 10px; overflow-x: auto; border: 1px solid var(--border); }
  #content pre code { background: none; padding: 0; font-size: 13px; }
  #content blockquote { border-left: 4px solid var(--accent); margin: 1.2em 0; padding: .4em 1em;
    background: var(--accent-soft); border-radius: 0 8px 8px 0; color: var(--text); }
  #content table { border-collapse: collapse; width: 100%; margin: 1.2em 0; font-size: 14px; }
  #content th, #content td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
  #content th { background: var(--code-bg); }
  #content tr:nth-child(even) { background: #ffffff08; }
  .mermaid { background: #fff; border-radius: 10px; padding: 16px; margin: 1.4em 0; text-align: center; border: 1px solid var(--border); }
  @media (max-width: 800px) {
    #layout { flex-direction: column; }
    #sidebar { width: 100%; height: auto; position: static; }
    #content { padding: 24px 18px 80px; }
  }
</style>
</head>
<body>
<div id="layout">
  <nav id="sidebar">
    <div id="sidebar-head">
      <span id="brand"></span>
      <a id="github-link" href="https://github.com/Kolimar/leina" target="_blank" rel="noopener" title="View on GitHub" aria-label="View on GitHub">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
      </a>
      <button id="lang-toggle" type="button"></button>
    </div>
    <div id="nav-list"></div>
  </nav>
  <main id="main"><article id="content"></article></main>
</div>
<script id="pages-data" type="application/json">/*__PAGES_JSON__*/</script>
<script id="section-labels-data" type="application/json">/*__SECTION_LABELS_JSON__*/</script>
<script id="ui-strings-data" type="application/json">/*__UI_STRINGS_JSON__*/</script>
<script type="module">
  import { marked } from "https://cdn.jsdelivr.net/npm/marked@12/lib/marked.esm.js";
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });

  const pages = JSON.parse(document.getElementById("pages-data").textContent);
  const sectionLabels = JSON.parse(document.getElementById("section-labels-data").textContent);
  const uiStrings = JSON.parse(document.getElementById("ui-strings-data").textContent);
  const byId = new Map(pages.map((p) => [p.id, p]));

  const sidebarHead = document.getElementById("sidebar-head");
  const brandEl = document.getElementById("brand");
  const toggleEl = document.getElementById("lang-toggle");
  const navListEl = document.getElementById("nav-list");
  const contentEl = document.getElementById("content");

  const LANG_KEY = "leina-docs-lang";
  const validLang = (l) => l === "en" || l === "es";

  function detectDefaultLang() {
    const stored = localStorage.getItem(LANG_KEY);
    if (validLang(stored)) return stored;
    return (navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
  }

  let currentLang = detectDefaultLang();

  function parseHash() {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!raw) return { lang: currentLang, id: pages[0].id };
    const slash = raw.indexOf("/");
    if (slash === -1) return { lang: currentLang, id: byId.has(raw) ? raw : pages[0].id };
    const lang = validLang(raw.slice(0, slash)) ? raw.slice(0, slash) : currentLang;
    const id = raw.slice(slash + 1);
    return { lang, id: byId.has(id) ? id : pages[0].id };
  }

  function buildNav(lang) {
    navListEl.innerHTML = "";
    let lastSection = null;
    for (const page of pages) {
      if (page.section !== lastSection) {
        const h = document.createElement("h2");
        h.textContent = sectionLabels[lang][page.section] ?? page.section;
        navListEl.appendChild(h);
        lastSection = page.section;
      }
      const a = document.createElement("a");
      a.className = "nav-link";
      a.href = "#" + page.id;
      a.dataset.id = page.id;
      a.textContent = page[lang].title;
      navListEl.appendChild(a);
    }
  }

  async function render() {
    const { lang, id } = parseHash();
    currentLang = lang;
    localStorage.setItem(LANG_KEY, lang);
    document.documentElement.lang = lang;

    const strings = uiStrings[lang];
    brandEl.textContent = strings.brand;
    toggleEl.textContent = strings.toggleLabel;
    toggleEl.onclick = () => {
      location.hash = (lang === "en" ? "es" : "en") + "/" + id;
    };

    buildNav(lang);
    [...navListEl.querySelectorAll(".nav-link")].forEach((a) =>
      a.classList.toggle("active", a.dataset.id === id),
    );

    const page = byId.get(id);
    const doc = page[lang];
    contentEl.innerHTML = marked.parse(doc.markdown);

    // Convert fenced mermaid blocks into <div class="mermaid"> with literal source.
    // textContent decodes the HTML entities marked produced, recovering <br/> etc.
    contentEl.querySelectorAll("code.language-mermaid").forEach((code) => {
      const div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = code.textContent;
      (code.closest("pre") ?? code).replaceWith(div);
    });
    try {
      await mermaid.run({ querySelector: "#content .mermaid" });
    } catch (e) {
      console.error("mermaid render error", e);
    }

    contentEl.scrollIntoView({ block: "start" });
    document.title = doc.title + " — leina";
  }

  window.addEventListener("hashchange", render);
  render();
</script>
</body>
</html>
`;

function main(): void {
  const pages = loadPages();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, renderHtml(pages), "utf8");
  process.stdout.write(`docs site: wrote ${OUT_FILE} (${pages.length} pages x 2 languages)\n`);
}

main();
