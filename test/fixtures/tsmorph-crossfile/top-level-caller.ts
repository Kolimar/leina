// Top-level (module-scope) callsite — the call is NOT inside any function.
// Pre-fix: enclosingId walks parents looking for an entry in declToId; the
// SourceFile itself is not registered, so the call is silently dropped.
// Post-fix: the SourceFile node is registered, so the edge is attributed to
// the module node.

import { target } from "./callee";

target();
