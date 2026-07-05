// test/helpers/scip-stream-probe.ts — child-process probe used by
// test/scip-streaming.test.ts (Phase 1 task 1.4). Streams a `.scip` file with
// readScipDocuments(), discarding each Document immediately (never
// accumulating them in an array), forcing a GC pass periodically, and prints
// `<documentCount> <heapUsedBytes>` on the LAST stdout line once done.
//
// Run standalone (used by the parent test via spawnSync):
//   node --expose-gc --no-warnings --experimental-strip-types \
//     test/helpers/scip-stream-probe.ts <path-to-.scip>

import { readScipDocuments } from "../../src/infrastructure/extractors/semantic/scip-proto.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: scip-stream-probe.ts <path>");
  process.exit(2);
}

declare const gc: (() => void) | undefined;

let count = 0;
for (const doc of readScipDocuments(path)) {
  // Touch the payload so V8 cannot elide the decode work, without retaining it.
  count += doc.occurrences.length > 0 ? 1 : 1;
  if (count % 50 === 0 && typeof gc === "function") gc();
}
if (typeof gc === "function") gc();

console.log(`${count} ${process.memoryUsage().heapUsed}`);
