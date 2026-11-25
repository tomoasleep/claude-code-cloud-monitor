import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCloudSessionClient } from "./claude.ts"
import { type CommandRunner, runCommand } from "./command.ts"
import { parseDuration } from "./duration.ts"
import { createGitHubHub, type IssueRef, parseHubSpec } from "./hub/github.ts"
import { type LaunchVia, runLaunch } from "./launch.ts"
import { findSessionComment, type WaitTimings, waitForCompletion } from "./monitor.ts"
import { splitClaudeOptions } from "./options.ts"
import { createReporter, OUTPUT_FORMATS, type OutputFormat } from "./output.ts"
import { installPlugin } from "./plugin.ts"
import { runReport } from "./report.ts"
import { EXIT } from "./wait.ts"

export type CliDeps = {
  cwd: string
  env: Record<string, string | undefined>
  write: (chunk: string) => void
  writeErr: (chunk: string) => void
  readStdin: () => Promise<string>
  runner: CommandRunner
  now: () => number
  sleep: (ms: number) => Promise<void>
  platform: NodeJS.Platform
  tmpdir: string
  stateDir: string
  fetch: typeof globalThis.fetch
}

const USAGE = `Usage:
  cccm launch  --via cloud --hub github:owner/repo#number [cccm options] [claude options] [prompt]
  cccm launch  --via routine --routine <trig_id> --hub github:owner/repo#number [cccm options] [prompt]
  cccm monitor --hub github:owner/repo#number [--session <id>] [cccm options]
  cccm plugin install
  cccm report init|progress|pending|done|failed|hook ...

cccm options:
  --via <cloud|routine>            How to start the session (launch only, required)
  --routine <trig_id>              Routine to fire (--via routine). The token is read from CCCM_ROUTINE_TOKEN
  --hub <spec>                     Where to write the status (github:owner/repo#number)
  --env <env_id>                   Cloud environment ID (--via cloud)
  --output-format <fmt>            text (default) | json | stream-json
  --ack-timeout <dur>              Default 5m
  --reminder-grace <dur>           Default 3m (0 disables)
  --pending-remind-interval <dur>  Default 15m
  --timeout <dur>                  Default none
  --interval <dur>                 Default 10s
  --no-wait                        Exit after the session is created (launch only)

With --via cloud, other options are passed to claude --cloud. Use --option=value for options cccm does not know.
`

class UsageError extends Error {}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case "launch":
        return await launch(rest, deps)
      case "monitor":
        return await monitor(rest, deps)
      case "report":
        return await runReport(rest, { ...deps, hub: createGitHubHub(deps) })
      case "plugin":
        if (rest[0] !== "install") throw new UsageError("unknown plugin command")
        await installPlugin(deps)
        return 0
      case "--help":
      case "-h":
        deps.write(USAGE)
        return 0
      default:
        throw new UsageError(command ? `unknown command: ${command}` : "missing command")
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.writeErr(`cccm: ${error.message}\n\n${USAGE}`)
      return EXIT.usage
    }
    deps.writeErr(`cccm: ${(error as Error).message}\n`)
    return 1
  }
}

function parseCommon(argv: string[]) {
  let split: ReturnType<typeof splitClaudeOptions>
  try {
    split = splitClaudeOptions(argv)
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
  const value = (name: string) => {
    const v = split.cccm[name]
    return typeof v === "string" ? v : undefined
  }
  const duration = (name: string, fallback: number | null) => {
    const v = value(name)
    if (v === undefined) return fallback
    try {
      return parseDuration(v)
    } catch (error) {
      throw new UsageError(`--${name}: ${(error as Error).message}`)
    }
  }

  const hubSpec = value("hub")
  if (!hubSpec) throw new UsageError("--hub is required")
  let issue: IssueRef
  try {
    issue = parseHubSpec(hubSpec)
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
  const format = (value("output-format") ?? "text") as OutputFormat
  if (!OUTPUT_FORMATS.includes(format)) throw new UsageError(`unknown --output-format: ${format}`)

  const timings: WaitTimings = {
    ackTimeoutMs: duration("ack-timeout", 5 * 60_000)!,
    reminderGraceMs: duration("reminder-grace", 3 * 60_000)!,
    pendingRemindIntervalMs: duration("pending-remind-interval", 15 * 60_000)!,
    timeoutMs: duration("timeout", null),
    intervalMs: duration("interval", 10_000)!,
  }
  return { split, value, hubSpec, issue, format, timings }
}

function services(deps: CliDeps) {
  return { hub: createGitHubHub(deps), cloud: createCloudSessionClient(deps) }
}

async function launch(argv: string[], deps: CliDeps): Promise<number> {
  const { split, value, hubSpec, issue, format, timings } = parseCommon(argv)
  if (split.positionals.length > 1) {
    throw new UsageError(
      `expected one prompt but got ${split.positionals.length} arguments. Quote the prompt, or use --option=value for options cccm does not know`,
    )
  }
  const prompt = (split.positionals[0] ?? (await deps.readStdin())).trim()
  if (!prompt) throw new UsageError("missing prompt (pass it as an argument or on stdin)")

  const reporter = createReporter(format, deps.write)
  const code = await runLaunch(
    {
      hubSpec,
      issue,
      prompt,
      via: parseVia(split, value, deps.env),
      noWait: split.cccm["no-wait"] === true,
      timings,
    },
    reporter,
    { ...deps, ...services(deps) },
  )
  reporter.finish()
  return code
}

function parseVia(
  split: ReturnType<typeof splitClaudeOptions>,
  value: (name: string) => string | undefined,
  env: CliDeps["env"],
): LaunchVia {
  const via = value("via")
  if (via === "cloud") {
    if (value("routine")) throw new UsageError("--routine is only for --via routine")
    return {
      kind: "cloud",
      claudeArgs: split.claude,
      settings: split.settings,
      environmentId: value("env") ?? null,
    }
  }
  if (via === "routine") {
    const routineId = value("routine")
    if (!routineId) throw new UsageError("--via routine requires --routine <trig_id>")
    if (value("env") || split.settings || split.claude.length > 0) {
      throw new UsageError(
        "--via routine does not take --env or claude options; the routine definition decides them",
      )
    }
    const token = env.CCCM_ROUTINE_TOKEN
    if (!token)
      throw new UsageError("--via routine requires the routine token in CCCM_ROUTINE_TOKEN")
    return { kind: "routine", routineId, token }
  }
  throw new UsageError(via ? `unknown --via: ${via}` : "--via cloud|routine is required")
}

async function monitor(argv: string[], deps: CliDeps): Promise<number> {
  const { split, value, issue, format, timings } = parseCommon(argv)
  if (split.claude.length > 0 || split.positionals.length > 0) {
    throw new UsageError(`unknown arguments: ${[...split.claude, ...split.positionals].join(" ")}`)
  }
  const { hub, cloud } = services(deps)
  const found = await findSessionComment(hub, issue, value("session") ?? null)
  if (!found) throw new UsageError("no cccm comment found in the hub issue")
  const reporter = createReporter(format, deps.write)
  const code = await waitForCompletion(found.ref, found.startedAt, timings, reporter, {
    ...deps,
    hub,
    cloud,
  })
  reporter.finish()
  return code
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

export function main(): Promise<number> {
  return runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    write: (chunk) => process.stdout.write(chunk),
    writeErr: (chunk) => process.stderr.write(chunk),
    readStdin,
    runner: runCommand,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    platform: process.platform,
    tmpdir: tmpdir(),
    stateDir: join(tmpdir(), "cccm"),
    fetch: globalThis.fetch,
  })
}
