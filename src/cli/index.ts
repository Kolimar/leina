#!/usr/bin/env node
// leina CLI entry — Node-version gate, then the dispatcher.
//
// This file must stay minimal and import NOTHING beyond ./node-gate.ts (which itself has
// no top-level imports): the dispatcher's static import graph reaches `node:sqlite`, and
// under ESM the whole graph is linked before any module body runs — so on an unsupported
// Node the process would die with an opaque ERR_UNKNOWN_BUILTIN_MODULE before a version
// check inside the dispatcher could ever explain the problem. The gate runs first; the
// dispatcher is loaded with a dynamic import, whose resolution is deferred past the check.
//
// This file (not main.ts) is the `bin` target, so process.argv[1] keeps pointing here —
// the anchor deriveCliCommand and entryAssetsRootFrom rely on in both dev and built form.

import { runNodeGate } from "./node-gate.ts";

await runNodeGate();
await import("./main.ts");
