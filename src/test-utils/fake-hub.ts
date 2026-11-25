import type { CommentRef, HubClient } from "../hub/github.ts"
import { renderComment, type State } from "../state.ts"

export function makeFakeHub(initial: State) {
  let body = renderComment(initial)
  let version = 1
  let failNext: Error | null = null
  const updates: string[] = []
  const hub: HubClient = {
    async createComment(issue) {
      return { ref: { owner: issue.owner, repo: issue.repo, commentId: 1 }, url: "u" }
    },
    async getComment(_ref: CommentRef, etag?: string | null) {
      if (failNext) {
        const error = failNext
        failNext = null
        throw error
      }
      const current = `"v${version}"`
      if (etag === current) return { modified: false, etag: current }
      return { modified: true, body, etag: current }
    },
    async updateComment(_ref, newBody) {
      updates.push(newBody)
      body = newBody
      version++
    },
    async listIssueComments() {
      return []
    },
    async listUpdatedComments() {
      return { modified: false, etag: null }
    },
  }
  return {
    hub,
    updates,
    set(state: State) {
      body = renderComment(state)
      version++
    },
    failOnce(error: Error) {
      failNext = error
    },
  }
}
