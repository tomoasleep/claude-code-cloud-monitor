import type { TaskSummary, WatchEvent } from "./wait.ts"

export type LaunchedEvent = {
  type: "launched"
  session_id: string
  session_url: string
  hub: string
  comment_url: string
}

export type OutputEvent = LaunchedEvent | WatchEvent
export type OutputFormat = "text" | "json" | "stream-json"

export const OUTPUT_FORMATS: OutputFormat[] = ["text", "json", "stream-json"]

export type Reporter = {
  event(event: OutputEvent): void
  finish(): void
}

export function createReporter(format: OutputFormat, write: (chunk: string) => void): Reporter {
  if (format === "stream-json") {
    return { event: (e) => write(`${JSON.stringify(e)}\n`), finish: () => {} }
  }
  if (format === "json") {
    let last: OutputEvent | null = null
    let written = false
    return {
      event(e) {
        if (e.type === "launched") last = e
        if (e.type === "done" || e.type === "failed") {
          write(`${JSON.stringify(e)}\n`)
          written = true
        }
      },
      finish() {
        if (!written && last) write(`${JSON.stringify(last)}\n`)
      },
    }
  }
  return { event: (e) => write(formatText(e)), finish: () => {} }
}

function formatTasks(tasks: TaskSummary[]): string {
  return tasks.map((t) => `  [${t.done ? "x" : " "}] ${t.subject}\n`).join("")
}

function formatText(e: OutputEvent): string {
  switch (e.type) {
    case "launched":
      return `Launched: ${e.session_url}\nHub: ${e.comment_url}\n`
    case "ack":
      return `Acknowledged at ${e.at}\n`
    case "progress":
      return `Progress:${e.message ? ` ${e.message}` : ""}\n${formatTasks(e.tasks)}`
    case "turn_ended":
      return `Turn ${e.turn} ended: ${e.last_message.split("\n")[0]}\n`
    case "reminder":
      return `Sent reminder #${e.count}\n`
    case "pending":
      return `Pending: ${e.summary}\n`
    case "warning":
      return `Warning: ${e.message}\n`
    case "done":
      return `Done: ${e.summary}\n${formatTasks(e.tasks)}${e.last_message ? `\n${e.last_message}\n` : ""}`
    case "failed":
      if (e.reason !== "reported") {
        return e.reason === "ack_timeout"
          ? "Failed: the session did not run cccm report init in time\n"
          : "Failed: timed out\n"
      }
      return `Failed: ${e.summary}\n${formatTasks(e.tasks)}${e.last_message ? `\n${e.last_message}\n` : ""}`
  }
}
