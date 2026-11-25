import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { runCommand } from "./command.ts"

const printStdin = [
  "-e",
  "const fs = require('fs'); process.stdout.write(JSON.stringify({ socket: fs.fstatSync(0).isSocket(), text: fs.readFileSync(0, 'utf8') }))",
]

describe("runCommand", () => {
  test("入力を渡さないときは標準入力をソケットにしない（macOS の script が tcgetattr で失敗するため）", async () => {
    const result = await runCommand(process.execPath, printStdin)
    assert.deepEqual(JSON.parse(result.stdout), { socket: false, text: "" })
  })

  test("入力を標準入力に渡す", async () => {
    const result = await runCommand(process.execPath, printStdin, { input: "hello" })
    assert.equal(JSON.parse(result.stdout).text, "hello")
  })

  test("終了コードと標準エラーを返す", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "console.error('bad'); process.exit(3)",
    ])
    assert.equal(result.exitCode, 3)
    assert.equal(result.stderr, "bad\n")
  })
})
