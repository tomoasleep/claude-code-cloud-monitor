import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { REMINDER_TEXT } from "./prompt.ts"
import { applyHookEvent, applyInit, applyProgress, applyReport, remoteSessionId } from "./report.ts"
import { newState } from "./state.ts"

const T0 = "2026-11-25T00:00:00.000Z"
const T1 = "2026-11-25T00:01:00.000Z"

describe("remoteSessionId", () => {
  test("CLAUDE_CODE_REMOTE_SESSION_ID の cse_ を session_ に替える", () => {
    assert.equal(remoteSessionId({ CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01abc" }), "session_01abc")
    assert.equal(remoteSessionId({}), null)
  })
})

describe("applyInit", () => {
  test("ack を書き、実行中にして、セッション ID と 1 ターン目を入れる", () => {
    assert.deepEqual(applyInit(newState(T0), "session_01abc", T1), {
      ...newState(T0),
      session_id: "session_01abc",
      status: "running",
      turn: 1,
      acked_at: T1,
      updated_at: T1,
    })
  })

  test("セッション ID が取れなければ既存の値を残す", () => {
    const state = { ...newState(T0), session_id: "session_01x" }
    assert.equal(applyInit(state, null, T1).session_id, "session_01x")
  })
})

describe("applyReport / applyProgress", () => {
  test("報告を入れても状態はターンの終わりまで変えない", () => {
    const state = applyReport({ ...newState(T0), status: "running" }, "done", "ok", T1)
    assert.deepEqual(state.report, { status: "done", summary: "ok", at: T1 })
    assert.equal(state.status, "running")
  })

  test("途中経過を足す", () => {
    assert.deepEqual(applyProgress(newState(T0), "half", T1).progress, [
      { at: T1, message: "half" },
    ])
  })
})

describe("applyHookEvent", () => {
  const running = { ...newState(T0), status: "running" as const, turn: 1, acked_at: T0 }

  test("UserPromptSubmit でターンを 1 増やし実行中にする", () => {
    const state = applyHookEvent(
      { ...running, status: "turn_ended" },
      { hook_event_name: "UserPromptSubmit", prompt: "more" },
      T1,
    )
    assert.equal(state.turn, 2)
    assert.equal(state.status, "running")
    assert.deepEqual(state.reminders, [])
  })

  test("リマインダの入力なら、終わったターンに対するリマインダとして記録する", () => {
    const state = applyHookEvent(
      running,
      { hook_event_name: "UserPromptSubmit", prompt: REMINDER_TEXT },
      T1,
    )
    assert.deepEqual(state.reminders, [{ at: T1, turn: 1 }])
  })

  test("TaskCreated と TaskCompleted で TODO を足して完了にする", () => {
    let state = applyHookEvent(
      running,
      { hook_event_name: "TaskCreated", task_id: "1", task_subject: "Write tests" },
      T1,
    )
    state = applyHookEvent(
      state,
      { hook_event_name: "TaskCreated", task_id: "2", task_subject: "Ship" },
      T1,
    )
    state = applyHookEvent(state, { hook_event_name: "TaskCompleted", task_id: "1" }, T1)
    assert.deepEqual(state.tasks, [
      { id: "1", subject: "Write tests", done: true },
      { id: "2", subject: "Ship", done: false },
    ])
  })

  test("Stop で最後の応答を入れ、報告がなければ turn_ended にする", () => {
    const state = applyHookEvent(
      running,
      { hook_event_name: "Stop", last_assistant_message: "bye" },
      T1,
    )
    assert.equal(state.status, "turn_ended")
    assert.equal(state.last_message, "bye")
  })

  test("Stop の前に報告があれば、状態を報告の状態にする", () => {
    const reported = applyReport(running, "pending", "CI", T0)
    assert.equal(applyHookEvent(reported, { hook_event_name: "Stop" }, T1).status, "pending")
  })

  test("知らない event では更新時刻だけを変える", () => {
    assert.deepEqual(applyHookEvent(running, { hook_event_name: "Other" }, T1), {
      ...running,
      updated_at: T1,
    })
  })
})
