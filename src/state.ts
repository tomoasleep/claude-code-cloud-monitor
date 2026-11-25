export type ReportStatus = "pending" | "done" | "failed"
export type SessionStatus = "launching" | "running" | "turn_ended" | ReportStatus

export type Report = { status: ReportStatus; summary: string; at: string }
export type Task = { id: string; subject: string; done: boolean }

export type State = {
  version: 1
  session_id: string | null
  status: SessionStatus
  turn: number
  acked_at: string | null
  report: Report | null
  reminders: { at: string; turn: number }[]
  progress: { at: string; message: string }[]
  tasks: Task[]
  last_message: string
  started_at: string
  updated_at: string
}

export const COMMENT_LIMIT = 65_536

const STATE_PATTERN = /<!-- cccm-state:v1 ([A-Za-z0-9+/=]*) -->/

const STATUS_LABELS: Record<SessionStatus, string> = {
  launching: "起動中（launching）",
  running: "実行中（running）",
  turn_ended: "ターン終了（turn_ended）",
  pending: "継続中（pending）",
  done: "完了（done）",
  failed: "失敗（failed）",
}

export function newState(now: string): State {
  return {
    version: 1,
    session_id: null,
    status: "launching",
    turn: 0,
    acked_at: null,
    report: null,
    reminders: [],
    progress: [],
    tasks: [],
    last_message: "",
    started_at: now,
    updated_at: now,
  }
}

export function sessionUrl(sessionId: string): string {
  return `https://claude.ai/code/${sessionId}`
}

export function parseComment(body: string): State | null {
  const match = STATE_PATTERN.exec(body)
  if (!match) return null
  try {
    return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as State
  } catch {
    return null
  }
}

export function renderComment(state: State): string {
  let current = state
  let body = renderUnchecked(current)
  while (body.length > COMMENT_LIMIT) {
    current = shrink(current)
    body = renderUnchecked(current)
  }
  return body
}

function renderUnchecked(state: State): string {
  const encoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64")
  const lines = [
    `<!-- cccm-state:v1 ${encoded} -->`,
    `**状態**: ${STATUS_LABELS[state.status]}`,
    `**セッション**: ${state.session_id ? sessionUrl(state.session_id) : "（未作成）"}`,
    `**開始**: ${state.started_at} / **更新**: ${state.updated_at}`,
  ]
  if (state.report) {
    lines.push("", "### 報告", "", state.report.summary || "（要約なし）")
  }
  if (state.tasks.length > 0) {
    lines.push(
      "",
      "### TODO",
      "",
      ...state.tasks.map((t) => `- [${t.done ? "x" : " "}] ${t.subject}`),
    )
  }
  if (state.progress.length > 0) {
    lines.push("", "### 途中経過", "", ...state.progress.map((p) => `- ${p.at} ${p.message}`))
  }
  lines.push("", "## 直近の応答", "")
  if (state.last_message) {
    lines.push(
      "<details>",
      "<summary>全文を表示</summary>",
      "",
      state.last_message,
      "",
      "</details>",
    )
  } else {
    lines.push("（まだない）")
  }
  return `${lines.join("\n")}\n`
}

const TRUNCATED = "\n…（省略）"

function shrink(state: State): State {
  const summary = state.report?.summary ?? ""
  const progressSize = state.progress.reduce((n, p) => n + p.message.length, 0)
  const largest = Math.max(state.last_message.length, summary.length, progressSize)
  if (largest === state.last_message.length) {
    return { ...state, last_message: halve(state.last_message) }
  }
  if (state.report && largest === summary.length) {
    return { ...state, report: { ...state.report, summary: halve(summary) } }
  }
  return { ...state, progress: state.progress.slice(Math.ceil(state.progress.length / 2)) }
}

function halve(text: string): string {
  const base = text.endsWith(TRUNCATED) ? text.slice(0, -TRUNCATED.length) : text
  return base.slice(0, Math.floor(base.length / 2)) + TRUNCATED
}
