import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { buildPrompt, isReminderPrompt, REMINDER_TEXT } from "./prompt.ts"

describe("buildPrompt", () => {
  test("ユーザーのプロンプトを先頭に置き、後ろに init と done の指示を足す", () => {
    const prompt = buildPrompt("/fix-bug please", {
      to: "github:octocat/hub/comments/123",
      addRepo: null,
    })
    assert.ok(prompt.startsWith("/fix-bug please\n"))
    assert.match(prompt, /cccm report init --to github:octocat\/hub\/comments\/123/)
    assert.match(prompt, /cccm report done --summary/)
    assert.match(prompt, /cccm report failed --summary/)
    assert.doesNotMatch(prompt, /add_repo/)
  })

  test("hub の repo が作業 repo と違うときだけ add_repo の指示を付ける", () => {
    const prompt = buildPrompt("task", {
      to: "github:octocat/hub/comments/123",
      addRepo: "octocat/hub",
    })
    assert.match(
      prompt,
      /add octocat\/hub to this session with the claude-code-remote tool `add_repo`/,
    )
  })
})

describe("isReminderPrompt", () => {
  test("リマインダの文面を見分ける", () => {
    assert.equal(isReminderPrompt(REMINDER_TEXT), true)
    assert.equal(isReminderPrompt("please continue"), false)
  })
})
