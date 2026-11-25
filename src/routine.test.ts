import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { fireRoutine } from "./routine.ts"

type Call = { url: string; init: RequestInit }

function makeFetch(status: number, body: unknown) {
  const calls: Call[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

describe("fireRoutine", () => {
  test("渡された fire URL に token と text を送り、セッション ID と URL を返す", async () => {
    const { fetch, calls } = makeFetch(200, {
      type: "routine_fire",
      claude_code_session_id: "session_01abc",
      claude_code_session_url: "https://claude.ai/code/session_01abc",
    })
    const result = await fireRoutine(
      {
        fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_01x/fire",
        token: "sk-ant-oat01-t",
        text: "do it",
      },
      fetch,
    )

    assert.deepEqual(result, {
      sessionId: "session_01abc",
      url: "https://claude.ai/code/session_01abc",
    })
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/claude_code/routines/trig_01x/fire")
    assert.deepEqual(calls[0].init, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ant-oat01-t",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "do it" }),
    })
  })

  test("2xx 以外なら状態コードと error.message を含めて投げる", async () => {
    const { fetch } = makeFetch(401, {
      type: "error",
      error: { type: "authentication_error", message: "token does not match this routine" },
    })
    await assert.rejects(
      fireRoutine({ fireUrl: "https://example.test/fire", token: "bad", text: "x" }, fetch),
      /401 authentication_error: token does not match this routine/,
    )
  })
})
