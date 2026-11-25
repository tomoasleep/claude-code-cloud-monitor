import type { CommandRunner } from "./command.ts"
import { sessionUrl } from "./state.ts"

export async function runTokenCommand(
  command: string,
  runner: CommandRunner,
  env: Record<string, string | undefined>,
): Promise<string> {
  const result = await runner("sh", ["-c", command], { env })
  const token = result.stdout.trim()
  if (result.exitCode !== 0 || !token) {
    throw new Error(
      `token_command failed (exit ${result.exitCode}): ${result.stderr.trim() || "no output"}`,
    )
  }
  return token
}

export type FireOptions = { fireUrl: string; token: string; text: string }

export async function fireRoutine(
  { fireUrl, token, text }: FireOptions,
  fetch: typeof globalThis.fetch,
): Promise<{ sessionId: string; url: string }> {
  const response = await fetch(fireUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = body?.error
    throw new Error(
      `routine fire failed: ${response.status} ${error?.type ?? ""}: ${error?.message ?? ""}`,
    )
  }
  const sessionId = String(body.claude_code_session_id).replace(/^cse_/, "session_")
  return { sessionId, url: sessionUrl(sessionId) }
}
