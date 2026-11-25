import { LLMock } from "@copilotkit/aimock"

export type ScriptedReply = {
  expectedUserMessage?: string
  content?: string
  bash?: string
}

function isTitleGenerationRequest(request: unknown): boolean {
  return JSON.stringify(request).includes("Write the title in the predominant language")
}

export async function startLlmMock(script: ScriptedReply[]) {
  const mock = new LLMock()
  const errors: string[] = []
  let index = 0
  mock.on({}, async (request) => {
    if (isTitleGenerationRequest(request)) return { content: "E2E session" }
    const reply = script[index]
    if (!reply) {
      errors.push(`unexpected request #${index}`)
      return { content: "(no scripted reply)" }
    }
    if (reply.expectedUserMessage && !JSON.stringify(request).includes(reply.expectedUserMessage)) {
      errors.push(`request #${index} did not contain ${JSON.stringify(reply.expectedUserMessage)}`)
    }
    index++
    if (reply.bash) {
      return {
        toolCalls: [
          { name: "Bash", arguments: JSON.stringify({ command: reply.bash, description: "cccm" }) },
        ],
      }
    }
    return { content: reply.content ?? "" }
  })
  await mock.start()
  return {
    url: mock.url,
    errors,
    consumed: () => index,
    stop: () => mock.stop(),
  }
}
