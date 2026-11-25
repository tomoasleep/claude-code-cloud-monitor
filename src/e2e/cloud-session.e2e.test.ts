import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { runCommand } from "../command.ts"
import { addAllowedPermissions } from "../plugin.ts"
import { buildPrompt, REMINDER_TEXT } from "../prompt.ts"
import { newState, parseComment, renderComment, type State } from "../state.ts"
import { HUB_REPO, OWNER, startGitHubEmulator } from "../test-utils/github-emulator.ts"
import { startLlmMock } from "../test-utils/llm-mock.ts"

const WORK_DIR = join(homedir(), "work")
const REPO_ROOT = new URL("../..", import.meta.url).pathname

type Emulator = Awaited<ReturnType<typeof startGitHubEmulator>>
type LlmMock = Awaited<ReturnType<typeof startLlmMock>>

let github: Emulator
let llm: LlmMock
let commentId: number
const to = () => `github:${OWNER}/${HUB_REPO}/comments/${commentId}`

async function claude(args: string[], env: Record<string, string>) {
  const result = await runCommand(
    "claude",
    [...args, "--output-format", "json", "--model", "claude-sonnet-5-5"],
    {
      cwd: WORK_DIR,
      env,
    },
  )
  assert.equal(result.exitCode, 0, `claude ${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
  return JSON.parse(result.stdout) as { session_id: string; result: string }
}

async function hubState(): Promise<State> {
  const state = parseComment(await github.readComment(commentId))
  assert.ok(state)
  return state
}

describe("e2e", {
  skip: process.env.CCCM_E2E !== "1" && "set CCCM_E2E=1 (runs in docker/e2e)",
}, () => {
  before(async () => {
    github = await startGitHubEmulator()
    const issue = await github.createIssue()
    commentId = await github.createComment(issue, renderComment(newState(new Date().toISOString())))

    llm = await startLlmMock([
      { expectedUserMessage: "E2E-TASK", bash: `cccm report init --to ${to()}` },
      { content: "Should I continue?" },
      {
        expectedUserMessage: "[cccm] Is the task finished?",
        bash: 'cccm report pending --summary "waiting for CI"',
      },
      { content: "Continuing." },
      { expectedUserMessage: "Please finish", bash: 'cccm report done --summary "Fixed the bug"' },
      { content: "All done." },
    ])

    const settingsPath = join(homedir(), ".claude", "settings.json")
    await mkdir(join(homedir(), ".claude"), { recursive: true })
    await writeFile(settingsPath, JSON.stringify(addAllowedPermissions({})))
    for (const args of [
      ["plugin", "marketplace", "add", REPO_ROOT],
      ["plugin", "install", "cccm@claude-code-cloud-monitor"],
    ]) {
      const result = await runCommand("claude", args, { env: process.env })
      assert.equal(result.exitCode, 0, `claude ${args.join(" ")}: ${result.stderr}${result.stdout}`)
    }
    assert.ok(
      JSON.parse(await readFile(settingsPath, "utf8")).permissions.allow.includes(
        "Bash(cccm report:*)",
      ),
    )
  })

  after(async () => {
    await llm?.stop()
    await github?.close()
  })

  test("クラウドのセッションを模した claude で、報告と hook が hub のコメントを書き換える", async () => {
    const env: Record<string, string> = {
      ...github.env,
      HOME: homedir(),
      ANTHROPIC_BASE_URL: llm.url,
      ANTHROPIC_AUTH_TOKEN: "e2e-token",
      NO_PROXY: "127.0.0.1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_REMOTE: "true",
      CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01E2ESession000000000000",
    }

    const first = await claude(["-p", buildPrompt("E2E-TASK fix the bug", to())], env)
    let state = await hubState()
    assert.equal(state.acked_at !== null, true)
    assert.equal(state.session_id, "session_01E2ESession000000000000")
    assert.equal(state.status, "turn_ended")
    assert.equal(state.turn, 1)
    assert.equal(state.last_message, "Should I continue?")
    assert.equal(state.report, null)

    await claude(["-p", REMINDER_TEXT, "--resume", first.session_id], env)
    state = await hubState()
    assert.equal(state.status, "pending")
    assert.equal(state.turn, 2)
    assert.deepEqual(
      state.reminders.map((r) => r.turn),
      [1],
    )
    assert.equal(state.report?.summary, "waiting for CI")
    assert.equal(state.last_message, "Continuing.")

    await claude(["-p", "Please finish", "--resume", first.session_id], env)
    state = await hubState()
    assert.equal(state.status, "done")
    assert.equal(state.turn, 3)
    assert.equal(state.report?.summary, "Fixed the bug")
    assert.equal(state.last_message, "All done.")
    assert.match(await github.readComment(commentId), /\*\*状態\*\*: 完了/)

    assert.deepEqual(llm.errors, [])
    assert.equal(llm.consumed(), 6)
  })
})
