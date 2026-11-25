import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type CloudSessionClient, mergeEnvironmentIntoSettings } from "./claude.ts"
import type { CommandRunner } from "./command.ts"
import { formatCommentRef, type HubClient, type IssueRef } from "./hub/github.ts"
import { type WaitTimings, waitForCompletion } from "./monitor.ts"
import type { Reporter } from "./output.ts"
import { buildPrompt } from "./prompt.ts"
import { applyReport } from "./report.ts"
import { fireRoutine, runTokenCommand } from "./routine.ts"
import { newState, parseComment, renderComment, sessionUrl } from "./state.ts"
import { EXIT } from "./wait.ts"

export type LaunchVia =
  | { kind: "cloud"; claudeArgs: string[]; settings: string | null; environmentId: string | null }
  | { kind: "routine"; fireUrl: string; token: string | null; tokenCommand: string | null }

export type LaunchOptions = {
  hubSpec: string
  issue: IssueRef
  prompt: string
  via: LaunchVia
  noWait: boolean
  timings: WaitTimings
}

export type LaunchDeps = {
  hub: HubClient
  cloud: CloudSessionClient
  fetch: typeof globalThis.fetch
  runner: CommandRunner
  env: Record<string, string | undefined>
  tmpdir: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  writeErr: (chunk: string) => void
}

export async function runLaunch(
  options: LaunchOptions,
  reporter: Reporter,
  deps: LaunchDeps,
): Promise<number> {
  const startedAt = deps.now()
  const iso = () => new Date(deps.now()).toISOString()

  let comment: Awaited<ReturnType<HubClient["createComment"]>>
  try {
    comment = await deps.hub.createComment(options.issue, renderComment(newState(iso())))
  } catch (error) {
    deps.writeErr(`cccm: could not create the hub comment: ${(error as Error).message}\n`)
    return EXIT.launchFailed
  }

  const prompt = buildPrompt(options.prompt, formatCommentRef(comment.ref))

  let session: { sessionId: string; url: string }
  try {
    session = await createSession(options.via, prompt, deps, startedAt)
  } catch (error) {
    const message = (error as Error).message
    deps.writeErr(`cccm: could not launch the cloud session: ${message}\n`)
    const failed = applyReport(newState(iso()), "failed", `cccm launch failed: ${message}`, iso())
    await deps.hub
      .updateComment(comment.ref, renderComment({ ...failed, status: "failed" }))
      .catch(() => {})
    return EXIT.launchFailed
  }

  await recordSessionId(deps.hub, comment.ref, session.sessionId, iso())
  reporter.event({
    type: "launched",
    session_id: session.sessionId,
    session_url: sessionUrl(session.sessionId),
    hub: options.hubSpec,
    comment_url: comment.url,
  })
  if (options.noWait) return EXIT.done

  return waitForCompletion(comment.ref, startedAt, options.timings, reporter, deps)
}

async function createSession(
  via: LaunchVia,
  prompt: string,
  deps: LaunchDeps,
  startedAt: number,
): Promise<{ sessionId: string; url: string }> {
  if (via.kind === "routine") {
    const token = via.token ?? (await runTokenCommand(via.tokenCommand!, deps.runner, deps.env))
    return fireRoutine({ fireUrl: via.fireUrl, token, text: prompt }, deps.fetch)
  }
  const settingsPath = await prepareSettings(via, deps, startedAt)
  return deps.cloud.create({ prompt, claudeArgs: via.claudeArgs, settingsPath })
}

async function prepareSettings(
  options: Extract<LaunchVia, { kind: "cloud" }>,
  deps: LaunchDeps,
  startedAt: number,
): Promise<string | null> {
  if (!options.environmentId) return options.settings
  let base: Record<string, unknown> = {}
  if (options.settings) {
    const text = options.settings.trimStart().startsWith("{")
      ? options.settings
      : await readFile(options.settings, "utf8")
    base = JSON.parse(text)
  }
  const path = join(deps.tmpdir, `cccm-settings-${startedAt}-${process.pid}.json`)
  await writeFile(path, JSON.stringify(mergeEnvironmentIntoSettings(base, options.environmentId)))
  return path
}

async function recordSessionId(
  hub: HubClient,
  ref: Parameters<HubClient["getComment"]>[0],
  sessionId: string,
  now: string,
) {
  try {
    const read = await hub.getComment(ref)
    const state = read.modified ? parseComment(read.body) : null
    if (state && !state.acked_at) {
      await hub.updateComment(
        ref,
        renderComment({ ...state, session_id: sessionId, updated_at: now }),
      )
    }
  } catch {}
}
