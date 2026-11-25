import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { CommandRunner } from "./command.ts"

export const REQUIRED_PERMISSIONS = ["Bash(cccm report:*)", "mcp__claude-code-remote__add_repo"]

const MARKETPLACE = "tomoasleep/claude-code-cloud-monitor"
const PLUGIN = "cccm@claude-code-cloud-monitor"

type Settings = Record<string, unknown> & {
  permissions?: Record<string, unknown> & { allow?: string[] }
}

export function addAllowedPermissions(settings: Settings): Settings {
  const allow = settings.permissions?.allow ?? []
  const missing = REQUIRED_PERMISSIONS.filter((p) => !allow.includes(p))
  return { ...settings, permissions: { ...settings.permissions, allow: [...allow, ...missing] } }
}

export async function installPlugin(deps: {
  runner: CommandRunner
  env: Record<string, string | undefined>
  write: (chunk: string) => void
}): Promise<void> {
  for (const args of [
    ["plugin", "marketplace", "add", MARKETPLACE],
    ["plugin", "install", PLUGIN],
  ]) {
    const result = await deps.runner("claude", args, { env: deps.env })
    if (result.exitCode !== 0) {
      throw new Error(`claude ${args.join(" ")} failed: ${result.stderr}${result.stdout}`)
    }
    deps.write(result.stdout)
  }

  const configDir = deps.env.CLAUDE_CONFIG_DIR ?? join(deps.env.HOME ?? "", ".claude")
  const path = join(configDir, "settings.json")
  let settings: Settings = {}
  try {
    settings = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(addAllowedPermissions(settings), null, 2)}\n`)
  deps.write(`Allowed ${REQUIRED_PERMISSIONS.join(", ")} in ${path}\n`)
}
