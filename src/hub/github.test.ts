import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { httpResponse, makeFakeRunner } from "../test-utils/fake-runner.ts"
import { createGitHubHub, formatCommentRef, parseCommentRef, parseHubSpec } from "./github.ts"

const env = { GH_TOKEN: "t" }

describe("parseHubSpec", () => {
  test("github:owner/repo#number を読む", () => {
    assert.deepEqual(parseHubSpec("github:octocat/hub#12"), {
      owner: "octocat",
      repo: "hub",
      issue: 12,
    })
  })

  test("形式が違えばエラー", () => {
    assert.throws(() => parseHubSpec("octocat/hub#12"), /invalid hub/)
    assert.throws(() => parseHubSpec("github:octocat/hub"), /invalid hub/)
  })
})

describe("parseCommentRef / formatCommentRef", () => {
  test("github:owner/repo/comments/id を読み書きする", () => {
    const ref = { owner: "octocat", repo: "hub", commentId: 99 }
    assert.deepEqual(parseCommentRef("github:octocat/hub/comments/99"), ref)
    assert.equal(formatCommentRef(ref), "github:octocat/hub/comments/99")
  })

  test("形式が違えばエラー", () => {
    assert.throws(() => parseCommentRef("github:octocat/hub#99"), /invalid comment reference/)
  })
})

describe("GitHubHub", () => {
  test("コメントを作るときは本文を標準入力の JSON で渡す", async () => {
    const { runner, calls } = makeFakeRunner(() => ({
      stdout: JSON.stringify({ id: 5, html_url: "https://github.com/octocat/hub/issues/1#c5" }),
    }))
    const hub = createGitHubHub({ runner, env })
    const created = await hub.createComment({ owner: "octocat", repo: "hub", issue: 1 }, "hi")
    assert.deepEqual(created, {
      ref: { owner: "octocat", repo: "hub", commentId: 5 },
      url: "https://github.com/octocat/hub/issues/1#c5",
    })
    assert.deepEqual(calls[0].args, [
      "api",
      "-X",
      "POST",
      "repos/octocat/hub/issues/1/comments",
      "--input",
      "-",
    ])
    assert.equal(calls[0].options.input, JSON.stringify({ body: "hi" }))
    assert.equal(calls[0].options.env, env)
  })

  test("コメントは ETag 付きで読み、変わっていなければ 304 として扱う", async () => {
    const ref = { owner: "octocat", repo: "hub", commentId: 5 }
    const responses = [
      { stdout: httpResponse("200 OK", { Etag: '"abc"' }, JSON.stringify({ body: "v1" })) },
      {
        exitCode: 1,
        stdout: httpResponse("304 Not Modified", { Etag: '"abc"' }, ""),
        stderr: "gh: HTTP 304",
      },
    ]
    const { runner, calls } = makeFakeRunner(() => responses.shift()!)
    const hub = createGitHubHub({ runner, env })

    assert.deepEqual(await hub.getComment(ref), { modified: true, body: "v1", etag: '"abc"' })
    assert.deepEqual(await hub.getComment(ref, '"abc"'), { modified: false, etag: '"abc"' })
    assert.deepEqual(calls[0].args, ["api", "-i", "repos/octocat/hub/issues/comments/5"])
    assert.deepEqual(calls[1].args, [
      "api",
      "-i",
      "-H",
      'If-None-Match: "abc"',
      "repos/octocat/hub/issues/comments/5",
    ])
  })

  test("ETag のない応答も読める", async () => {
    const { runner } = makeFakeRunner(() => ({
      stdout: httpResponse("200 OK", {}, JSON.stringify({ body: "v1" })),
    }))
    const hub = createGitHubHub({ runner, env })
    assert.deepEqual(await hub.getComment({ owner: "o", repo: "r", commentId: 1 }), {
      modified: true,
      body: "v1",
      etag: null,
    })
  })

  test("読めなければ gh のエラーを含めて投げる", async () => {
    const { runner } = makeFakeRunner(() => ({
      exitCode: 1,
      stdout: httpResponse("404 Not Found", {}, '{"message":"Not Found"}'),
      stderr: "gh: Not Found (HTTP 404)",
    }))
    const hub = createGitHubHub({ runner, env })
    await assert.rejects(hub.getComment({ owner: "o", repo: "r", commentId: 1 }), /HTTP 404/)
  })

  test("コメントを PATCH で書き換える", async () => {
    const { runner, calls } = makeFakeRunner(() => ({ stdout: "{}" }))
    const hub = createGitHubHub({ runner, env })
    await hub.updateComment({ owner: "o", repo: "r", commentId: 7 }, "new")
    assert.deepEqual(calls[0].args, [
      "api",
      "-X",
      "PATCH",
      "repos/o/r/issues/comments/7",
      "--input",
      "-",
    ])
    assert.equal(calls[0].options.input, JSON.stringify({ body: "new" }))
  })

  test("Issue のコメントを全ページ読む", async () => {
    const { runner, calls } = makeFakeRunner(() => ({
      stdout: '{"id":1,"body":"a"}\n{"id":2,"body":"b"}\n',
    }))
    const hub = createGitHubHub({ runner, env })
    assert.deepEqual(await hub.listIssueComments({ owner: "o", repo: "r", issue: 3 }), [
      { ref: { owner: "o", repo: "r", commentId: 1 }, body: "a" },
      { ref: { owner: "o", repo: "r", commentId: 2 }, body: "b" },
    ])
    assert.deepEqual(calls[0].args, [
      "api",
      "--paginate",
      "repos/o/r/issues/3/comments",
      "--jq",
      ".[] | {id, body}",
    ])
  })

  test("repo 全体の更新されたコメントを since と ETag で読む", async () => {
    const responses = [
      {
        stdout: httpResponse(
          "200 OK",
          { ETag: 'W/"l1"' },
          JSON.stringify([{ id: 9, body: "x", updated_at: "2026-11-25T01:00:00Z" }]),
        ),
      },
      { exitCode: 1, stdout: httpResponse("304 Not Modified", {}, "") },
    ]
    const { runner, calls } = makeFakeRunner(() => responses.shift()!)
    const hub = createGitHubHub({ runner, env })

    assert.deepEqual(
      await hub.listUpdatedComments({ owner: "o", repo: "r" }, "2026-11-25T00:00:00Z"),
      {
        modified: true,
        etag: 'W/"l1"',
        comments: [
          {
            ref: { owner: "o", repo: "r", commentId: 9 },
            body: "x",
            updatedAt: "2026-11-25T01:00:00Z",
          },
        ],
      },
    )
    assert.deepEqual(calls[0].args, [
      "api",
      "-i",
      "repos/o/r/issues/comments?sort=updated&direction=desc&since=2026-11-25T00%3A00%3A00Z&per_page=100",
    ])
    assert.deepEqual(
      await hub.listUpdatedComments({ owner: "o", repo: "r" }, "2026-11-25T00:00:00Z", 'W/"l1"'),
      { modified: false, etag: 'W/"l1"' },
    )
  })
})
