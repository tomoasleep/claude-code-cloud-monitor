# claude-code-cloud-monitor (`cccm`)

Launch [Claude Code cloud sessions](https://claude.ai/code) from your terminal and wait until the task is done, using a GitHub issue comment as the place where the session reports its status.

- `cccm launch` wraps `claude --cloud`, then waits for the agent to report `done` (or `failed`) and prints the result as text or JSON.
- Inside the cloud session, the agent runs `cccm report …`, and a Claude Code plugin hook (`cccm report hook`) records turns and TODOs. Both rewrite one comment on a GitHub issue (the *hub*).
- When a turn ends without a report, `cccm` sends a reminder to the session with `claude -p … --cloud <id>`.

There is no public API to read the state of a cloud session from your machine, so the session pushes its state to GitHub and `cccm` polls it.

```
your machine                         GitHub issue (hub)                  cloud session
────────────                         ──────────────────                  ─────────────
cccm launch ── creates comment ────▶ <!-- cccm-state:v1 … -->
            ── claude --cloud ─────────────────────────────────────────▶ agent starts
                                                                          cccm report init --to …   (ack)
            ◀─ polls (ETag) ─────── state updated  ◀───────────────────── hook: TaskCreated / Stop
            ── reminder (claude -p --cloud <id>) ──────────────────────▶ cccm report pending / done
            ◀─ done ──────────────── state: done
```

## Requirements

- Node.js 22.18 or later, and the [`gh`](https://cli.github.com/) CLI logged in to GitHub (on your machine).
- Claude Code with access to cloud sessions (`claude --cloud`).
- A GitHub issue to use as the hub. If it is in a different repository than the one you work on, the agent adds it to the session with the `add_repo` tool of the `claude-code-remote` MCP server.

## Setup

### 1. Your machine

```bash
npm install -g claude-code-cloud-monitor
```

### 2. The cloud environment

In [claude.ai/code](https://claude.ai/code), open the settings of the environment you use and set its **setup script**:

```bash
#!/bin/bash
set -eu
npm install -g claude-code-cloud-monitor
cccm plugin install
```

`cccm plugin install` does three things in the VM:

1. `claude plugin marketplace add tomoasleep/claude-code-cloud-monitor`
2. `claude plugin install cccm@claude-code-cloud-monitor` (the hook that runs `cccm report hook` on `UserPromptSubmit`, `TaskCreated`, `TaskCompleted` and `Stop`)
3. Adds `Bash(cccm report:*)` and `mcp__claude-code-remote__add_repo` to `permissions.allow` in `~/.claude/settings.json`, so the agent can report without asking for approval. (Permissions passed with launch flags do not reach the VM.)

<details>
<summary>Installing from source instead of npm</summary>

`npm install -g github:tomoasleep/claude-code-cloud-monitor` does not work, because npm does not install the dev dependencies needed for the build when installing a git dependency globally. Build a tarball instead:

```bash
git clone --depth 1 https://github.com/tomoasleep/claude-code-cloud-monitor /tmp/cccm-src
cd /tmp/cccm-src
npm ci
npm pack
npm install -g ./claude-code-cloud-monitor-*.tgz
cccm plugin install
```

</details>

## Usage

```bash
cd path/to/your/repo   # the session works on this repository, as with claude --cloud
cccm launch --hub github:<hub-owner>/<hub-repo>#<issue> "Fix the flaky test in src/foo.test.ts"
```

The prompt can also come from stdin: `echo "…" | cccm launch --hub …`.

`cccm` puts your prompt first (so a leading slash command still works) and appends instructions that tell the agent to run `cccm report init --to <comment>` before starting and `cccm report done --summary "…"` (or `failed`) at the end.

### `cccm launch`

```
cccm launch --hub github:owner/repo#number [cccm options] [claude options] [prompt]

  --hub <spec>                     Where to write the status (required)
  --env <env_id>                   Cloud environment ID. Passed as remote.defaultEnvironmentId
                                   in a temporary --settings file (merged with your --settings)
  --output-format <fmt>            text (default) | json | stream-json
  --ack-timeout <dur>              Fail if the agent does not run `cccm report init` in time. Default 5m
  --reminder-grace <dur>           No reminders this soon after launch. Default 3m (0 disables)
  --pending-remind-interval <dur>  Remind again while the agent stays `pending`. Default 15m
  --timeout <dur>                  Give up after this long. Default none
  --interval <dur>                 How often to read the comment. Default 10s
  --no-wait                        Exit after the session is created
```

Other options are passed to `claude --cloud` (`--model`, `--effort`, `-n/--name`, `--ref`, `--settings`, …). For an option `cccm` does not know that takes a value, write `--option=value`.

Durations are written like `500ms`, `10s`, `5m`, `1h30m`.

### `cccm monitor`

```
cccm monitor --hub github:owner/repo#number [--session <session_id>] [options]
```

Waits like `launch` does after the session is created: for a session launched with `--no-wait`, or to resume waiting after `launch` was interrupted. Without `--session` it picks the newest `cccm` comment in the issue. The timing and output options are the same as `launch`.

### Output

`--output-format stream-json` prints one event per line:

```json
{"type":"launched","session_id":"session_01…","session_url":"https://claude.ai/code/session_01…","hub":"github:owner/repo#123","comment_url":"…"}
{"type":"ack","at":"…"}
{"type":"progress","tasks":[{"subject":"Write tests","done":false}],"message":"…"}
{"type":"turn_ended","turn":1,"last_message":"…"}
{"type":"reminder","count":1}
{"type":"pending","summary":"…"}
{"type":"done","summary":"…","tasks":[…],"last_message":"…","session_url":"…"}
```

A failure ends with `{"type":"failed","reason":"reported"|"ack_timeout"|"timeout",…}`, and a temporary problem (for example a failed GitHub request) is reported as `{"type":"warning","message":"…"}` while waiting continues.

`--output-format json` prints only the final event (`launched` with `--no-wait`). `text` prints the same events for people.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | done (with `--no-wait`: the session was created) |
| 1 | failed |
| 2 | invalid arguments |
| 3 | the agent did not acknowledge (`cccm report init`) within `--ack-timeout` |
| 4 | `--timeout` passed |
| 5 | launch failed (no session ID in the output of `claude --cloud`, or the hub comment could not be created) |

### Reminders

When a turn ends (the `Stop` hook) without `done` or `failed`, `cccm` sends this to the session:

```
[cccm] Is the task finished?
If it is, run:       cccm report done    --summary "..."
If it failed, run:   cccm report failed  --summary "..."
If you are continuing the task (or background work is still running), first run:
                     cccm report pending --summary "<what remains>"
then continue.
```

It sends at most one reminder per turn, none during `--reminder-grace` after launch, and while the agent is idle with `pending` it reminds again every `--pending-remind-interval`. There is no limit on the number of reminders; use `--timeout` to stop.

## Commands for the cloud session

```
cccm report init     --to github:owner/repo/comments/<id>   Save the destination and acknowledge
cccm report progress "<message>"
cccm report pending  [--summary "…"]
cccm report done     [--summary "…" | --summary-file <path>]
cccm report failed   [--summary "…" | --summary-file <path>]
cccm report hook     (called by the plugin hook; reads the hook JSON from stdin)
```

`init` stores the destination in `/tmp/cccm/<CLAUDE_CODE_REMOTE_SESSION_ID>.json`, and later commands and the hook write there (`--to` on another command overrides it). `init`, `progress`, `pending`, `done` and `failed` exit 1 with the reason when they cannot write, so the agent can see it (for example a 403 when the hub repository was not added to the session). `hook` does nothing outside a cloud session (`CLAUDE_CODE_REMOTE` is not `true`) or before `init`, never prints anything, and always exits 0.

## The hub comment

One comment holds both a Markdown summary for people and the machine-readable state, base64-encoded JSON in an HTML comment:

```markdown
<!-- cccm-state:v1 eyJ2ZXJzaW9uIjoxLCJzdGF0dXMiOiJkb25lIi… -->
**状態**: 完了（done）
**セッション**: https://claude.ai/code/session_01…
**開始**: … / **更新**: …

### 報告

…

### TODO

- [x] Write tests

## 直近の応答

<details>
<summary>全文を表示</summary>

…

</details>
```

Long text is shortened to stay within GitHub's comment size limit. Do not edit the comment by hand.

`cccm` reads the comment with `If-None-Match`, so polls that see no change get `304 Not Modified`, which does not count against the primary rate limit.

## Checking it end to end in the cloud

The automated tests replace GitHub and Claude Code. To confirm a release works with the real services:

1. Set the setup script of a cloud environment as described in [Setup](#2-the-cloud-environment). Note the environment ID (`env_…`).
2. Create an issue for the hub in a repository you can write to (a private one is fine).
3. From a clone of a repository that cloud sessions can use, run:

   ```bash
   cccm launch --hub github:<hub-owner>/<hub-repo>#<issue> --env <env_id> --output-format stream-json \
     "Create three tasks with TaskCreate (a, b, c), complete them one by one, then finish."
   ```

4. Check, in the output and in the hub comment:
   - `launched`, then `ack` within a few minutes (the agent added the hub repository, if it differs, and ran `cccm report init` without an approval prompt).
   - `progress` events with the three tasks, and the TODO list in the comment.
   - `done` with the summary, and the comment shows 完了（done）.
5. To check reminders, launch with a prompt that ends a turn without reporting (for example "Ask me a question and wait for my answer"). After the turn ends, `cccm` should print `reminder`, and the agent should answer with `pending`, `done` or `failed`.

## Development

```bash
npm ci
npm test          # unit and integration tests (node --test)
npm run typecheck
npm run check     # Biome
npm run build
```

- Tests sit next to the source (`src/**/*.test.ts`) and run with Node's type stripping.
- Collaborators that cross a process or network boundary (`gh`, `claude`, `script`, the clock) are injected through `deps`; everything else runs for real.
- Integration tests point `gh` at the GitHub emulator of [emulate](https://github.com/vercel-labs/emulate) with `GH_HOST=github.localhost`, `HTTP_PROXY=http://127.0.0.1:<port>` and the token from the seed. The repository-wide comment list and ETags are not supported by the emulator, so they are covered by unit tests with a fake command runner.

See [docs/design.html](docs/design.html) for the design.

## License

MIT
