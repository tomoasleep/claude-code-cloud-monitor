import type { CommandRunner } from "./command.ts"

export type CloudCreateOptions = {
  prompt: string
  claudeArgs: string[]
  settingsPath: string | null
  platform: NodeJS.Platform
}

export function buildCloudCreateCommand(options: CloudCreateOptions): {
  command: string
  args: string[]
} {
  const claude = [
    "claude",
    "--cloud",
    options.prompt,
    ...options.claudeArgs,
    ...(options.settingsPath ? ["--settings", options.settingsPath] : []),
  ]
  if (options.platform === "darwin") {
    return { command: "script", args: ["-q", "/dev/null", ...claude] }
  }
  return { command: "script", args: ["-qec", claude.map(shellQuote).join(" "), "/dev/null"] }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

export function parseCreateOutput(output: string): { sessionId: string; url: string } | null {
  const text = output.replace(ANSI_PATTERN, "")
  if (!text.includes("Created cloud session:")) return null
  const sessionId =
    /View:\s*https:\/\/\S*\/(session_[A-Za-z0-9]+)/.exec(text)?.[1] ??
    /claude --teleport\s+(session_[A-Za-z0-9]+)/.exec(text)?.[1]
  if (!sessionId) return null
  return { sessionId, url: `https://claude.ai/code/${sessionId}` }
}

export function buildReminderArgs(sessionId: string, text: string): string[] {
  return ["-p", text, "--cloud", sessionId, "--output-format", "json"]
}

export function parseSendOutput(output: string): boolean {
  try {
    return JSON.parse(output).ok === true
  } catch {
    return false
  }
}

export function mergeEnvironmentIntoSettings(
  settings: Record<string, unknown>,
  environmentId: string,
): Record<string, unknown> {
  const remote = (settings.remote ?? {}) as Record<string, unknown>
  return { ...settings, remote: { ...remote, defaultEnvironmentId: environmentId } }
}

export type CloudSessionClient = {
  create(options: Omit<CloudCreateOptions, "platform">): Promise<{ sessionId: string; url: string }>
  send(sessionId: string, text: string): Promise<void>
}

export function createCloudSessionClient(deps: {
  runner: CommandRunner
  cwd: string
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
}): CloudSessionClient {
  return {
    async create(options) {
      const { command, args } = buildCloudCreateCommand({ ...options, platform: deps.platform })
      const result = await deps.runner(command, args, { cwd: deps.cwd, env: deps.env })
      const parsed = parseCreateOutput(result.stdout)
      if (!parsed) {
        throw new Error(
          `could not find a session ID in the output of claude --cloud (exit ${result.exitCode}):\n${result.stdout}${result.stderr}`,
        )
      }
      return parsed
    },
    async send(sessionId, text) {
      const result = await deps.runner("claude", buildReminderArgs(sessionId, text), {
        cwd: deps.cwd,
        env: deps.env,
      })
      if (result.exitCode !== 0 || !parseSendOutput(result.stdout)) {
        throw new Error(
          `claude -p --cloud ${sessionId} failed (exit ${result.exitCode}): ${result.stdout}${result.stderr}`,
        )
      }
    },
  }
}
