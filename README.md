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

## What it does

- **Runs a pipeline in a workspace.** Pick a worktree or folder, pick a pipeline, describe the
  task, press Run. The first stage launches the agent; every later stage types its prompt into the
  same terminal, so the agent keeps its context.
- **Moves on when a stage is done.** The plugin listens for `agent.status.changed`: when the agent
  finishes its turn, the next stage starts. No polling, no waiting on the person.
- **Stops when you are needed.** A blocked agent pauses the run and notifies you. Press *Carry on*
  after you answer it in the terminal; *Retry stage* and *Skip stage* are there when a stage goes
  wrong.
- **Shows where you are.** Stage table with live timings, the tail of the terminal when a stage
  ends, and a status bar item with `2/4 · running`.
- **Edits pipelines in the panel.** Name, agent and stages per pipeline; `{{task}}` in a prompt is
  replaced by the task you typed.

Two pipelines ship with it: a feature cycle (plan → build → test → review) and a bug fix cycle
(reproduce → fix → prove). Both are plain prompts — edit them.

## Requirements

- Orca `>= 1.4.248` (components panels, status bar items).
- One of the agents Orca can launch (`claude`, `codex`, `cursor`, `grok`, `omp`, `pi`).

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

## How it works

- `src/worker.ts` owns the run state machine. A stage starts (`agent.launch` for the first one,
  `terminal.sendText` after that), and `agent.status.changed` for that terminal ends it. The run
  lives in `orca.storage`, so a worker reload does not lose it — a run interrupted by a restart
  comes back paused.
- `src/panel.tsx` is a components panel: it renders Orca's own controls and talks to the worker
  through `plugin.request` / `orca.panels.post`.
- `src/protocol.ts` declares both directions once, so panel and worker are typed end to end.

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
