import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import {
  addRoutine,
  parseRoutines,
  readRoutines,
  routinesPath,
  serializeRoutines,
} from "./routine-config.ts"

const profiles = {
  "my-hub": {
    fire_url: "https://api.anthropic.com/v1/claude_code/routines/trig_01x/fire",
    token_command: 'security find-generic-password -s "cccm my-hub" -w',
  },
}

describe("serializeRoutines / parseRoutines", () => {
  test("profile ごとの表として書き、読み戻せる", () => {
    const text = serializeRoutines(profiles)
    assert.equal(
      text,
      `[my-hub]
fire_url = "https://api.anthropic.com/v1/claude_code/routines/trig_01x/fire"
token_command = "security find-generic-password -s \\"cccm my-hub\\" -w"
`,
    )
    assert.deepEqual(parseRoutines(text), profiles)
  })

  test("空行とコメントを読み飛ばす", () => {
    assert.deepEqual(
      parseRoutines('# routines\n\n[a]\nfire_url = "u"\n\ntoken_command = "c" # comment\n'),
      { a: { fire_url: "u", token_command: "c" } },
    )
  })

  test("読めない行があればエラーにする", () => {
    assert.throws(() => parseRoutines("[a]\nfire_url = u\n"), /line 2/)
  })
})

describe("routinesPath", () => {
  test("XDG_CONFIG_HOME があればその下、なければ ~/.config の下", () => {
    assert.equal(routinesPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" }), "/x/cccm/routines.toml")
    assert.equal(routinesPath({ HOME: "/h" }), "/h/.config/cccm/routines.toml")
  })
})

describe("addRoutine / readRoutines", () => {
  test("ファイルがなければ作り、既存の profile は残して同じ名前は置き換える", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cccm-routines-"))
    const env = { XDG_CONFIG_HOME: dir }
    assert.deepEqual(await readRoutines(env), {})

    await addRoutine(env, "a", { fire_url: "u1", token_command: "c1" })
    await addRoutine(env, "b", { fire_url: "u2", token_command: "c2" })
    await addRoutine(env, "a", { fire_url: "u3", token_command: "c3" })

    assert.deepEqual(await readRoutines(env), {
      a: { fire_url: "u3", token_command: "c3" },
      b: { fire_url: "u2", token_command: "c2" },
    })
    assert.match(await readFile(join(dir, "cccm", "routines.toml"), "utf8"), /^\[a\]\n/)
  })

  test("profile の名前に使えない文字があればエラー", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cccm-routines-"))
    await assert.rejects(
      addRoutine({ XDG_CONFIG_HOME: dir }, "a b", { fire_url: "u", token_command: "c" }),
      /invalid routine name/,
    )
  })

  test("壊れたファイルは読めないとエラーにする", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cccm-routines-"))
    await assert.rejects(
      (async () => {
        await addRoutine({ XDG_CONFIG_HOME: dir }, "a", { fire_url: "u", token_command: "c" })
        await writeFile(join(dir, "cccm", "routines.toml"), "nonsense\n")
        await readRoutines({ XDG_CONFIG_HOME: dir })
      })(),
      /routines.toml/,
    )
  })
})
