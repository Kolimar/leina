// graph-store-worker.ts — child-process helper for the multi-process concurrency test.
// Opens the SAME graph.db as its siblings and hammers it with reads or writes.
// Any SQLITE_BUSY (or other sqlite error) escapes as an uncaught throw → exit code 1,
// which the parent test asserts against.
//
// argv: <dbPath> <read|write> [iterations]

import { GraphStore } from "../../src/infrastructure/sqlite/graph-store.ts";

const [dbPath, op, iterArg] = process.argv.slice(2);
if (!dbPath || (op !== "read" && op !== "write")) {
  process.stderr.write("usage: graph-store-worker.ts <dbPath> <read|write> [iterations]\n");
  process.exit(2);
}
const iterations = iterArg ? Number(iterArg) : 20;

const store = new GraphStore(dbPath);
try {
  for (let i = 0; i < iterations; i++) {
    if (op === "write") {
      store.addNodes([
        {
          id: `w:${process.pid}:${i}`,
          label: `worker_${process.pid}_${i}`,
          fileType: "code",
          sourceFile: "worker.ts",
          kind: "function",
        },
      ]);
    } else {
      store.stats();
      store.findByLabel("seed");
    }
  }
} finally {
  store.close();
}
process.stdout.write("ok\n");
