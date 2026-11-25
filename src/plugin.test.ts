import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { addAllowedPermissions, installPlugin, REQUIRED_PERMISSIONS } from "./plugin.ts"
import { makeFakeRunner } from "./test-utils/fake-runner.ts"

describe("addAllowedPermissions", () => {
  test("permissions.allow に足りない許可だけを足す", () => {
    assert.deepEqual(
      addAllowedPermissions({
        model: "opus",
        permissions: { allow: ["Bash(git *)"], deny: ["x"] },
      }),
      {
        model: "opus",
        permissions: { allow: ["Bash(git *)", "Bash(cccm report:*)"], deny: ["x"] },
      },
    )
    assert.deepEqual(addAllowedPermissions({ permissions: { allow: ["Bash(cccm report:*)"] } }), {
      permissions: { allow: ["Bash(cccm report:*)"] },
    })
  })

  test("permissions がなければ作る", () => {
    assert.deepEqual(addAllowedPermissions({}), { permissions: { allow: REQUIRED_PERMISSIONS } })
  })
})

describe("installPlugin", () => {
  test("marketplace を足して plugin を入れ、settings.json に許可を書く", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cccm-plugin-"))
    await writeFile(join(dir, "settings.json"), JSON.stringify({ model: "opus" }))
    const { runner, calls } = makeFakeRunner(() => ({}))

    await installPlugin({ runner, env: { CLAUDE_CONFIG_DIR: dir }, write: () => {} })

    assert.deepEqual(
      calls.map((c) => [c.command, ...c.args]),
      [
        ["claude", "plugin", "marketplace", "add", "tomoasleep/claude-code-cloud-monitor"],
        ["claude", "plugin", "install", "cccm@claude-code-cloud-monitor"],
      ],
    )
    assert.deepEqual(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")), {
      model: "opus",
      permissions: { allow: REQUIRED_PERMISSIONS },
    })
  })

  test("settings.json がなければ作る", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cccm-plugin-"))
    const { runner } = makeFakeRunner(() => ({}))
    await installPlugin({ runner, env: { CLAUDE_CONFIG_DIR: dir }, write: () => {} })
    assert.deepEqual(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")), {
      permissions: { allow: REQUIRED_PERMISSIONS },
    })
  })

  test("claude plugin が失敗したらエラーにする", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cccm-plugin-"))
    const { runner } = makeFakeRunner(() => ({ exitCode: 1, stderr: "boom" }))
    await assert.rejects(
      installPlugin({ runner, env: { CLAUDE_CONFIG_DIR: dir }, write: () => {} }),
      /boom/,
    )
  })
})
