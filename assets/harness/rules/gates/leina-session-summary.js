import { execFileSync } from 'node:child_process';

/**
 * Deliver gate: a leina session summary must have been saved AFTER the active
 * contract was created. Session/observation ids embed their creation epoch in
 * milliseconds (…:1784319414078:…), so recency is machine-checkable.
 */
export default async function leinaSessionSummary(ctx) {
  const contract = ctx.contract;
  if (!contract || !contract.createdAt) {
    return { pass: true, message: 'no active contract — session-summary gate not applicable' };
  }

  let out;
  try {
    out = execFileSync('leina', ['memory', 'context', ctx.repoRoot, '--limit', '20'], {
      encoding: 'utf8',
      timeout: 20_000,
    });
  } catch (err) {
    return { pass: false, message: `cannot query leina memory: ${err.message}` };
  }

  const sessionsBlock = out.split('RECENT OBSERVATIONS')[0] ?? '';
  const epochs = [...sessionsBlock.matchAll(/:(\d{13}):/g)].map((m) => Number(m[1]));
  const newest = epochs.length > 0 ? Math.max(...epochs) : 0;
  const taskStart = Date.parse(contract.createdAt);

  if (newest >= taskStart) {
    return { pass: true, message: `leina session summary found (saved after task start)` };
  }
  return {
    pass: false,
    message: `no leina session summary saved since the task started (${contract.createdAt})`,
  };
}
