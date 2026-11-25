const CCCM_VALUE_OPTIONS = new Set([
  "via",
  "routine",
  "hub",
  "env",
  "session",
  "output-format",
  "ack-timeout",
  "reminder-grace",
  "pending-remind-interval",
  "timeout",
  "interval",
])
const CCCM_FLAGS = new Set(["no-wait", "help"])

const CLAUDE_VALUE_OPTIONS = new Set([
  "-n",
  "--name",
  "--model",
  "--effort",
  "--ref",
  "--on-branch",
  "--agent",
  "--fallback-model",
  "--add-dir",
  "--permission-mode",
  "--append-system-prompt",
  "--system-prompt",
  "--mcp-config",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--betas",
  "--setting-sources",
  "--plugin-dir",
])

export type SplitOptions = {
  cccm: Record<string, string | true>
  claude: string[]
  settings: string | null
  positionals: string[]
}

export function splitClaudeOptions(argv: string[]): SplitOptions {
  const result: SplitOptions = { cccm: {}, claude: [], settings: null, positionals: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--") {
      result.positionals.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith("-") || arg === "-") {
      result.positionals.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    const flag = eq >= 0 ? arg.slice(0, eq) : arg
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined
    const name = flag.replace(/^--/, "")
    const takeValue = () => {
      if (inline !== undefined) return inline
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${flag} requires a value`)
      i++
      return value
    }

    if (flag.startsWith("--") && CCCM_VALUE_OPTIONS.has(name)) {
      result.cccm[name] = takeValue()
    } else if (flag.startsWith("--") && CCCM_FLAGS.has(name)) {
      result.cccm[name] = true
    } else if (flag === "--settings") {
      result.settings = takeValue()
    } else if (CLAUDE_VALUE_OPTIONS.has(flag) && inline === undefined) {
      result.claude.push(flag, takeValue())
    } else {
      result.claude.push(arg)
    }
  }
  return result
}
