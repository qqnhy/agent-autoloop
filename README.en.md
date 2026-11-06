# Agent Autoloop

**Let your command-line agents pick up work and follow it through in the background — staying quiet when they can handle it, and sending you a card only when a decision is yours to make.**

[中文](README.md) | **English**

[Get started](#get-started) · [Recipes](#ready-to-use-recipes) · [Plugins](#plugin-ecosystem-swap-any-of-the-four-sides) · [Kernel](#four-kernel-mechanisms) · [Docs](#documentation)

![Architecture](docs/architecture.en.svg)

## What problem does it solve?

Most of us use command-line agents like Claude Code or Codex by babysitting a terminal: you type a prompt, watch it run, and answer its questions. Close the window or walk away, and the work stops.

**Agent Autoloop** turns your command-line agents into a background loop. At the center is a deterministic **kernel** with zero runtime dependencies. Around it, event sources, agents, notification channels, and even CI/CD delivery pipelines are all swappable **plugins**.

- **One machine, one install command.** Runs on your Mac or Linux machine. No cloud server or inbound ports required.
- **Connect a new agent in one line.** No SDK, no agent source code to fork. Any CLI tool that takes a prompt and prints a final reply can plug in.
- **The hub stays headless.** Cards reach you on Feishu, DingTalk, WeCom, Slack, Discord, or desktop notifications when you are needed. Everything else is one command away.
- **Local workbench in this fork.** Inspect runs and pending questions, answer cards, and start task conversations using a locally configured agent and project directory. Send requests, read final replies, and continue the discussion. This separate HTTP client does not change the hub protocol. Final replies require this fork’s updated local worker; output is not streamed. See [setup and security boundaries](clients/workbench/README.md). The interface is Chinese.

## Get started

Works on macOS and Linux. You need Node 24, Git, curl, and at least one command-line agent already signed in; no GitHub account required. You can also hand the [installation guide](INSTALL.md) to your agent and let it install everything for you.

> **Windows: use WSL2 for now.** Native Windows is not supported yet. Run the Linux setup inside WSL2; see [INSTALL](INSTALL.md) for service and notification limitations and [#17](https://github.com/KKKKhazix/agent-autoloop/issues/17) for native compatibility progress.

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

The installer and `agent-autoloop update` both install the newest [release](https://github.com/KKKKhazix/agent-autoloop/releases), which has passed every check.

Then run a real loop with your own agent — ask, exit while it waits, make the call, resume:

```bash
agent-autoloop try
```

> CLI output and default notification strings are still Chinese until they are translated. Sample CLI output in this README is that same text written in English.

Here is the output from Codex in a non-interactive terminal, written in English:

```text
Event sent. The agent is getting to work...

The agent finished this round and asked you a question. No process is running for it now, and it is not spending tokens.

[Your call] #1 Try run: pick a color
This is a try run. Either choice is fine.
  1. Blue
  2. Green
Answer: agent-autoloop answer 1 <number>
After you answer, run agent-autoloop status to see it pick the work back up and finish.
```

In an interactive terminal, just type the option number. In a non-interactive terminal, run `agent-autoloop answer 1 2` to pick green. Then `agent-autoloop status` shows that the agent resumed its conversation and finished, along with rounds, tokens, and cost for today and the past seven days ([how they are counted](skills/agent-autoloop/SKILL.md#看情况回答)).

## Start task chat from this fork

You need Node.js 24+, this fork’s source checkout, a signed-in CLI agent, and initialized local hub configuration with owner/source credentials, a hub, and a worker. For a fresh setup, run the following from the source root. The example uses an isolated data directory and Codex; use `--agent claude` if that is your installed agent. Do not run `init` again against an existing configuration.

```sh
# Terminal 1: use the same AGENT_AUTOLOOP_HOME for every command.
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-workbench"
node bin/agent-autoloop.ts init --agent codex --no-service
# Replace the path with an existing absolute project directory.
npm run workbench:chat -- --name "项目对话" --agent codex --cwd /absolute/path/to/project
node bin/agent-autoloop.ts check
node bin/agent-autoloop.ts up
```

```sh
# Terminal 2: same source checkout and data directory.
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-workbench"
npm run workbench
```

Open `http://127.0.0.1:4318`, choose the configured rule under “任务对话”, and click “新建对话”. For an existing setup, skip `init` and use `npm run workbench:chat -- --name "项目对话" --agent EXISTING_ID --cwd EXISTING_PATH`, substituting a registered agent ID and an existing absolute directory. The setup command backs up and adds a fixed rule with `resume: true` and `parallel: 1`, without changing agent commands or permissions. It rejects conflicting routes and existing rule names. Restart the worker and workbench afterward; stop existing instances before starting this source version against the same data directory. See [the full startup guide](clients/workbench/README.md#启动).

Conversations and replies already read are saved locally across workbench restarts. Full final replies come from the updated worker on the same machine and data directory, not raw terminal logs; old or remote workers show an explicitly labeled summary instead. Output is not streamed and may be marked truncated. Supported agents resume using their actual session IDs, but permanent model context is not guaranteed. Ask cards still require an explicit answer; typing “yes” in chat does not answer a card or approve a version of a Spec or Plan. This client does not add workflow-stage orchestration, merge or deploy controls, or an extra agent sandbox.

The upstream installer and update commands above do not include this fork’s workbench or reply-saving worker changes.

## How a piece of work flows

The numbers match the diagram above:

1. **An event comes in.** A 9:00 AM schedule, a new GitHub issue, or a production alert becomes a standard event sent to the kernel.
2. **Dispatched by your rules.** Your rules decide which agent handles it and in which folder. New events for the same subject while it is queued merge into one round.
3. **Work one round and exit.** The agent puts its result in its final message, and the process exits.
4. **Asks only when needed.** For sensitive actions like deleting data, restarting a service, spending money, or messaging people, the kernel sends you a card through Feishu or a desktop notification. While you take your time, no agent process runs and no tokens are spent.
5. **One tap resumes it.** Your answer picks up the original conversation and finishes the job.

Anything the agent can handle alone takes the auto-loop at the top of the diagram: finish outright, or schedule a follow-up check (say, in 30 minutes) without bothering you.

## Day-to-day usage

### Write your rules (`rules.json`)

No glue code needed. Open `~/.agent-autoloop/rules.json` and, under `rules`, declare **what happened, who handles it, and where they work**. Set `to` to a name already under `agents`. For example, write a brief every morning at 9:

```json
{
  "name": "Morning brief",
  "when": { "cron": "0 9 * * *" },
  "to": "codex",
  "cwd": "~/notes",
  "prompt": "Summarize yesterday's notes and commits into today's brief."
}
```

External events work the same way once the source is connected. To hand new GitHub issues to Codex, first register `github` under `sources` ([guide](skills/agent-autoloop/SKILL.md#接一个事件插件)):

```json
{
  "name": "Handle issues",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

Changes take effect within seconds of saving. Run `agent-autoloop check` to validate, `agent-autoloop rules explain` to see the rules in effect and their next runs, and `agent-autoloop emit <type> --dry-run` to preview who an event would go to (it doesn't contact the hub or write to the log). If you make a mistake, or the file is deleted or can't be read, the hub keeps running the previous valid rules and sends you a card about it.

### How agents talk back to the hub

The hub asks only one thing of an agent: **put your result in your final message**. When the job is done, a one-line conclusion is enough. To ask you something, the agent appends an `agent-autoloop` block:

````text
Order checked. We have enough stock in the warehouse.

```agent-autoloop
{
  "ask": [{
    "title": "How should we ship it?",
    "text": "Both options can go out today.",
    "options": ["Courier", "Pickup"],
    "key": "shipping"
  }]
}
```
````

Besides `ask`, receipts can send notifications (`notice`), resolve open cards (`resolve`), schedule follow-up checks (`later`), and emit new events (`events`). A notice asks for nothing, but you can add a line of your own when you settle one, and it stays on the card; one marked `fyi` is only there to tell you, and has no button. If the JSON is invalid, the hub has the agent rewrite just that final message in the same session, without repeating completed work. If rewriting also fails, it keeps the original conclusion and tells you the receipt was not applied (a plain command has no session, so it goes straight to this). Going on in an old session works the same way: a new session starts only when the old one can't be continued. If it was continued and then broke partway, the run counts as failed and is retried in that session a few minutes later, not redone in a new one. A new event on the same thread starts a new session by default; with `"resume": true` in the rule it goes on in the last round's session.

## Ready-to-use recipes

Each recipe includes rules, a task Skill, and setup instructions (written in Chinese).

| Task | Included workflow |
|---|---|
| [Morning brief](examples/recipes/morning-brief/README.md) | Summarize local notes and Git commits at 8 AM by default; write `briefs/YYYY-MM-DD.md` |
| [GitHub issues](examples/recipes/github-issues/README.md) | Poll every five minutes, edit code locally, and notify you to review; no commits, pushes, or issue replies |
| [Production alerts](examples/recipes/ops-alerts/README.md) | Receive an error, investigate local code, ask before restarting, and continue after your answer |
| [User feedback](examples/recipes/feedback/README.md) | Re-read current feedback, fix, deliver and verify, then prepare a reply; ask you in Feishu and resume after your answer |
| [Website watch](examples/recipes/website-watch/README.md) | Check status and expected content every five minutes; wake the agent on a new incident, keep ongoing failures quiet, and update the card on recovery |
| [Feishu weekly and business brief](examples/recipes/feishu-brief/README.md) | Read selected reports and tables with your permissions at 6 PM Sunday; summarize locally and send only a short summary to Feishu |
| [PR delivery](skills/agent-autoloop/SKILL.md#交付流水线) | Add `deliver` to a PR to review it, wait for CI, merge, wait for deployment, and verify the live version |

**To enable one:** open its instructions, put the task Skill in your agent's skills directory, merge the sample rules into `~/.agent-autoloop/rules.json`, replace worker names and paths, then run `agent-autoloop check`.

Feedback, website watch, and Feishu briefs default to Asia/Shanghai and send only to the owner's private Feishu chat. Sample data is fictional; scripts and receipts have been verified only with local HTTP and a fake Feishu CLI, not run end to end on a live account.

More: [Claude-to-Codex browser handoff](examples/recipes/browser-handoff/README.md), [weekly code cleanup](examples/skills/weekly-sweep/SKILL.md), [ship a PR](examples/skills/ship-pr/SKILL.md).

## Plugin ecosystem: swap any of the four sides

Built-in plugins ship with the program and are enabled through configuration. Use `agent-autoloop add <git URL>` for third-party plugins.

| Side | Built in | Setup |
|---|---|---|
| **Events**: how work is found | [GitHub Webhook](plugins/github/source.ts), [GitLab Webhook](plugins/gitlab/source.ts), [HTTP API](docs/protocol.md#来源把世界变成事件), [cron rules](skills/agent-autoloop/SKILL.md#改规则), [issue polling script](examples/watch-github-issues.sh) | [Guide](skills/agent-autoloop/SKILL.md#接一个事件插件) |
| **Agents**: who does the work | [Claude Code](plugins/claude/agent.ts), [Codex](plugins/codex/agent.ts), [ACP](plugins/acp/agent.ts), [DeepSeek Harness](plugins/dsh/agent.ts), [generic command](plugins/command/agent.ts) | [Guide](skills/agent-autoloop/SKILL.md#接一个-agent) |
| **Channels**: how cards reach you | [Desktop notifications](plugins/desktop/channel.ts) (on by default), [Feishu](plugins/feishu/channel.ts), [DingTalk / WeCom / Slack / Discord](plugins/webhook/templates.ts) | [Guide](skills/agent-autoloop/SKILL.md#接一个通道) |
| **Delivery**: CI/CD as a plugin | [`delivery`](plugins/delivery/delivery.ts) | [Guide](skills/agent-autoloop/SKILL.md#交付流水线) |

**What has been tested:** Claude Code, Codex, and ACP (with the official Codex ACP adapter) have run multi-turn Q&A and session resumption across processes. Feishu has run real delivery, button callbacks, and card updates. The four webhook templates have only been checked against local mock servers, and the GitLab webhook against the payloads in its docs, not a real GitLab. These text channels answer through a link, so `hub.publicUrl` must be reachable from your phone or computer.

**Other CLI agents connect in one line.** Set `use: "command"` and pass a command array; `{prompt}` is a single argument, never evaluated as shell code. These commands come from each tool's official docs, and we have not run each of them yet:

| Agent | Command |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) older versions (the built-in plugin needs 0.2.2 or newer) | `dsh --profile headless {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -Q -q {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |

**Delivery pipeline.** Add the `deliver` label to a GitHub PR and it follows through to release: **review → wait for CI → merge → wait for deploy → verify the live version**. Settings are read only from `main`, and PR code is never checked out or run on the worker machine. Queueing, concurrency, and retries come from the kernel.

**Write your own.** Start from the runnable [agent](examples/plugins/hello-agent/agent.ts), [channel](examples/plugins/hello-channel/channel.ts), and [event](examples/plugins/hello-source/source.ts) templates and the [plugin guide](docs/plugins.md). For web tasks, read [browser access](docs/plugins.md#浏览器接入) first. The CLI and [MCP](skills/agent-autoloop/SKILL.md#mcp-与密钥撤销) can also inspect and answer cards.

## Four kernel mechanisms

The kernel is about 1,650 lines with zero runtime dependencies. It reads no clock, uses no randomness, and makes no outbound requests; plugins connect in, and credentials stay with the plugins that use them. Identical inputs always give identical results. It brings four proven systems patterns to command-line agents:

- **Zero-cost wait**: The process exits while waiting for your call, and the waiting state lives in SQLite, so the agent does not stay alive. If you reply three days later, no agent process runs and no tokens are spent in the meantime — only the lightweight hub waits in the background; your answer resumes the original conversation.
- **Event sourcing**: All state is derived from an append-only fact log, committed in the same SQLite transaction as its indexes before the hub replies. Confirmed facts survive `SIGKILL` (whole-machine power loss is not separately tested), every run can be traced with a single command, and format changes rebuild from the log without migration scripts.
- **Code / data split**: Like parameterized SQL. Issue titles, bodies, and other external text are written only to a local data file, never into the prompt, which carries only character-checked types, IDs, and links; `rules.json` alone decides which agent runs, in which folder, and with what access. Events carrying `cwd`, `agent`, or `access` fields are rejected outright.
- **Hop circuit breaker**: Like packet TTL in networking. Events returned by an agent can dispatch more agents, and the hop count keeps growing — across human questions and scheduled follow-ups too — and an agent cannot reset it. Past 8 hops, the kernel records the event, stops dispatching, and sends you a notice card.

### Check it yourself

Run these from `~/.agent-autoloop/app`:

| What it checks | Command |
|---|---|
| The full story of any round | `agent-autoloop why 1` |
| 200,000 simulated steps of network loss, dropped packets, crashes, and duplicate requests, reproducible from one seed | `node sim/random.ts 24301 200000` |
| 1,000 process kills with no acknowledged record lost | `node sim/crash.ts 1000 12648430` |
| The benchmarks below | `npm run benchmark` |

```text
Round 1 · Demo
11-03 20:47:25  Rules version #1
11-03 20:47:25  Triggering event: source local · type demo.start · subject example
11-03 20:47:25  local picked it up (demo program)
11-03 20:47:25  Finished: demo complete
```

### Benchmarks

Apple M5 Pro, 24 GB, Node 24.21.0. Each write is a separate request, acknowledged only after its transaction is durable.

| Metric | Measured |
|---|---:|
| Cold start | 88.78 ms |
| Idle memory | 59.94 MB RSS |
| 1,000 concurrent waiting polls | 170.49 MB RSS |
| Durable writes | 2,394 events/s |
| Dispatch p99 | 1.82 ms |
| Held-back heartbeat p99 with 5,000 queued | 1.66 ms |
| Startup at 1.1 million facts | 99.8 ms |
| Kernel lines (with comments and blanks) | about 1,650 |
| Runtime dependencies | 0 |

As history grows, the status summary slows down and the log and indexes keep using disk. The first start after a format change rebuilds from the log, which took 43.1 seconds for 1.1 million facts. [Full numbers and method](docs/protocol.md#历史增长实测) (in Chinese).

## Usage and provider terms

The hub invokes command-line tools you have already installed and signed into on your machine; it never reads or exports their credentials. Model usage is billed to your own account under each provider's terms.

For automated workloads, providers generally recommend using API keys rather than personal subscription quotas (which are designed around interactive personal use — see [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) and [OpenAI](https://learn.chatgpt.com/docs/auth)). Use API keys if you are running services for others. This project is independent and is not affiliated with or endorsed by those providers.

## Documentation

- [Installation guide](INSTALL.md)
- [Configuration & delivery pipeline manual](skills/agent-autoloop/SKILL.md)
- [Writing plugins](docs/plugins.md)
- [Full HTTP protocol specification](docs/protocol.md)
- [Security boundaries](SECURITY.md)
- [Contributing and community](CONTRIBUTING.md)
- [Development guidelines](AGENTS.md)

<details>
<summary><strong>Repository layout</strong></summary>

| Location | Contents |
|---|---|
| `kernel/` | Decisions, fact log, projections, deadlines, rule matching, endpoint behavior, and card forms |
| `host/` | Node HTTP, files and SQLite connections, clock, configuration, status summary, background services, and plugin loading |
| `protocol/` | Wire formats, JSON Schema, input validation, HTTP client, and conformance checks |
| `worker/` | Claim work, run agents, handle heartbeats and cancellation, read and submit receipts |
| `cli/`, `bin/` | User commands and entry point: status, answers, `why`, MCP, updates, and uninstall |
| `plugins/` | Built-in agent, event, channel, and delivery plugins |
| `examples/recipes/` | Complete recipes with rules, a task Skill, and setup instructions |
| `examples/plugins/`, `examples/skills/`, `examples/*.sh` | Minimal plugin templates, standalone task guides, and Shell examples |
| `skills/agent-autoloop/` | The hub's configuration and operation manual, also made available to agents during installation |
| `docs/` | Protocol, plugin guide, and Chinese / English architecture diagrams |
| `tests/`, `sim/` | Everyday behavior tests, simulation, enumeration, crash tests, and mutation checks |
| `scripts/`, `.github/workflows/` | Performance and real-agent checks, installation smoke scripts, and Linux / macOS CI |
| Root documents and `install.sh` | Chinese / English READMEs, installation, security, development guidelines, license, and installer |

Start reading at `bin/agent-autoloop.ts` → `cli/main.ts`, then follow the feature into `host/`, `worker/`, or `plugins/`. Read the [protocol](docs/protocol.md) for kernel design. Similarly named files serve different layers: `host/http.ts` adapts Node requests while `kernel/http.ts` defines endpoint behavior; `protocol/rules.ts` validates input while `kernel/rules.ts` defines rule types and matching.

</details>

[MIT License](LICENSE)
