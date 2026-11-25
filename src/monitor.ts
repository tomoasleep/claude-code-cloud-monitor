import type { CloudSessionClient } from "./claude.ts"
import type { CommentRef, HubClient, IssueRef } from "./hub/github.ts"
import type { Reporter } from "./output.ts"
import { parseComment } from "./state.ts"
import { Watcher } from "./wait.ts"

export type WaitTimings = {
  ackTimeoutMs: number
  reminderGraceMs: number
  pendingRemindIntervalMs: number
  timeoutMs: number | null
  intervalMs: number
}

export type WaitDeps = {
  hub: HubClient
  cloud: CloudSessionClient
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const FINAL_GRACE_MS = 60_000

export async function waitForCompletion(
  ref: CommentRef,
  startedAt: number,
  timings: WaitTimings,
  reporter: Reporter,
  deps: WaitDeps,
): Promise<number> {
  const watcher = new Watcher(
    { ref, startedAt, ...timings, finalGraceMs: Math.max(FINAL_GRACE_MS, timings.intervalMs * 2) },
    deps,
  )
  for (;;) {
    const result = await watcher.poll()
    for (const event of result.events) reporter.event(event)
    if (result.exitCode !== null) return result.exitCode
    await deps.sleep(timings.intervalMs)
  }
}

export async function findSessionComment(
  hub: HubClient,
  issue: IssueRef,
  sessionId: string | null,
): Promise<{ ref: CommentRef; startedAt: number } | null> {
  const candidates = (await hub.listIssueComments(issue))
    .map((c) => ({ ref: c.ref, state: parseComment(c.body) }))
    .filter((c) => c.state && (sessionId === null || c.state.session_id === sessionId))
  const latest = candidates.at(-1)
  return latest?.state ? { ref: latest.ref, startedAt: Date.parse(latest.state.started_at) } : null
}
