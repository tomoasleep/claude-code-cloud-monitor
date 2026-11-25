import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { CloudSessionClient } from "./claude.ts"
import { REMINDER_TEXT } from "./prompt.ts"
import { newState, type State } from "./state.ts"
import { makeFakeHub } from "./test-utils/fake-hub.ts"
import { Watcher, type WatchOptions } from "./wait.ts"

const START = Date.parse("2026-11-25T00:00:00.000Z")
const SEC = 1_000
const MIN = 60 * SEC
const iso = (ms: number) => new Date(ms).toISOString()

function setup(overrides: Partial<WatchOptions> = {}) {
  let currentTime = START
  const base: State = { ...newState(iso(START)), session_id: "session_01abc" }
  const fake = makeFakeHub(base)
  const sent: { sessionId: string; text: string }[] = []
  let sendError: Error | null = null
  const cloud: CloudSessionClient = {
    async create() {
      throw new Error("not used")
    },
    async send(sessionId, text) {
      if (sendError) throw sendError
      sent.push({ sessionId, text })
    },
  }
  const watcher = new Watcher(
    {
      ref: { owner: "octocat", repo: "hub", commentId: 1 },
      startedAt: START,
      ackTimeoutMs: 5 * MIN,
      reminderGraceMs: 3 * MIN,
      pendingRemindIntervalMs: 15 * MIN,
      timeoutMs: null,
      finalGraceMs: 30 * SEC,
      ...overrides,
    },
    { hub: fake.hub, cloud, now: () => currentTime },
  )
  let state = base
  return {
    watcher,
    sent,
    advance(ms: number) {
      currentTime += ms
    },
    update(patch: Partial<State>) {
      state = { ...state, ...patch, updated_at: iso(currentTime) }
      fake.set(state)
    },
    failRead(error: Error) {
      fake.failOnce(error)
    },
    failSend(error: Error | null) {
      sendError = error
    },
    now: () => currentTime,
  }
}

const acked = () => ({ acked_at: iso(START + 10 * SEC), status: "running" as const, turn: 1 })

describe("Watcher", () => {
  test("ack が書かれたら ack を出す", async () => {
    const t = setup()
    assert.deepEqual(await t.watcher.poll(), { events: [], exitCode: null })
    t.update(acked())
    assert.deepEqual(await t.watcher.poll(), {
      events: [{ type: "ack", at: iso(START + 10 * SEC) }],
      exitCode: null,
    })
  })

  test("ack-timeout を過ぎても ack がなければ終了コード 3 で失敗する", async () => {
    const t = setup()
    t.advance(5 * MIN)
    assert.equal((await t.watcher.poll()).exitCode, null)
    t.advance(1)
    const result = await t.watcher.poll()
    assert.equal(result.exitCode, 3)
    assert.equal(result.events.at(-1)?.type, "failed")
  })

  test("done の報告の後にターンが終わったら、最後の応答を添えて終了コード 0 で終わる", async () => {
    const t = setup()
    t.update(acked())
    await t.watcher.poll()
    t.update({ report: { status: "done", summary: "did it", at: iso(t.now()) } })
    assert.deepEqual(await t.watcher.poll(), { events: [], exitCode: null })
    t.update({ status: "done", last_message: "bye" })
    assert.deepEqual(await t.watcher.poll(), {
      events: [
        {
          type: "done",
          summary: "did it",
          tasks: [],
          last_message: "bye",
          session_url: "https://claude.ai/code/session_01abc",
        },
      ],
      exitCode: 0,
    })
  })

  test("done の報告の後にターンの終わりが来なくても、finalGrace を過ぎたら終わる", async () => {
    const t = setup()
    t.update(acked())
    await t.watcher.poll()
    t.update({ report: { status: "done", summary: "did it", at: iso(t.now()) } })
    await t.watcher.poll()
    t.advance(30 * SEC)
    const result = await t.watcher.poll()
    assert.equal(result.exitCode, 0)
    assert.equal(result.events[0].type, "done")
  })

  test("failed が報告されたら終了コード 1 で終わる", async () => {
    const t = setup()
    t.update(acked())
    await t.watcher.poll()
    t.update({
      status: "failed",
      report: { status: "failed", summary: "no access", at: iso(t.now()) },
    })
    const result = await t.watcher.poll()
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.events, [
      {
        type: "failed",
        reason: "reported",
        summary: "no access",
        tasks: [],
        last_message: "",
        session_url: "https://claude.ai/code/session_01abc",
      },
    ])
  })

  test("報告なしでターンが終わったら、猶予の後にリマインダを送る", async () => {
    const t = setup()
    t.update(acked())
    await t.watcher.poll()
    t.advance(1 * MIN)
    t.update({ status: "turn_ended", last_message: "question?" })
    assert.deepEqual((await t.watcher.poll()).events, [
      { type: "turn_ended", turn: 1, last_message: "question?" },
    ])
    assert.equal(t.sent.length, 0)

    t.advance(2 * MIN)
    assert.deepEqual((await t.watcher.poll()).events, [{ type: "reminder", count: 1 }])
    assert.deepEqual(t.sent, [{ sessionId: "session_01abc", text: REMINDER_TEXT }])
  })

  test("reminder-grace が 0 ならターンの終わりですぐ送る", async () => {
    const t = setup({ reminderGraceMs: 0 })
    t.update({ ...acked(), status: "turn_ended" })
    const result = await t.watcher.poll()
    assert.deepEqual(result.events.at(-1), { type: "reminder", count: 1 })
  })

  test("同じターンにはリマインダを 1 回しか送らず、次のターンも報告なしで終われば再送する", async () => {
    const t = setup({ reminderGraceMs: 0 })
    t.update({ ...acked(), status: "turn_ended" })
    await t.watcher.poll()
    t.advance(1 * MIN)
    await t.watcher.poll()
    assert.equal(t.sent.length, 1)

    t.update({ status: "running", turn: 2, reminders: [{ at: iso(t.now()), turn: 1 }] })
    await t.watcher.poll()
    t.update({ status: "turn_ended" })
    const result = await t.watcher.poll()
    assert.deepEqual(result.events, [
      { type: "turn_ended", turn: 2, last_message: "" },
      { type: "reminder", count: 2 },
    ])
  })

  test("状態にリマインダが記録済みのターンには送らない（monitor を後から始めたとき）", async () => {
    const t = setup({ reminderGraceMs: 0 })
    t.update({ ...acked(), status: "turn_ended", reminders: [{ at: iso(START), turn: 1 }] })
    await t.watcher.poll()
    assert.equal(t.sent.length, 0)
  })

  test("pending が報告されたら、指定期間内は再送せず、期間を過ぎたら再送する", async () => {
    const t = setup({ reminderGraceMs: 0 })
    t.update(acked())
    await t.watcher.poll()
    t.update({ report: { status: "pending", summary: "waiting CI", at: iso(t.now()) } })
    assert.deepEqual((await t.watcher.poll()).events, [{ type: "pending", summary: "waiting CI" }])
    t.update({ status: "pending" })
    assert.deepEqual((await t.watcher.poll()).events, [
      { type: "turn_ended", turn: 1, last_message: "" },
    ])

    t.advance(15 * MIN - 1)
    await t.watcher.poll()
    assert.equal(t.sent.length, 0)
    t.advance(1)
    assert.deepEqual((await t.watcher.poll()).events, [{ type: "reminder", count: 1 }])
    t.advance(10 * MIN)
    await t.watcher.poll()
    assert.equal(t.sent.length, 1)
  })

  test("作業中（running）の間は pending でもリマインダを送らない", async () => {
    const t = setup({ reminderGraceMs: 0 })
    t.update({ ...acked(), report: { status: "pending", summary: "", at: iso(START) } })
    t.advance(20 * MIN)
    await t.watcher.poll()
    assert.equal(t.sent.length, 0)
  })

  test("--timeout を過ぎたら終了コード 4 で終わる", async () => {
    const t = setup({ timeoutMs: 10 * MIN })
    t.update(acked())
    await t.watcher.poll()
    t.advance(10 * MIN + 1)
    const result = await t.watcher.poll()
    assert.equal(result.exitCode, 4)
    assert.deepEqual(result.events.at(-1), { type: "failed", reason: "timeout", summary: "" })
  })

  test("TODO と途中経過が変わったら progress を出す", async () => {
    const t = setup()
    t.update(acked())
    await t.watcher.poll()
    t.update({ tasks: [{ id: "1", subject: "Write tests", done: false }] })
    assert.deepEqual((await t.watcher.poll()).events, [
      { type: "progress", tasks: [{ subject: "Write tests", done: false }] },
    ])
    t.update({ progress: [{ at: iso(t.now()), message: "halfway" }] })
    assert.deepEqual((await t.watcher.poll()).events, [
      { type: "progress", tasks: [{ subject: "Write tests", done: false }], message: "halfway" },
    ])
    assert.deepEqual((await t.watcher.poll()).events, [])
  })

  test("コメントを読めなくても warning を出して待ち続ける", async () => {
    const t = setup()
    t.failRead(new Error("network down"))
    assert.deepEqual(await t.watcher.poll(), {
      events: [{ type: "warning", message: "network down" }],
      exitCode: null,
    })
  })

  test("リマインダを送れなければ warning を出し、次の poll で再び送る", async () => {
    const t = setup({ reminderGraceMs: 0 })
    t.update({ ...acked(), status: "turn_ended" })
    t.failSend(new Error("send failed"))
    const first = await t.watcher.poll()
    assert.deepEqual(first.events.at(-1), { type: "warning", message: "send failed" })
    t.failSend(null)
    assert.deepEqual((await t.watcher.poll()).events, [{ type: "reminder", count: 1 }])
  })

  test("すでに done のセッションは最初の poll で終わる", async () => {
    const t = setup()
    t.update({
      ...acked(),
      status: "done",
      report: { status: "done", summary: "ok", at: iso(START) },
    })
    const result = await t.watcher.poll()
    assert.equal(result.exitCode, 0)
    assert.deepEqual(
      result.events.map((e) => e.type),
      ["ack", "done"],
    )
  })
})
