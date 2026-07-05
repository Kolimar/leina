import { readFileSync } from "node:fs";
import { extractFile } from "../src/infrastructure/extractors/treesitter.ts";
import { detectLang } from "../src/application/graph/detect.ts";

const file = process.argv[2]!;
const lang = detectLang(file)!;
const src = readFileSync(file, "utf8");
const r = await extractFile(file.replace(/\\/g, "/"), src, lang);
console.log(`=== ${file} (${lang}) ===`);
console.log("NODES:");
for (const n of r.nodes) console.log(`  ${n.kind ?? "?"} ${n.label}  [${n.id}]`);
console.log("EDGES:");
for (const e of r.edges) console.log(`  ${e.source} --${e.relation}(${e.confidence})--> ${e.target}`);
console.log("RAW CALLS:");
for (const c of r.rawCalls) console.log(`  ${c.fromId} -> ${c.callee}${c.isMember ? " (member)" : ""}`);
