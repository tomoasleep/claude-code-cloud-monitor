import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import {
  buildCloudCreateCommand,
  buildReminderArgs,
  mergeEnvironmentIntoSettings,
  parseCreateOutput,
  parseSendOutput,
} from "./claude.ts"

const fixture = (name: string) =>
  readFileSync(new URL(`./test-utils/fixtures/${name}`, import.meta.url), "utf8")

describe("buildCloudCreateCommand", () => {
  test("macOS では script -q /dev/null claude --cloud … で TTY を与える", () => {
    assert.deepEqual(
      buildCloudCreateCommand({
        prompt: "do it",
        claudeArgs: ["--model", "opus"],
        settingsPath: "/tmp/s.json",
        platform: "darwin",
      }),
      {
        command: "script",
        args: [
          "-q",
          "/dev/null",
          "claude",
          "--cloud",
          "do it",
          "--model",
          "opus",
          "--settings",
          "/tmp/s.json",
        ],
      },
    )
  })

  test("Linux では script -qec に引用した 1 行のコマンドを渡す", () => {
    assert.deepEqual(
      buildCloudCreateCommand({
        prompt: "it's done",
        claudeArgs: [],
        settingsPath: null,
        platform: "linux",
      }),
      {
        command: "script",
        args: ["-qec", "'claude' '--cloud' 'it'\\''s done'", "/dev/null"],
      },
    )
  })
})

describe("parseCreateOutput", () => {
  test("ANSI を含む作成の出力からセッション ID と URL を取る", () => {
    assert.deepEqual(parseCreateOutput(fixture("cloud-create-output.txt")), {
      sessionId: "session_01TestSessionId0000000000",
      url: "https://claude.ai/code/session_01TestSessionId0000000000",
    })
  })

  test("ID がない出力は null を返す", () => {
    assert.equal(parseCreateOutput("Error: something failed\n"), null)
  })
})

describe("buildReminderArgs", () => {
  test("claude -p <text> --cloud <id> --output-format json の引数を作る", () => {
    assert.deepEqual(buildReminderArgs("session_01abc", "hi"), [
      "-p",
      "hi",
      "--cloud",
      "session_01abc",
      "--output-format",
      "json",
    ])
  })
})

describe("parseSendOutput", () => {
  test("ok が true なら成功", () => {
    assert.equal(parseSendOutput('{"ok":true,"session_id":"session_01abc","url":"u"}'), true)
    assert.equal(parseSendOutput('{"ok":false}'), false)
    assert.equal(parseSendOutput("not json"), false)
  })
})

describe("mergeEnvironmentIntoSettings", () => {
  test("既存の設定に remote.defaultEnvironmentId を重ねる", () => {
    assert.deepEqual(
      mergeEnvironmentIntoSettings({ model: "opus", remote: { other: 1 } }, "env_123"),
      { model: "opus", remote: { other: 1, defaultEnvironmentId: "env_123" } },
    )
  })
})
