import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createReporter } from "./output.ts"

const launched = {
  type: "launched" as const,
  session_id: "session_01abc",
  session_url: "https://claude.ai/code/session_01abc",
  hub: "github:octocat/hub#1",
  comment_url: "https://github.com/octocat/hub/issues/1#issuecomment-5",
}
const done = {
  type: "done" as const,
  summary: "did it",
  tasks: [{ subject: "Write tests", done: true }],
  last_message: "bye",
  session_url: "https://claude.ai/code/session_01abc",
}

function collect(format: "text" | "json" | "stream-json") {
  const out: string[] = []
  return { reporter: createReporter(format, (s) => out.push(s)), out }
}

describe("createReporter", () => {
  test("stream-json はイベントを 1 行ずつ JSON で出す", () => {
    const { reporter, out } = collect("stream-json")
    reporter.event(launched)
    reporter.event({ type: "ack", at: "t" })
    reporter.event(done)
    assert.deepEqual(
      out
        .join("")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l)),
      [launched, { type: "ack", at: "t" }, done],
    )
  })

  test("json は最後の結果だけを 1 つ出す", () => {
    const { reporter, out } = collect("json")
    reporter.event(launched)
    reporter.event({ type: "reminder", count: 1 })
    reporter.event(done)
    assert.deepEqual(JSON.parse(out.join("")), done)
  })

  test("json で --no-wait のときは launched を結果として出す", () => {
    const { reporter, out } = collect("json")
    reporter.event(launched)
    reporter.finish()
    assert.deepEqual(JSON.parse(out.join("")), launched)
  })

  test("text は人が読む形で出す", () => {
    const { reporter, out } = collect("text")
    reporter.event(launched)
    reporter.event({ type: "turn_ended", turn: 1, last_message: "first line\nsecond" })
    reporter.event(done)
    const text = out.join("")
    assert.match(text, /Launched: https:\/\/claude\.ai\/code\/session_01abc/)
    assert.match(text, /Turn 1 ended: first line/)
    assert.match(text, /Done: did it/)
    assert.match(text, /\[x\] Write tests/)
    assert.match(text, /bye/)
  })
})
