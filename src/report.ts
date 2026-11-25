import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { type HubClient, parseCommentRef } from "./hub/github.ts"
import { isReminderPrompt } from "./prompt.ts"
import { newState, parseComment, type ReportStatus, renderComment, type State } from "./state.ts"

export type Env = Record<string, string | undefined>

export type HookInput = {
  hook_event_name?: string
  prompt?: string
  task_id?: string
  task_subject?: string
  last_assistant_message?: string
}

export function remoteSessionId(env: Env): string | null {
  const id = env.CLAUDE_CODE_REMOTE_SESSION_ID
  return id ? id.replace(/^cse_/, "session_") : null
}

export function applyInit(state: State, sessionId: string | null, now: string): State {
  return {
    ...state,
    session_id: sessionId ?? state.session_id,
    status: "running",
    turn: Math.max(state.turn, 1),
    acked_at: now,
    updated_at: now,
  }
}

export function applyReport(
  state: State,
  status: ReportStatus,
  summary: string,
  now: string,
): State {
  return { ...state, report: { status, summary, at: now }, updated_at: now }
}

export function applyProgress(state: State, message: string, now: string): State {
  return { ...state, progress: [...state.progress, { at: now, message }], updated_at: now }
}

export function applyHookEvent(state: State, input: HookInput, now: string): State {
  const next = { ...state, updated_at: now }
  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      return {
        ...next,
        reminders: isReminderPrompt(input.prompt ?? "")
          ? [...state.reminders, { at: now, turn: state.turn }]
          : state.reminders,
        turn: state.turn + 1,
        status: "running",
      }
    case "TaskCreated":
    case "TaskCompleted": {
      const id = String(input.task_id ?? "")
      const existing = state.tasks.find((t) => t.id === id)
      const task = {
        id,
        subject: input.task_subject ?? existing?.subject ?? "",
        done: input.hook_event_name === "TaskCompleted",
      }
      return {
        ...next,
        tasks: existing ? state.tasks.map((t) => (t.id === id ? task : t)) : [...state.tasks, task],
      }
    }
    case "Stop":
      return {
        ...next,
        status: state.report?.status ?? "turn_ended",
        last_message: input.last_assistant_message ?? state.last_message,
      }
    default:
      return next
  }
}

export type ReportDeps = {
  hub: HubClient
  env: Env
  now: () => number
  stateDir: string
  readStdin: () => Promise<string>
  write: (chunk: string) => void
  writeErr: (chunk: string) => void
}

type LocalCopy = { to: string; state: State }

const REPORT_USAGE = `Usage:
  cccm report init     --to github:owner/repo/comments/<id>
  cccm report progress "<message>"
  cccm report pending  [--summary "..."]
  cccm report done     [--summary "..." | --summary-file <path>]
  cccm report failed   [--summary "..." | --summary-file <path>]
  cccm report hook     (reads the hook JSON from stdin)
`

export async function runReport(argv: string[], deps: ReportDeps): Promise<number> {
  const [command, ...rest] = argv
  if (command === "hook") return runHook(deps)

  let values: { to?: string; summary?: string; "summary-file"?: string }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: rest,
      options: {
        to: { type: "string" },
        summary: { type: "string" },
        "summary-file": { type: "string" },
      },
      allowPositionals: true,
    }))
  } catch (error) {
    deps.writeErr(`${(error as Error).message}\n${REPORT_USAGE}`)
    return 2
  }

  const now = new Date(deps.now()).toISOString()
  try {
    switch (command) {
      case "init":
        if (!values.to) {
          deps.writeErr(`cccm report init requires --to\n${REPORT_USAGE}`)
          return 2
        }
        await update(deps, values.to, (s) => applyInit(s, remoteSessionId(deps.env), now))
        break
      case "progress": {
        if (positionals.length === 0) {
          deps.writeErr(`cccm report progress requires a message\n${REPORT_USAGE}`)
          return 2
        }
        const message = positionals.join(" ")
        await update(deps, values.to, (s) => applyProgress(s, message, now))
        break
      }
      case "pending":
      case "done":
      case "failed": {
        const summary = values["summary-file"]
          ? await readFile(values["summary-file"], "utf8")
          : (values.summary ?? "")
        await update(deps, values.to, (s) => applyReport(s, command, summary, now))
        break
      }
      default:
        deps.writeErr(REPORT_USAGE)
        return 2
    }
  } catch (error) {
    deps.writeErr(`cccm report ${command} failed: ${(error as Error).message}\n`)
    return 1
  }
  deps.write(`cccm: reported ${command}\n`)
  return 0
}

async function runHook(deps: ReportDeps): Promise<number> {
  if (deps.env.CLAUDE_CODE_REMOTE !== "true") return 0
  try {
    const local = await readLocal(deps)
    if (!local) return 0
    const input = JSON.parse(await deps.readStdin()) as HookInput
    const now = new Date(deps.now()).toISOString()
    await update(deps, local.to, (s) => applyHookEvent(s, input, now))
  } catch {
    return 0
  }
  return 0
}

function localPath(deps: ReportDeps): string {
  return join(deps.stateDir, `${deps.env.CLAUDE_CODE_REMOTE_SESSION_ID ?? "local"}.json`)
}

async function readLocal(deps: ReportDeps): Promise<LocalCopy | null> {
  try {
    return JSON.parse(await readFile(localPath(deps), "utf8")) as LocalCopy
  } catch {
    return null
  }
}

async function update(
  deps: ReportDeps,
  toOption: string | undefined,
  mutate: (state: State) => State,
) {
  const local = await readLocal(deps)
  const to = toOption ?? local?.to
  if (!to) {
    throw new Error(
      "no destination. Run cccm report init --to github:owner/repo/comments/<id> first",
    )
  }
  const ref = parseCommentRef(to)

  let remote: State | null = null
  try {
    const read = await deps.hub.getComment(ref)
    if (read.modified) remote = parseComment(read.body)
  } catch {}
  const base =
    remote ??
    (local?.to === to ? local.state : null) ??
    newState(new Date(deps.now()).toISOString())
  const next = mutate(base)

  await mkdir(deps.stateDir, { recursive: true })
  await writeFile(localPath(deps), JSON.stringify({ to, state: next }))
  await deps.hub.updateComment(ref, renderComment(next))
}
