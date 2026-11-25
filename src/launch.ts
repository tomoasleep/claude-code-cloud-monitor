import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type CloudSessionClient, mergeEnvironmentIntoSettings } from "./claude.ts"
import type { CommandRunner } from "./command.ts"
import {
  formatCommentRef,
  type HubClient,
  type IssueRef,
  parseRepoFromRemoteUrl,
} from "./hub/github.ts"
import { type WaitTimings, waitForCompletion } from "./monitor.ts"
import type { Reporter } from "./output.ts"
import { buildPrompt } from "./prompt.ts"
import { applyReport } from "./report.ts"
import { newState, parseComment, renderComment, sessionUrl } from "./state.ts"
import { EXIT } from "./wait.ts"

export type LaunchOptions = {
  hubSpec: string
  issue: IssueRef
  prompt: string
  claudeArgs: string[]
  settings: string | null
  environmentId: string | null
  noWait: boolean
  timings: WaitTimings
}

export type LaunchDeps = {
  hub: HubClient
  cloud: CloudSessionClient
  runner: CommandRunner
  cwd: string
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

  const hubRepo = `${options.issue.owner}/${options.issue.repo}`
  const workRepo = await detectWorkRepo(deps)
  const prompt = buildPrompt(options.prompt, {
    to: formatCommentRef(comment.ref),
    addRepo: workRepo === hubRepo ? null : hubRepo,
  })

  let session: { sessionId: string; url: string }
  try {
    const settingsPath = await prepareSettings(options, deps, startedAt)
    session = await deps.cloud.create({ prompt, claudeArgs: options.claudeArgs, settingsPath })
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

async function detectWorkRepo(deps: LaunchDeps): Promise<string | null> {
  try {
    const result = await deps.runner("git", ["remote", "get-url", "origin"], {
      cwd: deps.cwd,
      env: deps.env,
    })
    return result.exitCode === 0 ? parseRepoFromRemoteUrl(result.stdout) : null
  } catch {
    return null
  }
}

async function prepareSettings(
  options: LaunchOptions,
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
