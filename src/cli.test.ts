import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { type CliDeps, runCli } from "./cli.ts"
import { type CommandRunner, runCommand } from "./command.ts"
import { REMINDER_TEXT } from "./prompt.ts"
import { newState, parseComment, renderComment } from "./state.ts"
import { HUB_REPO, OWNER, startGitHubEmulator } from "./test-utils/github-emulator.ts"

type Emulator = Awaited<ReturnType<typeof startGitHubEmulator>>

const SESSION = "session_01TestSessionId0000000000"
const CREATE_OUTPUT = await readFile(
  new URL("./test-utils/fixtures/cloud-create-output.txt", import.meta.url),
  "utf8",
)
const START = Date.parse("2026-11-25T00:00:00.000Z")
const FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01x/fire"

let emu: Emulator
before(async () => {
  emu = await startGitHubEmulator()
})
after(async () => {
  await emu.close()
})

type Recorded = { command: string; args: string[] }

async function makeDeps(overrides: Partial<CliDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const calls: Recorded[] = []
  let currentTime = START
  const stateDir = await mkdtemp(join(tmpdir(), "cccm-state-"))
  const runner: CommandRunner = async (command, args, options) => {
    if (command === "gh") return runCommand(command, args, options)
    calls.push({ command, args })
    if (command === "script") return { exitCode: 0, stdout: CREATE_OUTPUT, stderr: "" }
    if (command === "sh") return { exitCode: 0, stdout: "sk-ant-oat01-from-command\n", stderr: "" }
    if (command === "claude") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, session_id: SESSION, url: "u" }),
        stderr: "",
      }
    }
    throw new Error(`unexpected command ${command}`)
  }
  const fires: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fires.push({ url: String(url), init: init ?? {} })
    return new Response(
      JSON.stringify({
        type: "routine_fire",
        claude_code_session_id: SESSION,
        claude_code_session_url: `https://claude.ai/code/${SESSION}`,
      }),
    )
  }) as typeof globalThis.fetch
  const configHome = await mkdtemp(join(tmpdir(), "cccm-config-"))
  const deps: CliDeps = {
    cwd: "/work",
    env: { ...emu.env, XDG_CONFIG_HOME: configHome },
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    readStdin: async () => "",
    runner,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms
    },
    platform: "darwin",
    tmpdir: stateDir,
    stateDir,
    fetch,
    ...overrides,
  }
  return {
    deps,
    out,
    err,
    calls,
    fires,
    advance: (ms: number) => {
      currentTime += ms
    },
    now: () => currentTime,
  }
}

function cloudDeps(base: CliDeps, stdin = ""): CliDeps {
  return {
    ...base,
    env: {
      ...base.env,
      CLAUDE_CODE_REMOTE: "true",
      CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01TestSessionId0000000000",
    },
    write: () => {},
    writeErr: () => {},
    readStdin: async () => stdin,
  }
}

const hook = (base: CliDeps, input: object) =>
  runCli(["report", "hook"], cloudDeps(base, JSON.stringify(input)))

function commentIdFromPrompt(calls: Recorded[]): number {
  const script = calls.find((c) => c.command === "script")!
  const prompt = script.args[script.args.indexOf("--cloud") + 1]
  return Number(/cccm report init --to github:[^/]+\/[^/]+\/comments\/(\d+)/.exec(prompt)![1])
}

describe("cccm launch", () => {
  test("起動して ack・TODO・リマインダ・pending・done を受け取り、終了コード 0 で終わる", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps()
    const steps: (() => Promise<unknown>)[] = [
      async () => {
        const id = commentIdFromPrompt(t.calls)
        await runCli(
          ["report", "init", "--to", `github:${OWNER}/${HUB_REPO}/comments/${id}`],
          cloudDeps(t.deps),
        )
        await hook(t.deps, {
          hook_event_name: "TaskCreated",
          task_id: "1",
          task_subject: "Write tests",
        })
      },
      () => hook(t.deps, { hook_event_name: "Stop", last_assistant_message: "Should I continue?" }),
      async () => {
        await hook(t.deps, { hook_event_name: "UserPromptSubmit", prompt: REMINDER_TEXT })
        await runCli(["report", "pending", "--summary", "waiting for CI"], cloudDeps(t.deps))
        await hook(t.deps, { hook_event_name: "Stop", last_assistant_message: "waiting" })
      },
      async () => {
        await hook(t.deps, { hook_event_name: "TaskCompleted", task_id: "1" })
        await runCli(["report", "done", "--summary", "Fixed it"], cloudDeps(t.deps))
        await hook(t.deps, { hook_event_name: "Stop", last_assistant_message: "All done" })
      },
    ]
    t.deps.sleep = async (ms) => {
      t.advance(ms)
      await steps.shift()?.()
    }

    const code = await runCli(
      [
        "launch",
        "--via",
        "cloud",
        "--hub",
        `github:${OWNER}/${HUB_REPO}#${issue}`,
        "--output-format",
        "stream-json",
        "--reminder-grace",
        "0",
        "--model",
        "opus",
        "fix the bug",
      ],
      t.deps,
    )

    assert.equal(code, 0, t.err.join(""))
    const events = t.out
      .join("")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l))
    assert.deepEqual(
      events.map((e) => e.type),
      [
        "launched",
        "ack",
        "progress",
        "turn_ended",
        "reminder",
        "pending",
        "turn_ended",
        "progress",
        "done",
      ],
    )
    assert.equal(events[0].session_id, SESSION)
    assert.deepEqual(events.at(-1), {
      type: "done",
      summary: "Fixed it",
      tasks: [{ subject: "Write tests", done: true }],
      last_message: "All done",
      session_url: `https://claude.ai/code/${SESSION}`,
    })

    const script = t.calls.find((c) => c.command === "script")!
    assert.deepEqual(script.args.slice(0, 4), ["-q", "/dev/null", "claude", "--cloud"])
    assert.match(script.args[4], /^fix the bug\n/)
    assert.doesNotMatch(script.args[4], /add_repo/)
    assert.deepEqual(script.args.slice(5), ["--model", "opus"])
    assert.deepEqual(
      t.calls.filter((c) => c.command === "claude").map((c) => c.args),
      [["-p", REMINDER_TEXT, "--cloud", SESSION, "--output-format", "json"]],
    )

    const body = await emu.readComment(commentIdFromPrompt(t.calls))
    const state = parseComment(body)!
    assert.equal(state.status, "done")
    assert.equal(state.session_id, SESSION)
    assert.deepEqual(
      state.reminders.map((r) => r.turn),
      [1],
    )
    assert.match(body, /\*\*状態\*\*: 完了/)
  })

  test("--no-wait なら起動して ID と URL を出したら終わる", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps()
    const code = await runCli(
      [
        "launch",
        "--via",
        "cloud",
        "--hub",
        `github:${OWNER}/${HUB_REPO}#${issue}`,
        "--no-wait",
        "--output-format",
        "json",
        "task",
      ],
      t.deps,
    )
    assert.equal(code, 0, t.err.join(""))
    const launched = JSON.parse(t.out.join(""))
    assert.equal(launched.type, "launched")
    assert.equal(launched.session_url, `https://claude.ai/code/${SESSION}`)
    const state = parseComment(await emu.readComment(commentIdFromPrompt(t.calls)))!
    assert.equal(state.status, "launching")
    assert.equal(state.session_id, SESSION)
  })

  test("--env を --settings の中身に重ねた一時ファイルで渡す", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps()
    const settings = join(t.deps.tmpdir, "given.json")
    await writeFile(settings, JSON.stringify({ model: "opus" }))
    await runCli(
      [
        "launch",
        "--via",
        "cloud",
        "--hub",
        `github:${OWNER}/${HUB_REPO}#${issue}`,
        "--no-wait",
        "--env",
        "env_123",
        "--settings",
        settings,
        "task",
      ],
      t.deps,
    )
    const script = t.calls.find((c) => c.command === "script")!
    const path = script.args[script.args.indexOf("--settings") + 1]
    assert.notEqual(path, settings)
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      model: "opus",
      remote: { defaultEnvironmentId: "env_123" },
    })
  })

  test("プロンプトを標準入力から読む", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps({ readStdin: async () => "from stdin\n" })
    await runCli(
      ["launch", "--via", "cloud", "--hub", `github:${OWNER}/${HUB_REPO}#${issue}`, "--no-wait"],
      t.deps,
    )
    const script = t.calls.find((c) => c.command === "script")!
    assert.match(script.args[4], /^from stdin\n/)
  })

  test("セッション ID が取れなければ終了コード 5 で、hub のコメントに失敗を書く", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps()
    const base = t.deps.runner
    t.deps.runner = async (command, args, options) =>
      command === "script"
        ? { exitCode: 1, stdout: "Error: not logged in\n", stderr: "" }
        : base(command, args, options)
    const code = await runCli(
      ["launch", "--via", "cloud", "--hub", `github:${OWNER}/${HUB_REPO}#${issue}`, "task"],
      t.deps,
    )
    assert.equal(code, 5)
    assert.match(t.err.join(""), /not logged in/)
  })

  test("ack が来なければ終了コード 3", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps()
    const code = await runCli(
      [
        "launch",
        "--via",
        "cloud",
        "--hub",
        `github:${OWNER}/${HUB_REPO}#${issue}`,
        "--ack-timeout",
        "1m",
        "task",
      ],
      t.deps,
    )
    assert.equal(code, 3)
  })

  test("引数が誤っていれば終了コード 2", async () => {
    const t = await makeDeps()
    assert.equal(await runCli(["launch", "--via", "cloud", "task"], t.deps), 2)
    assert.equal(await runCli(["launch", "--hub", "github:o/r#1", "task"], t.deps), 2)
    assert.equal(
      await runCli(["launch", "--via", "other", "--hub", "github:o/r#1", "task"], t.deps),
      2,
    )
    assert.equal(await runCli(["launch", "--hub", "nope", "task"], t.deps), 2)
    assert.equal(
      await runCli(["launch", "--hub", "github:o/r#1", "--interval", "x", "task"], t.deps),
      2,
    )
    assert.equal(await runCli(["launch", "--hub", "github:o/r#1"], t.deps), 2)
    assert.equal(await runCli(["unknown"], t.deps), 2)
  })

  test("routine の指定が足りないか、routine では使えないオプションがあれば終了コード 2", async () => {
    const t = await makeDeps()
    await runCli(
      ["routine", "add", "qa", "--fire-url", FIRE_URL, "--token-command", "print-token"],
      t.deps,
    )
    const base = ["launch", "--via", "routine", "--hub", "github:o/r#1"]
    assert.equal(await runCli([...base, "task"], t.deps), 2)
    assert.equal(await runCli([...base, "--routine", "missing", "task"], t.deps), 2)
    assert.match(t.err.join(""), /no routine named missing/)
    assert.equal(await runCli([...base, "--routine", "qa", "--model", "opus", "task"], t.deps), 2)
    assert.equal(await runCli([...base, "--routine", "qa", "--env", "env_1", "task"], t.deps), 2)
    assert.equal(
      await runCli(
        ["launch", "--via", "cloud", "--hub", "github:o/r#1", "--routine", "qa", "task"],
        t.deps,
      ),
      2,
    )
    assert.deepEqual(t.fires, [])
  })

  test("--via routine なら profile の token_command で token を取り、fire_url に fire して待つ", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps()
    assert.equal(
      await runCli(
        ["routine", "add", "qa", "--fire-url", FIRE_URL, "--token-command", "print-token"],
        t.deps,
      ),
      0,
    )
    t.out.length = 0
    t.deps.sleep = async (ms) => {
      t.advance(ms)
      const text = JSON.parse(String(t.fires[0].init.body)).text as string
      const to = /cccm report init --to (\S+)/.exec(text)![1]
      await runCli(["report", "init", "--to", to], cloudDeps(t.deps))
      await runCli(["report", "done", "--summary", "ok"], cloudDeps(t.deps))
      await hook(t.deps, { hook_event_name: "Stop", last_assistant_message: "bye" })
    }
    const code = await runCli(
      [
        "launch",
        "--via",
        "routine",
        "--routine",
        "qa",
        "--hub",
        `github:${OWNER}/${HUB_REPO}#${issue}`,
        "--output-format",
        "json",
        "fix the bug",
      ],
      t.deps,
    )
    assert.equal(code, 0, t.err.join(""))
    assert.equal(JSON.parse(t.out.join("")).summary, "ok")
    assert.equal(t.fires.length, 1)
    assert.equal(t.fires[0].url, FIRE_URL)
    assert.equal(
      (t.fires[0].init.headers as Record<string, string>).authorization,
      "Bearer sk-ant-oat01-from-command",
    )
    assert.match(JSON.parse(String(t.fires[0].init.body)).text, /^fix the bug\n/)
    assert.deepEqual(
      t.calls.filter((c) => c.command === "sh").map((c) => c.args),
      [["-c", "print-token"]],
    )
    assert.deepEqual(
      t.calls.filter((c) => c.command === "script"),
      [],
    )
  })

  test("CCCM_ROUTINE_FIRE_URL と CCCM_ROUTINE_TOKEN があれば profile より優先する", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps()
    await runCli(
      ["routine", "add", "qa", "--fire-url", FIRE_URL, "--token-command", "print-token"],
      t.deps,
    )
    t.deps.env = {
      ...t.deps.env,
      CCCM_ROUTINE_FIRE_URL: "https://example.test/fire",
      CCCM_ROUTINE_TOKEN: "sk-ant-oat01-env",
    }
    const hub = `github:${OWNER}/${HUB_REPO}#${issue}`
    assert.equal(
      await runCli(
        ["launch", "--via", "routine", "--routine", "qa", "--hub", hub, "--no-wait", "task"],
        t.deps,
      ),
      0,
    )
    assert.equal(
      await runCli(["launch", "--via", "routine", "--hub", hub, "--no-wait", "task"], t.deps),
      0,
    )
    assert.deepEqual(
      t.fires.map((f) => [f.url, (f.init.headers as Record<string, string>).authorization]),
      [
        ["https://example.test/fire", "Bearer sk-ant-oat01-env"],
        ["https://example.test/fire", "Bearer sk-ant-oat01-env"],
      ],
    )
    assert.deepEqual(
      t.calls.filter((c) => c.command === "sh"),
      [],
    )
  })

  test("token_command が失敗したら終了コード 5 で、fire しない", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps()
    const base = t.deps.runner
    t.deps.runner = async (command, args, options) =>
      command === "sh"
        ? { exitCode: 44, stdout: "", stderr: "item not found" }
        : base(command, args, options)
    await runCli(
      ["routine", "add", "qa", "--fire-url", FIRE_URL, "--token-command", "print-token"],
      t.deps,
    )
    const code = await runCli(
      [
        "launch",
        "--via",
        "routine",
        "--routine",
        "qa",
        "--hub",
        `github:${OWNER}/${HUB_REPO}#${issue}`,
        "task",
      ],
      t.deps,
    )
    assert.equal(code, 5)
    assert.match(t.err.join(""), /item not found/)
    assert.deepEqual(t.fires, [])
  })

  test("routine の fire が失敗したら終了コード 5", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps({
      fetch: (async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "not_found_error", message: "no routine" },
          }),
          { status: 404 },
        )) as typeof globalThis.fetch,
    })
    t.deps.env = { ...t.deps.env, CCCM_ROUTINE_FIRE_URL: FIRE_URL, CCCM_ROUTINE_TOKEN: "t" }
    const code = await runCli(
      ["launch", "--via", "routine", "--hub", `github:${OWNER}/${HUB_REPO}#${issue}`, "task"],
      t.deps,
    )
    assert.equal(code, 5)
    assert.match(t.err.join(""), /404 not_found_error: no routine/)
  })
})

describe("cccm routine add", () => {
  test("profile を routines.toml に保存する", async () => {
    const t = await makeDeps()
    const code = await runCli(
      [
        "routine",
        "add",
        "qa",
        "--fire-url",
        FIRE_URL,
        "--token-command",
        "op read op://v/cccm/token",
      ],
      t.deps,
    )
    assert.equal(code, 0, t.err.join(""))
    assert.equal(
      await readFile(join(t.deps.env.XDG_CONFIG_HOME!, "cccm", "routines.toml"), "utf8"),
      `[qa]\nfire_url = "${FIRE_URL}"\ntoken_command = "op read op://v/cccm/token"\n`,
    )
  })

  test("名前・--fire-url・--token-command のどれかがなければ終了コード 2", async () => {
    const t = await makeDeps()
    assert.equal(
      await runCli(["routine", "add", "--fire-url", FIRE_URL, "--token-command", "c"], t.deps),
      2,
    )
    assert.equal(await runCli(["routine", "add", "qa", "--token-command", "c"], t.deps), 2)
    assert.equal(await runCli(["routine", "add", "qa", "--fire-url", FIRE_URL], t.deps), 2)
    assert.equal(await runCli(["routine", "remove", "qa"], t.deps), 2)
  })
})

describe("cccm monitor", () => {
  test("Issue の中で最も新しい cccm のコメントを待つ", async () => {
    const issue = await emu.createIssue()
    const at = new Date(START).toISOString()
    await emu.createComment(issue, renderComment({ ...newState(at), session_id: "session_01old" }))
    const id = await emu.createComment(
      issue,
      renderComment({ ...newState(at), session_id: "session_01new" }),
    )
    await emu.createComment(issue, "unrelated comment")
    const t = await makeDeps()
    t.deps.sleep = async (ms) => {
      t.advance(ms)
      const to = ["--to", `github:${OWNER}/${HUB_REPO}/comments/${id}`]
      await runCli(["report", "init", ...to], cloudDeps(t.deps))
      await runCli(["report", "done", ...to, "--summary", "ok"], cloudDeps(t.deps))
      await hook(t.deps, { hook_event_name: "Stop", last_assistant_message: "bye" })
    }
    const code = await runCli(
      ["monitor", "--hub", `github:${OWNER}/${HUB_REPO}#${issue}`, "--output-format", "json"],
      t.deps,
    )
    assert.equal(code, 0, t.err.join(""))
    assert.equal(JSON.parse(t.out.join("")).summary, "ok")
  })

  test("--session で監視するセッションを選ぶ", async () => {
    const issue = await emu.createIssue()
    const at = new Date(START).toISOString()
    await emu.createComment(
      issue,
      renderComment({
        ...newState(at),
        session_id: "session_01old",
        status: "failed",
        report: { status: "failed", summary: "old one", at },
      }),
    )
    await emu.createComment(issue, renderComment({ ...newState(at), session_id: "session_01new" }))
    const t = await makeDeps()
    const code = await runCli(
      ["monitor", "--hub", `github:${OWNER}/${HUB_REPO}#${issue}`, "--session", "session_01old"],
      t.deps,
    )
    assert.equal(code, 1)
    assert.match(t.out.join(""), /Failed: old one/)
  })

  test("cccm のコメントがなければ終了コード 2", async () => {
    const issue = await emu.createIssue()
    const t = await makeDeps()
    assert.equal(
      await runCli(["monitor", "--hub", `github:${OWNER}/${HUB_REPO}#${issue}`], t.deps),
      2,
    )
    assert.match(t.err.join(""), /no cccm comment/)
  })
})

describe("cccm report", () => {
  async function prepareComment() {
    const issue = await emu.createIssue()
    const id = await emu.createComment(
      issue,
      renderComment(newState(new Date(START).toISOString())),
    )
    return { id, to: `github:${OWNER}/${HUB_REPO}/comments/${id}` }
  }

  test("init で送り先を保存して ack を書き、以後は --to なしで書ける", async () => {
    const { id, to } = await prepareComment()
    const t = await makeDeps()
    const cloud = { ...cloudDeps(t.deps), write: t.deps.write, writeErr: t.deps.writeErr }

    assert.equal(await runCli(["report", "init", "--to", to], cloud), 0, t.err.join(""))
    let state = parseComment(await emu.readComment(id))!
    assert.equal(state.acked_at, new Date(START).toISOString())
    assert.equal(state.session_id, SESSION)
    assert.equal(state.status, "running")

    assert.equal(await runCli(["report", "progress", "half", "way"], cloud), 0)
    assert.equal(await runCli(["report", "done", "--summary", "finished"], cloud), 0)
    state = parseComment(await emu.readComment(id))!
    assert.deepEqual(
      state.progress.map((p) => p.message),
      ["half way"],
    )
    assert.equal(state.report?.summary, "finished")
  })

  test("--summary-file から要約を読む", async () => {
    const { id, to } = await prepareComment()
    const t = await makeDeps()
    const file = join(t.deps.tmpdir, "summary.md")
    await writeFile(file, "# Summary\nlong text")
    assert.equal(
      await runCli(["report", "failed", "--to", to, "--summary-file", file], cloudDeps(t.deps)),
      0,
    )
    assert.equal(parseComment(await emu.readComment(id))!.report?.summary, "# Summary\nlong text")
  })

  test("init の前の report は理由を出して exit 1", async () => {
    const t = await makeDeps()
    const cloud = { ...cloudDeps(t.deps), writeErr: t.deps.writeErr }
    assert.equal(await runCli(["report", "done"], cloud), 1)
    assert.match(t.err.join(""), /cccm report init/)
  })

  test("書けない送り先への init は理由を出して exit 1", async () => {
    const t = await makeDeps()
    const cloud = { ...cloudDeps(t.deps), writeErr: t.deps.writeErr }
    assert.equal(
      await runCli(["report", "init", "--to", "github:octocat/missing/comments/1"], cloud),
      1,
    )
    assert.match(t.err.join(""), /init failed/)
  })

  test("hook はクラウドの外では何もしない", async () => {
    const { id, to } = await prepareComment()
    const t = await makeDeps()
    await runCli(["report", "init", "--to", to], cloudDeps(t.deps))
    const before = await emu.readComment(id)
    const local = { ...cloudDeps(t.deps, JSON.stringify({ hook_event_name: "Stop" })) }
    local.env = { ...local.env, CLAUDE_CODE_REMOTE: undefined }
    assert.equal(await runCli(["report", "hook"], local), 0)
    assert.equal(await emu.readComment(id), before)
  })

  test("hook は init の前には何もしない", async () => {
    const { id } = await prepareComment()
    const t = await makeDeps()
    const before = await emu.readComment(id)
    assert.equal(await hook(t.deps, { hook_event_name: "UserPromptSubmit", prompt: "x" }), 0)
    assert.equal(await emu.readComment(id), before)
  })

  test("hook は失敗しても exit 0 で、標準出力に何も出さない", async () => {
    const t = await makeDeps()
    await writeFile(
      join(t.deps.stateDir, "cse_01TestSessionId0000000000.json"),
      JSON.stringify({ to: "github:octocat/missing/comments/1", state: newState("t") }),
    )
    const out: string[] = []
    const code = await runCli(["report", "hook"], {
      ...cloudDeps(t.deps, JSON.stringify({ hook_event_name: "Stop" })),
      write: (s) => out.push(s),
      writeErr: (s) => out.push(s),
    })
    assert.equal(code, 0)
    assert.deepEqual(out, [])
  })
})
