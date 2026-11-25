import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export type RoutineProfile = { fire_url: string; token_command: string }
export type RoutineProfiles = Record<string, RoutineProfile>

type Env = Record<string, string | undefined>

const NAME = /^[A-Za-z0-9_-]+$/
const KEYS = ["fire_url", "token_command"] as const

export function routinesPath(env: Env): string {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? "", ".config")
  return join(base, "cccm", "routines.toml")
}

export function serializeRoutines(profiles: RoutineProfiles): string {
  return Object.entries(profiles)
    .map(
      ([name, profile]) =>
        `[${name}]\n${KEYS.map((key) => `${key} = ${JSON.stringify(profile[key])}`).join("\n")}\n`,
    )
    .join("\n")
}

export function parseRoutines(text: string): RoutineProfiles {
  const profiles: Record<string, Partial<RoutineProfile>> = {}
  let current: Partial<RoutineProfile> | null = null
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/^\s+|\s+$/g, "")
    if (line === "" || line.startsWith("#")) return
    const table = /^\[([A-Za-z0-9_-]+)\]$/.exec(line)
    if (table) {
      current = profiles[table[1]] = {}
      return
    }
    const pair = /^(fire_url|token_command)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(line)
    if (!pair || !current) throw new Error(`cannot parse line ${index + 1}: ${raw}`)
    current[pair[1] as keyof RoutineProfile] = JSON.parse(pair[2])
  })
  for (const [name, profile] of Object.entries(profiles)) {
    for (const key of KEYS) {
      if (profile[key] === undefined) throw new Error(`routine ${name} has no ${key}`)
    }
  }
  return profiles as RoutineProfiles
}

export async function readRoutines(env: Env): Promise<RoutineProfiles> {
  const path = routinesPath(env)
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  try {
    return parseRoutines(text)
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`)
  }
}

export async function addRoutine(env: Env, name: string, profile: RoutineProfile): Promise<string> {
  if (!NAME.test(name)) {
    throw new Error(`invalid routine name: ${JSON.stringify(name)} (use letters, digits, - and _)`)
  }
  const profiles = await readRoutines(env)
  profiles[name] = profile
  const path = routinesPath(env)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serializeRoutines(profiles))
  return path
}
