import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { parseDuration } from "./duration.ts"

describe("parseDuration", () => {
  test("単位付きの時間をミリ秒にする", () => {
    assert.equal(parseDuration("500ms"), 500)
    assert.equal(parseDuration("10s"), 10_000)
    assert.equal(parseDuration("5m"), 300_000)
    assert.equal(parseDuration("2h"), 7_200_000)
  })

  test("単位を組み合わせられる", () => {
    assert.equal(parseDuration("1h30m"), 5_400_000)
  })

  test("0 は単位なしでも 0 にする", () => {
    assert.equal(parseDuration("0"), 0)
  })

  test("解釈できない値はエラーにする", () => {
    assert.throws(() => parseDuration("10"), /invalid duration/)
    assert.throws(() => parseDuration("abc"), /invalid duration/)
    assert.throws(() => parseDuration(""), /invalid duration/)
  })
})
