export type FireOptions = { routineId: string; token: string; text: string }

export async function fireRoutine(
  { routineId, token, text }: FireOptions,
  fetch: typeof globalThis.fetch,
): Promise<{ sessionId: string; url: string }> {
  const response = await fetch(
    `https://api.anthropic.com/v1/claude_code/routines/${routineId}/fire`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    },
  )
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = body?.error
    throw new Error(
      `routine fire failed: ${response.status} ${error?.type ?? ""}: ${error?.message ?? ""}`,
    )
  }
  return { sessionId: body.claude_code_session_id, url: body.claude_code_session_url }
}
