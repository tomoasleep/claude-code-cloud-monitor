import type { CommandOptions, CommandResult, CommandRunner } from "../command.ts"

export type RecordedCall = { command: string; args: string[]; options: CommandOptions }

export function makeFakeRunner(
  respond: (command: string, args: string[], options: CommandOptions) => Partial<CommandResult>,
): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const runner: CommandRunner = async (command, args, options = {}) => {
    calls.push({ command, args, options })
    return { exitCode: 0, stdout: "", stderr: "", ...respond(command, args, options) }
  }
  return { runner, calls }
}

export function httpResponse(
  status: string,
  headers: Record<string, string>,
  body: string,
): string {
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`)
  return `HTTP/2.0 ${status}\r\n${head.join("")}\r\n${body}`
}
