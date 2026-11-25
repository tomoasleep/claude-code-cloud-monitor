import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { COMMENT_LIMIT, newState, parseComment, renderComment, sessionUrl } from "./state.ts"

const AT = "2026-11-25T00:00:00.000Z"

describe("renderComment / parseComment", () => {
  test("描画したコメントから同じ状態を読み戻せる", () => {
    const state = {
      ...newState(AT),
      session_id: "session_01abc",
      status: "turn_ended" as const,
      turn: 2,
      acked_at: AT,
      report: { status: "pending" as const, summary: "waiting for CI", at: AT },
      tasks: [{ id: "1", subject: "Write tests", done: true }],
      last_message: "hello",
    }
    assert.deepEqual(parseComment(renderComment(state)), state)
  })

  test("状態は先頭の HTML コメントに base64 で入る", () => {
    const body = renderComment(newState(AT))
    assert.match(body, /^<!-- cccm-state:v1 [A-Za-z0-9+/=]+ -->\n/)
  })

  test("人が読む部分に状態・セッション・報告・TODO・直近の応答を出す", () => {
    const body = renderComment({
      ...newState(AT),
      session_id: "session_01abc",
      status: "done",
      report: { status: "done", summary: "All done", at: AT },
      tasks: [
        { id: "1", subject: "Write tests", done: true },
        { id: "2", subject: "Ship", done: false },
      ],
      last_message: "Final words",
    })
    assert.match(body, /\*\*状態\*\*: 完了/)
    assert.match(body, /\*\*セッション\*\*: https:\/\/claude\.ai\/code\/session_01abc/)
    assert.match(body, /### 報告\n\nAll done/)
    assert.match(body, /- \[x\] Write tests\n- \[ \] Ship/)
    assert.match(
      body,
      /## 直近の応答\n\n<details>\n<summary>全文を表示<\/summary>\n\nFinal words\n\n<\/details>/,
    )
  })

  test("本文に --> や偽の状態コメントがあっても先頭の状態を読む", () => {
    const state = {
      ...newState(AT),
      last_message: "--> <!-- cccm-state:v1 e30= -->",
    }
    assert.deepEqual(parseComment(renderComment(state)), state)
  })

  test("cccm の状態がないコメントは null を返す", () => {
    assert.equal(parseComment("just a comment"), null)
  })

  test("長い文は上限に収まるよう切り、読み戻せる", () => {
    const long = "あ".repeat(100_000)
    const state = {
      ...newState(AT),
      last_message: long,
      report: { status: "done" as const, summary: long, at: AT },
      progress: Array.from({ length: 200 }, (_, i) => ({
        at: AT,
        message: `step ${i} ${"x".repeat(500)}`,
      })),
    }
    const body = renderComment(state)
    assert.ok(body.length <= COMMENT_LIMIT, `length ${body.length}`)
    const parsed = parseComment(body)
    assert.ok(parsed)
    assert.ok(parsed.last_message.length < long.length)
    assert.ok(parsed.last_message.length > 1000)
  })
})

describe("sessionUrl", () => {
  test("セッション ID から claude.ai の URL を作る", () => {
    assert.equal(sessionUrl("session_01abc"), "https://claude.ai/code/session_01abc")
  })
})
