# claude-code-cloud-monitor (`cccm`)

Launch [Claude Code cloud sessions](https://claude.ai/code) from your terminal and wait until the task is done, using a GitHub issue comment as the place where the session reports its status.

- `cccm launch` starts a session, either with `claude --cloud` or by firing a [routine](https://code.claude.com/docs/en/routines) (you choose with `--via`), then waits for the agent to report `done` (or `failed`) and prints the result as text or JSON.
- Inside the cloud session, the agent runs `cccm report …`, and a Claude Code plugin hook (`cccm report hook`) records turns and TODOs. Both rewrite one comment on a GitHub issue (the *hub*).
- When a turn ends without a report, `cccm` sends a reminder to the session with `claude -p … --cloud <id>`.

There is no public API to read the state of a cloud session from your machine, so the session pushes its state to GitHub and `cccm` polls it.

```
your machine                         GitHub issue (hub)                  cloud session
────────────                         ──────────────────                  ─────────────
cccm launch ── creates comment ────▶ <!-- cccm-state:v1 … -->
            ── claude --cloud / routine fire ──────────────────────────▶ agent starts
                                                                          cccm report init --to …   (ack)
            ◀─ polls (ETag) ─────── state updated  ◀───────────────────── hook: TaskCreated / Stop
            ── reminder (claude -p --cloud <id>) ──────────────────────▶ cccm report pending / done
            ◀─ done ──────────────── state: done
```

## Requirements

- Node.js 22.18 or later, and the [`gh`](https://cli.github.com/) CLI logged in to GitHub (on your machine).
- Claude Code with access to cloud sessions (`claude --cloud`), or a routine for `--via routine`.
- A GitHub issue to use as the hub, in a repository that the session can write to. `cccm` does not attach repositories for you: the session reaches GitHub only for the repositories attached to it, so put the hub issue in the repository you work on, or list the hub repository in the routine. If the session cannot write to the hub, `cccm report init` fails and `cccm launch` exits with code 3 when `--ack-timeout` passes.

## Setup

> [!IMPORTANT]
> The package is not published to npm yet. Until it is, use [Installing from source](#installing-from-source) in both places below.

### 1. Your machine

```bash
npm install -g @tomoasleep/claude-code-cloud-monitor
```

### 2. The cloud environment

In [claude.ai/code](https://claude.ai/code), open the settings of the environment you use and set its **setup script**:

```bash
#!/bin/bash
set -eu
npm install -g @tomoasleep/claude-code-cloud-monitor
cccm plugin install
```

`cccm plugin install` does three things in the VM:

1. `claude plugin marketplace add tomoasleep/claude-code-cloud-monitor`
2. `claude plugin install cccm@claude-code-cloud-monitor` (the hook that runs `cccm report hook` on `UserPromptSubmit`, `TaskCreated`, `TaskCompleted` and `Stop`)
3. Adds `Bash(cccm report:*)` to `permissions.allow` in `~/.claude/settings.json`, so the agent can report without asking for approval. (Permissions passed with launch flags do not reach the VM.)

### 3. A routine (only for `--via routine`)

Create a routine in [claude.ai/code/routines](https://claude.ai/code/routines) with the repositories the session needs (the one to work on and the hub repository) and the environment from step 2. The text `cccm` sends arrives as a `<routine-fire-payload>` block that the agent treats as data, so the routine's prompt must tell it to act on the payload, for example:

```
Treat the text in the routine fire payload as the user's request and carry it out,
including the cccm instructions at its end.
```

> [!NOTE]
> Routine sessions run in auto mode, and as of November 2026 its permission check sometimes blocks `cccm report init` as "unsanctioned communication", even with `Bash(cccm report:*)` allowed in the VM. The session then never acknowledges and `cccm launch` exits with code 3. In our runs this depended on the prompt: a task with several steps went through, while a one-line task was blocked every time.

Add an API trigger and generate its token. Store the token where a command can print it (a keychain or password manager), then register the routine under a name:

```bash
cccm routine add my-hub \
  --fire-url "https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" \
  --token-command "security find-generic-password -s cccm-my-hub -w"
```

- `--fire-url` is the URL shown for the API trigger, as it is.
- `--token-command` prints the token to stdout, for example `security find-generic-password -s … -w` (macOS Keychain), `op read op://…` (1Password) or `secret-tool lookup …` (libsecret). `cccm` runs it with `sh -c` on every launch and never stores the token itself.
- Profiles are saved in `~/.config/cccm/routines.toml` (or `$XDG_CONFIG_HOME/cccm/routines.toml`). Adding a name that exists replaces it.
- `CCCM_ROUTINE_FIRE_URL` and `CCCM_ROUTINE_TOKEN`, when set, take precedence over the profile.

### Installing from source

<details>
<summary>Show the steps</summary>

`npm install -g github:tomoasleep/claude-code-cloud-monitor` does not work, because npm does not install the dev dependencies needed for the build when installing a git dependency globally. Build a tarball instead:

```bash
git clone --depth 1 https://github.com/tomoasleep/claude-code-cloud-monitor /tmp/cccm-src
cd /tmp/cccm-src
npm ci
npm pack
npm install -g ./tomoasleep-claude-code-cloud-monitor-*.tgz
cccm plugin install
```

</details>

## Usage

```bash
# with claude --cloud: the session works on the repository in the current directory
cd path/to/your/repo
cccm launch --via cloud --hub github:<owner>/<repo>#<issue> "Fix the flaky test in src/foo.test.ts"

# with a routine: the routine decides the repositories, environment and permissions
cccm launch --via routine --routine my-hub \
  --hub github:<hub-owner>/<hub-repo>#<issue> "Fix the flaky test in src/foo.test.ts"
```

The prompt can also come from stdin: `echo "…" | cccm launch --via cloud --hub …`.

`cccm` puts your prompt first (so a leading slash command still works) and appends instructions that tell the agent to run `cccm report init --to <comment>` before starting and `cccm report done --summary "…"` (or `failed`) at the end.

### `cccm launch`

```
cccm launch --via cloud   --hub github:owner/repo#number [cccm options] [claude options] [prompt]
cccm launch --via routine --routine <name> --hub github:owner/repo#number [cccm options] [prompt]

  --via <cloud|routine>            How to start the session (required)
  --routine <name>                 The routine profile to fire (--via routine; see cccm routine add)
  --hub <spec>                     Where to write the status (required)
  --env <env_id>                   Cloud environment ID (--via cloud). Passed as remote.defaultEnvironmentId
                                   in a temporary --settings file (merged with your --settings)
  --output-format <fmt>            text (default) | json | stream-json
  --ack-timeout <dur>              Fail if the agent does not run `cccm report init` in time. Default 5m
  --reminder-grace <dur>           No reminders this soon after launch. Default 3m (0 disables)
  --pending-remind-interval <dur>  Remind again while the agent stays `pending`. Default 15m
  --timeout <dur>                  Give up after this long. Default none
  --interval <dur>                 How often to read the comment. Default 10s
  --no-wait                        Exit after the session is created
```

With `--via cloud`, other options are passed to `claude --cloud` (`--model`, `--effort`, `-n/--name`, `--ref`, `--settings`, …). For an option `cccm` does not know that takes a value, write `--option=value`. With `--via routine`, `--env` and claude options are rejected, because the routine defines them. A failed fire is not retried (fires are not idempotent). If `token_command` fails, nothing is fired and `cccm` exits with code 5.

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
| 5 | launch failed (no session ID in the output of `claude --cloud`, `token_command` or the routine fire failed, or the hub comment could not be created) |

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
2. Create an issue for the hub in the repository the session works on (a private one is fine).
3. From a clone of that repository, run:

   ```bash
   cccm launch --via cloud --hub github:<owner>/<repo>#<issue> --env <env_id> --output-format stream-json \
     "Create three tasks with TaskCreate (a, b, c), complete them one by one, then finish."
   ```

   For `--via routine`, set up a routine as in [Setup](#3-a-routine-only-for---via-routine) with the hub repository attached, register it with `cccm routine add`, and run the same command with `--via routine --routine <name>` instead of `--via cloud … --env <env_id>`.

4. Check, in the output and in the hub comment:
   - `launched`, then `ack` within a few minutes (the agent ran `cccm report init` without an approval prompt).
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

npm run test:e2e:build   # once: image with a pinned Claude Code CLI
npm run test:e2e         # runs the real claude CLI with the cccm plugin in Docker
```

- Tests sit next to the source (`src/**/*.test.ts`) and run with Node's type stripping.
- Collaborators that cross a process or network boundary (`gh`, `claude`, `script`, the clock) are injected through `deps`; everything else runs for real.
- Integration tests point `gh` at the GitHub emulator of [emulate](https://github.com/vercel-labs/emulate) with `GH_HOST=github.localhost`, `HTTP_PROXY=http://127.0.0.1:<port>` and the token from the seed. The repository-wide comment list and ETags are not supported by the emulator, so they are covered by unit tests with a fake command runner.

- The e2e test (`src/e2e/`) runs the real `claude` CLI in Docker with the plugin installed from this repository, `CLAUDE_CODE_REMOTE=true` set to imitate a cloud session, and [aimock](https://github.com/CopilotKit/aimock) answering as the model from a script: `init` → a turn that ends without a report → the reminder → `pending` → `done`. Task hooks are not part of it, because the `TaskCreate` tool is not available to the CLI in that setup; they are covered by the integration tests and the cloud check above.

### Releasing

Releases are published to npm from GitHub Actions with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (`.github/workflows/publish.yml`), so no npm token is stored in the repository. Bump `version` in `package.json`, commit, and push a tag that matches it:

```bash
npm version patch   # updates package.json and creates the tag v<version>
git push origin main --follow-tags
```

The workflow fails if the tag does not match `package.json`. Provenance is attached automatically because the repository is public.

See [docs/design.html](docs/design.html) for the design.

## License

MIT
