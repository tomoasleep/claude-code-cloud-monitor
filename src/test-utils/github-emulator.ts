import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmulator } from "emulate"
import { runCommand } from "../command.ts"

export const OWNER = "octocat"
export const HUB_REPO = "hub"
const TOKEN = "cccm-test-token"

export async function startGitHubEmulator() {
  const emulator = await createEmulator({
    service: "github",
    port: 0,
    seed: {
      tokens: { [TOKEN]: { login: OWNER, scopes: ["repo"] } },
      github: {
        users: [{ login: OWNER }],
        repos: [{ owner: OWNER, name: HUB_REPO, auto_init: true }],
      },
    },
  })
  const configDir = await mkdtemp(join(tmpdir(), "cccm-gh-"))
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: configDir,
    GH_CONFIG_DIR: configDir,
    GH_HOST: "github.localhost",
    GH_TOKEN: TOKEN,
    HTTP_PROXY: `http://127.0.0.1:${new URL(emulator.url).port}`,
  }

  const gh = async (args: string[], input?: string) => {
    const result = await runCommand("gh", args, { env, input })
    if (result.exitCode !== 0) throw new Error(`gh ${args.join(" ")}: ${result.stderr}`)
    return result.stdout
  }

  return {
    env,
    async createIssue(): Promise<number> {
      const out = await gh([
        "api",
        "-X",
        "POST",
        `repos/${OWNER}/${HUB_REPO}/issues`,
        "-f",
        "title=hub",
      ])
      return JSON.parse(out).number
    },
    async readComment(id: number): Promise<string> {
      return JSON.parse(await gh(["api", `repos/${OWNER}/${HUB_REPO}/issues/comments/${id}`])).body
    },
    async createComment(issue: number, body: string): Promise<number> {
      const out = await gh(
        [
          "api",
          "-X",
          "POST",
          `repos/${OWNER}/${HUB_REPO}/issues/${issue}/comments`,
          "--input",
          "-",
        ],
        JSON.stringify({ body }),
      )
      return JSON.parse(out).id
    },
    close: () => emulator.close(),
  }
}
