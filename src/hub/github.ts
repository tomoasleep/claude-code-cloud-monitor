import type { CommandRunner } from "../command.ts"

export type RepoRef = { owner: string; repo: string }
export type IssueRef = RepoRef & { issue: number }
export type CommentRef = RepoRef & { commentId: number }

export type CommentRead =
  | { modified: true; body: string; etag: string | null }
  | { modified: false; etag: string | null }

export type UpdatedComments =
  | {
      modified: true
      etag: string | null
      comments: { ref: CommentRef; body: string; updatedAt: string }[]
    }
  | { modified: false; etag: string | null }

export type HubClient = {
  createComment(issue: IssueRef, body: string): Promise<{ ref: CommentRef; url: string }>
  getComment(ref: CommentRef, etag?: string | null): Promise<CommentRead>
  updateComment(ref: CommentRef, body: string): Promise<void>
  listIssueComments(issue: IssueRef): Promise<{ ref: CommentRef; body: string }[]>
  listUpdatedComments(repo: RepoRef, since: string, etag?: string | null): Promise<UpdatedComments>
}

const NAME = "[A-Za-z0-9_.-]+"

export function parseHubSpec(spec: string): IssueRef {
  const match = new RegExp(`^github:(${NAME})/(${NAME})#(\\d+)$`).exec(spec)
  if (!match)
    throw new Error(`invalid hub: ${JSON.stringify(spec)} (expected github:owner/repo#number)`)
  return { owner: match[1], repo: match[2], issue: Number(match[3]) }
}

export function parseCommentRef(spec: string): CommentRef {
  const match = new RegExp(`^github:(${NAME})/(${NAME})/comments/(\\d+)$`).exec(spec)
  if (!match) {
    throw new Error(
      `invalid comment reference: ${JSON.stringify(spec)} (expected github:owner/repo/comments/id)`,
    )
  }
  return { owner: match[1], repo: match[2], commentId: Number(match[3]) }
}

export function formatCommentRef(ref: CommentRef): string {
  return `github:${ref.owner}/${ref.repo}/comments/${ref.commentId}`
}

type HttpResponse = { status: number; headers: Record<string, string>; body: string }

function parseHttpResponse(output: string): HttpResponse | null {
  const separator = /\r?\n\r?\n/.exec(output)
  const head = separator ? output.slice(0, separator.index) : output
  const [statusLine, ...headerLines] = head.split(/\r?\n/)
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1]
  if (!status) return null
  const headers: Record<string, string> = {}
  for (const line of headerLines) {
    const index = line.indexOf(":")
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }
  const body = separator ? output.slice(separator.index + separator[0].length) : ""
  return { status: Number(status), headers, body }
}

export function createGitHubHub(deps: {
  runner: CommandRunner
  env: Record<string, string | undefined>
}): HubClient {
  const gh = async (args: string[], input?: string) => {
    const result = await deps.runner("gh", args, { env: deps.env, input })
    if (result.exitCode !== 0) {
      throw new Error(
        `gh ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    return result.stdout
  }

  const conditionalGet = async (path: string, etag?: string | null) => {
    const args = ["api", "-i", ...(etag ? ["-H", `If-None-Match: ${etag}`] : []), path]
    const result = await deps.runner("gh", args, { env: deps.env })
    const response = parseHttpResponse(result.stdout)
    if (!response || (response.status !== 200 && response.status !== 304)) {
      throw new Error(`gh api ${path} failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
    return response
  }

  return {
    async createComment(issue, body) {
      const stdout = await gh(
        [
          "api",
          "-X",
          "POST",
          `repos/${issue.owner}/${issue.repo}/issues/${issue.issue}/comments`,
          "--input",
          "-",
        ],
        JSON.stringify({ body }),
      )
      const json = JSON.parse(stdout)
      return {
        ref: { owner: issue.owner, repo: issue.repo, commentId: json.id },
        url: json.html_url,
      }
    },

    async getComment(ref, etag) {
      const response = await conditionalGet(
        `repos/${ref.owner}/${ref.repo}/issues/comments/${ref.commentId}`,
        etag,
      )
      const newEtag = response.headers.etag ?? etag ?? null
      if (response.status === 304) return { modified: false, etag: newEtag }
      return { modified: true, body: JSON.parse(response.body).body, etag: newEtag }
    },

    async updateComment(ref, body) {
      await gh(
        [
          "api",
          "-X",
          "PATCH",
          `repos/${ref.owner}/${ref.repo}/issues/comments/${ref.commentId}`,
          "--input",
          "-",
        ],
        JSON.stringify({ body }),
      )
    },

    async listIssueComments(issue) {
      const stdout = await gh([
        "api",
        "--paginate",
        `repos/${issue.owner}/${issue.repo}/issues/${issue.issue}/comments`,
        "--jq",
        ".[] | {id, body}",
      ])
      return stdout
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const json = JSON.parse(line)
          return {
            ref: { owner: issue.owner, repo: issue.repo, commentId: json.id },
            body: json.body,
          }
        })
    },

    async listUpdatedComments(repo, since, etag) {
      const query = new URLSearchParams({
        sort: "updated",
        direction: "desc",
        since,
        per_page: "100",
      })
      const response = await conditionalGet(
        `repos/${repo.owner}/${repo.repo}/issues/comments?${query}`,
        etag,
      )
      const newEtag = response.headers.etag ?? etag ?? null
      if (response.status === 304) return { modified: false, etag: newEtag }
      const comments = (
        JSON.parse(response.body) as { id: number; body: string; updated_at: string }[]
      ).map((c) => ({ ref: { ...repo, commentId: c.id }, body: c.body, updatedAt: c.updated_at }))
      return { modified: true, etag: newEtag, comments }
    },
  }
}
