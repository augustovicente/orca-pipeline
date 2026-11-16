# Pipeline for Orca

Staged workflows for coding agents, inside [Orca](https://github.com/stablyai/orca): plan, build,
test and review chained in **one agent session**, so each stage sees everything the stages before
it did.

![The Pipeline panel in Orca's sidebar](assets/panel.png)

Orca already runs one prompt at a time. This plugin adds the pipeline around it — a fixed order of
stages, each with its own prompt, driven by the agent's own completion signal.

```
 Plan ──▶ Build ──▶ Test ──▶ Review
   │        │        │        │
   └────────┴────────┴────────┴──▶ same terminal, same conversation
```

It is inspired by [Worca](https://worca.dev), which runs a deterministic plan → implement → review
pipeline on top of Claude Code as its own engine. This takes the same idea and makes it native to
Orca: no second runtime, no npm package, and the work lands in your worktree, your terminals and
your review flow.

## Flows

| Pipeline | Stages | What it is for |
| --- | --- | --- |
| **Feature** | plan → build → test → review | A change from scratch: plan first, keep the diff small, verify it, then review your own work as a strict reviewer. |
| **QA (e2e)** | scope → cases → environment → run → report | End-to-end QA of a feature or branch: bring the app up, click through the journeys in Orca's embedded browser, and end with a pass/fail table and a verdict. |
| **QA · UX/UI (designer)** | scope → criteria → environment → walkthrough → findings → report | A senior product designer's review of the built interface: hierarchy, spacing, type, contrast to WCAG AA, focus and tab order, empty/loading/error states, at 360/768/1440 px and in both themes — measured with `orca eval`, not eyeballed. |
| **QA · Functionality (QA engineer)** | scope → risk → cases → environment → run → report | A risk-based functional pass: risk matrix, boundary and negative cases, roles and permissions, state transitions, idempotency, console and network errors — defects graded S1–S4 with exact steps. |
| **QA · Product value (PM)** | scope → journey → environment → value audit → report | A commercial review: walk first impression → activation → aha → return → paywall, measure steps and time to each milestone, and judge what the product promises against what a new user gets, ranked by impact on the metric. |
| **Bug fix** | reproduce → fix → prove | Root cause before code: reproduce it, fix the cause, prove the fix holds. |

The three QA reviews share a shape — scope, then prepare, then a real end-to-end walkthrough, then
a report file — and differ in the lens: `ux-review.md`, `qa-report.md` and `product-review.md`.

Every flow is just prompts — edit them in the panel, or add your own.

## From a prompt or a phone

Orca Mobile has no plugin panels, so the panel is desktop-only. The same flows therefore also ship
as an agent skill, which any prompt can start — including a phone **Quick Command**:

```sh
mkdir -p ~/.agents/skills/orca-pipeline
cp skills/orca-pipeline/SKILL.md ~/.agents/skills/orca-pipeline/SKILL.md
```

Orca's agents pick the skill up on their next session. Then, from anywhere:

- **Desktop or chat** — *"Use the orca-pipeline skill: run e2e QA on this worktree."*
- **Phone** — Settings → Quick Commands → **Agent Prompt**, with the same sentence. The agent runs
  scope → cases → environment → run → report on the paired desktop, marks each stage, and writes
  `qa-report.md`, so the phone gets a notification and a file to read instead of a terminal to
  babysit.
- **A scheduled run** — *"Start the QA automation for this repo"*, or `orca automations run <id>`.

The skill drives the stages itself, so it has no stage table and no *Carry on* button; the panel
keeps the gates. Use the panel when you want to intervene between stages, the skill when all you
have is a prompt.

## What it does

- **Runs a pipeline in a workspace.** Pick a worktree or folder, pick a pipeline, describe the
  task, press Run. The first stage launches the agent; every later stage types its prompt into the
  same terminal, so the agent keeps its context.
- **Moves on when a stage is done.** The plugin listens for `agent.status.changed`: when the agent
  finishes its turn, the next stage starts. No polling, no waiting on the person.
- **Runs several at once.** Up to five runs in parallel by default — each with its own agent
  terminal, its own stage list and its own controls. One run waiting on you never stalls another;
  set the ceiling under Settings → Pipeline → *Runs at a time* (1 = strictly sequential, up to 8).
  The default is five because each run is a real agent process with its own terminal: five overlaps
  several reviews without turning one machine into an office, and it is a setting, not a rule.
- **Stops when you are needed.** A blocked agent pauses the run and notifies you. Press *Carry on*
  after you answer it in the terminal; *Retry stage* and *Skip stage* are there when a stage goes
  wrong.
- **Shows where you are.** Every stage is a clickable row: press one to read that run's terminal,
  live while the stage runs, with the tail kept from when it finished. The status bar shows how many
  runs are alive and how many need you.
- **Edits pipelines in the panel.** Name, agent and stages per pipeline; `{{task}}` in a prompt is
  replaced by the task you typed.

Those six ship on first run and are yours to edit. A pipeline you delete stays deleted; a new
default added by a later version is appended once, without touching the ones you changed.

The **QA (e2e)** flow assumes the agent can drive the app the way a person does: it opens Orca's
embedded browser (`orca tab create`, `snapshot`, `click`, `fill`), reads what is on screen, and
closes its tabs at the end. That is what makes the report evidence rather than opinion.

New pipelines, and the seeded ones, start with **your** agent rather than a hardcoded one: the
`defaultAgent` setting when you set it, otherwise the agent running in your focused workspace, and
claude only as a last resort.

### One worktree at a time can receive prompts

Orca lets a plugin type only into the terminal of the **worktree the app has active**: `terminal.sendText`
resolves the active worktree on every call and refuses anything else (`terminal is outside the active
worktree`). Reading output has no such rule.

So a pipeline can start in any workspace, but only the active one can be driven. The plugin therefore
refuses to start a run in a workspace Orca is not showing, and a run that loses the active worktree
**pauses** with "Open <workspace> in Orca so the pipeline may type into its agent" — press *Carry on*
once it is back in front, and the prompt is sent again. Parallel runs work because they share that
worktree.

## Requirements

- Orca `>= 1.4.248` (components panels, status bar items).
- One of the agents Orca can launch, installed on the machine that runs Orca. The picker lists only
  the ones it finds on `PATH` (plus the usual Homebrew, `~/.local/bin` and version-manager
  directories); anything else can still be typed in.

## Install

From the plugin folder:

```sh
orca plugin install /path/to/orca-pipeline
```

From GitHub, once published:

```sh
orca plugin install <owner>/orca-pipeline
```

Orca asks you to approve what it grants before anything runs. For development, load the folder
instead:

```sh
orca plugin dev watch .   # loads it, streams logs and reloads; Ctrl-C unloads
```

## Permissions

The plugin is a trusted worker: it runs in its own Node process with your account's access. It
asks for exactly what a pipeline needs — `workspace:read`, `agent:read`, `agent:launch`,
`terminal:send`, `terminal:read`, `notifications:show`, `storage:own`, `settings:own` — and
nothing else. It has no network access of its own and keeps its data in Orca's plugin storage.

## Settings and reasoning levels

Everything lives under Settings → Pipeline:

| Setting | Default | What it does |
| --- | --- | --- |
| **High / Medium / Low reasoning — agent** | `opencode` | The agent a stage runs on when it asks for that level and nothing else names one. |
| **High reasoning — model** | `opencode-go/deepseek-v4.1-flash` | Model for `high` stages. |
| **Medium reasoning — model** | `opencode/mimo-v2.6-flash-free` | Model for `medium` stages. |
| **Low reasoning — model** | `opencode-go/beam-free` | Model for `low` stages. |
| **Default agent** | *(empty)* | Agent for pipelines that name none: this, else the agent running in your focused workspace, else the first installed, else `claude`. |
| **Runs at a time** | `5` | Parallel runs (1–8). Each one is its own agent process. |
| **Stage timeout** | `20` min | A stage with no completion signal fails after this. |
| **Model boot wait** | `8` s | How long a modeled agent gets to come up before its prompt is typed. Raise it for a slow CLI. |
| **Desktop notifications** | on | Notify on finish, failure, or when a stage needs you. |

Model ids are the provider-qualified ones your agent uses — `opencode models` prints them
(`opencode-go/…`, `opencode/…`, `openrouter/…`).

### How a stage picks its agent and model

A pipeline sets a default level for its stages, a stage can set its own, and an explicit agent or
model always wins over a level:

| | Wins over | Falls back to |
| --- | --- | --- |
| **Agent** | stage *Agent override* | pipeline agent → level agent → *Default agent* |
| **Model** | stage *Model* | the level's model (`stage.reasoning` → `pipeline.reasoning`) → the agent's own default |

A stage whose model comes from a level (or an explicit *Model*) runs its **own** agent process,
because Orca's `agent.launch` cannot take a model. Consecutive stages that resolve to the **same**
model reuse that process, so a pipeline whose stages all sit on one level keeps one session; a level
change starts a new one. When a model spends its *Tries per model*, the next entry in *Fallback
models* starts, and the stage fails only when the chain is spent — naming the models it tried.

The shipped flows carry levels already: plan/risk/audit-style stages are `high`, the working stages
`medium`, environment and cheap verification `low`. A stage that names neither a model nor a level takes its shipped level on every load,
so an older install picks them up without touching anything you set yourself.

## Inspired by Worca

[Worca](https://worca.dev) is a deterministic multi-agent pipeline for AI coding agents: you
describe the work, it plans, implements and reviews, and you end up with a reviewed pull request.
The idea is worth copying, and the shape of it — an ordered set of stages, each one ending in
something you can check — is what this plugin implements.

What differs is where it runs:

| | Worca | Pipeline (this plugin) |
| --- | --- | --- |
| Engine | its own app: web UI, CLI and a Claude Code skill (`npm i -g @worca/app`) | Orca itself: `agent.launch`, `terminal.sendText`, `agent.status.changed` |
| Agent | Claude Code, Copilot or a local model | whichever agent you already launch in Orca |
| Pipeline | fixed stages, chosen by Worca | prompts you can read and edit in the panel |
| Version control | its own worktrees and PR flow | the worktree you picked, your Source Control panel |

If you want Worca itself, run it — it works fine in an Orca terminal. This is for when you want the
pipeline without the second runtime.

## How it works

- `src/worker.ts` owns the run state machines, one per run. A stage starts (`agent.launch` for the
  first one, `terminal.sendText` after that), and `agent.status.changed` for *that* terminal ends
  it — so overlapping runs cannot advance each other. Runs live in `orca.storage`, so a worker
  reload does not lose them; a run interrupted by a restart comes back paused. Stages carry their
  own timeout (default 20 min) so a silent agent fails its stage instead of holding a slot.
- `src/panel.tsx` is a components panel: it renders Orca's own controls and talks to the worker
  through `plugin.request` / `orca.panels.post`.
- `src/protocol.ts` declares both directions once, so panel and worker are typed end to end.
- `src/agent-choices.ts` maps each agent to the CLI Orca detects it by, so the picker offers only
  what is installed; `src/agent-detect.ts` does the scan.

## Development

```sh
orca plugin validate .      # manifest and layout
orca plugin check .         # renders each panel scenario with the worker
orca plugin test .          # runs the tests in Node
npx tsc -p .                # type-checks against Orca's typings
```

There is no build step: Orca transpiles the `.ts`/`.tsx` sources when it loads them.

## License

MIT
