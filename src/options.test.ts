import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { splitClaudeOptions } from "./options.ts"

describe("splitClaudeOptions", () => {
  test("cccm のオプション・claude に渡すオプション・プロンプトに切り分ける", () => {
    assert.deepEqual(
      splitClaudeOptions([
        "--hub",
        "github:octocat/hub#1",
        "--model",
        "opus",
        "--env=env_1",
        "--no-wait",
        "--verbose",
        "fix the bug",
      ]),
      {
        cccm: { hub: "github:octocat/hub#1", env: "env_1", "no-wait": true },
        claude: ["--model", "opus", "--verbose"],
        settings: null,
        positionals: ["fix the bug"],
      },
    )
  })

  test("--settings は claude に渡さず別に取り出す", () => {
    const result = splitClaudeOptions(["--settings", "/tmp/s.json", "p"])
    assert.equal(result.settings, "/tmp/s.json")
    assert.deepEqual(result.claude, [])
  })

  test("値を取る claude のオプション（-n / --name など）は次の引数を値にする", () => {
    assert.deepEqual(splitClaudeOptions(["-n", "my session", "--ref", "main", "task"]).claude, [
      "-n",
      "my session",
      "--ref",
      "main",
    ])
  })

  test("知らないオプションは = の形なら値ごと渡す", () => {
    assert.deepEqual(splitClaudeOptions(["--foo=bar", "task"]), {
      cccm: {},
      claude: ["--foo=bar"],
      settings: null,
      positionals: ["task"],
    })
  })

  test("-- の後ろはすべてプロンプトとして扱う", () => {
    assert.deepEqual(splitClaudeOptions(["--hub", "h", "--", "--not-an-option"]).positionals, [
      "--not-an-option",
    ])
  })

  test("cccm のオプションに値がなければエラー", () => {
    assert.throws(() => splitClaudeOptions(["--hub"]), /--hub requires a value/)
  })
})
