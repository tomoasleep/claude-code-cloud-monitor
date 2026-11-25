import type { CloudSessionClient } from "./claude.ts"
import type { CommentRef, HubClient } from "./hub/github.ts"
import { REMINDER_TEXT } from "./prompt.ts"
import { parseComment, type State, sessionUrl, type Task } from "./state.ts"

export type TaskSummary = { subject: string; done: boolean }

type FinalFields = {
  summary: string
  tasks: TaskSummary[]
  last_message: string
  session_url: string | null
}

export type WatchEvent =
  | { type: "ack"; at: string }
  | { type: "progress"; tasks: TaskSummary[]; message?: string }
  | { type: "turn_ended"; turn: number; last_message: string }
  | { type: "reminder"; count: number }
  | { type: "pending"; summary: string }
  | ({ type: "done" } & FinalFields)
  | ({ type: "failed"; reason: "reported" } & FinalFields)
  | { type: "failed"; reason: "ack_timeout" | "timeout"; summary: string }
  | { type: "warning"; message: string }

export type PollResult = { events: WatchEvent[]; exitCode: number | null }

export type WatchOptions = {
  ref: CommentRef
  startedAt: number
  ackTimeoutMs: number
  reminderGraceMs: number
  pendingRemindIntervalMs: number
  timeoutMs: number | null
  finalGraceMs: number
}

export type WatchDeps = {
  hub: HubClient
  cloud: CloudSessionClient
  now: () => number
}

export const EXIT = {
  done: 0,
  failed: 1,
  usage: 2,
  ackTimeout: 3,
  timeout: 4,
  launchFailed: 5,
} as const

export class Watcher {
  private state: State | null = null
  private etag: string | null = null
  private endedTurn: number | null = null
  private remindedTurns = new Set<number>()
  private reminderCount = 0
  private lastReminderAt = 0

  private readonly options: WatchOptions
  private readonly deps: WatchDeps

  constructor(options: WatchOptions, deps: WatchDeps) {
    this.options = options
    this.deps = deps
  }

  async poll(): Promise<PollResult> {
    const now = this.deps.now()
    const events: WatchEvent[] = []

    try {
      const read = await this.deps.hub.getComment(this.options.ref, this.etag)
      this.etag = read.etag
      const next = read.modified ? parseComment(read.body) : null
      if (next) {
        events.push(...this.diff(this.state, next))
        this.state = next
      }
    } catch (error) {
      events.push({ type: "warning", message: (error as Error).message })
    }

    const state = this.state
    const final = state && this.finalEvent(state, now)
    if (final) {
      events.push(final)
      return { events, exitCode: final.type === "done" ? EXIT.done : EXIT.failed }
    }

    const elapsed = now - this.options.startedAt
    if (!state?.acked_at && elapsed > this.options.ackTimeoutMs) {
      events.push({ type: "failed", reason: "ack_timeout", summary: "" })
      return { events, exitCode: EXIT.ackTimeout }
    }
    if (this.options.timeoutMs !== null && elapsed > this.options.timeoutMs) {
      events.push({ type: "failed", reason: "timeout", summary: "" })
      return { events, exitCode: EXIT.timeout }
    }

    if (state && this.shouldRemind(state, now)) {
      try {
        await this.deps.cloud.send(state.session_id!, REMINDER_TEXT)
        this.remindedTurns.add(state.turn)
        this.lastReminderAt = now
        this.reminderCount++
        events.push({ type: "reminder", count: this.reminderCount })
      } catch (error) {
        events.push({ type: "warning", message: (error as Error).message })
      }
    }

    return { events, exitCode: null }
  }

  private diff(prev: State | null, next: State): WatchEvent[] {
    const events: WatchEvent[] = []
    if (!prev?.acked_at && next.acked_at) {
      events.push({ type: "ack", at: next.acked_at })
    }

    const tasksChanged =
      JSON.stringify(summarize(prev?.tasks ?? [])) !== JSON.stringify(summarize(next.tasks))
    const newProgress = next.progress.slice(prev?.progress.length ?? 0)
    if (tasksChanged || newProgress.length > 0) {
      const message = newProgress.at(-1)?.message
      events.push({
        type: "progress",
        tasks: summarize(next.tasks),
        ...(message ? { message } : {}),
      })
    }

    if (next.report?.status === "pending" && next.report.at !== prev?.report?.at) {
      events.push({ type: "pending", summary: next.report.summary })
    }

    if (
      (next.status === "turn_ended" || next.status === "pending") &&
      this.endedTurn !== next.turn
    ) {
      this.endedTurn = next.turn
      events.push({ type: "turn_ended", turn: next.turn, last_message: next.last_message })
    }
    return events
  }

  private finalEvent(state: State, now: number): WatchEvent | null {
    const report = state.report
    if (!report || report.status === "pending") return null
    const turnEnded = state.status === report.status
    if (!turnEnded && now - Date.parse(report.at) < this.options.finalGraceMs) return null
    const fields: FinalFields = {
      summary: report.summary,
      tasks: summarize(state.tasks),
      last_message: state.last_message,
      session_url: state.session_id ? sessionUrl(state.session_id) : null,
    }
    return report.status === "done"
      ? { type: "done", ...fields }
      : { type: "failed", reason: "reported", ...fields }
  }

  private shouldRemind(state: State, now: number): boolean {
    if (!state.acked_at || !state.session_id) return false
    if (now - this.options.startedAt < this.options.reminderGraceMs) return false
    if (state.status === "turn_ended") {
      return (
        !this.remindedTurns.has(state.turn) && !state.reminders.some((r) => r.turn === state.turn)
      )
    }
    if (state.status === "pending" && state.report) {
      const lastRecorded = Math.max(0, ...state.reminders.map((r) => Date.parse(r.at)))
      const base = Math.max(Date.parse(state.report.at), lastRecorded, this.lastReminderAt)
      return now - base >= this.options.pendingRemindIntervalMs
    }
    return false
  }
}

function summarize(tasks: Task[]): TaskSummary[] {
  return tasks.map((t) => ({ subject: t.subject, done: t.done }))
}
