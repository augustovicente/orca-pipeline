// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// It also carries the plain data both sides pass around, so neither has to redeclare it.
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped'
export type RunStatus = 'running' | 'blocked' | 'failed' | 'done' | 'stopped'

/** One step of a pipeline: a name and the prompt sent to the agent for it. */
export type Stage = { id: string; name: string; prompt: string }

/** A staged workflow: an ordered list of prompts run in one agent session. */
export type Pipeline = { id: string; name: string; agent: string; stages: Stage[] }

/** How one stage of one run went. */
export type StageState = {
  stageId: string
  status: StageStatus
  startedAt: number | null
  endedAt: number | null
  note: string | null
  /** The tail of the terminal when the stage finished, for a quick look. */
  tail: string | null
}

/** One pass of a pipeline over a workspace. Runs are independent: own terminal, own agent. */
export type Run = {
  id: string
  pipelineId: string
  pipelineName: string
  workspaceId: string
  workspaceName: string
  agent: string
  task: string
  terminalId: string | null
  stageIndex: number
  status: RunStatus
  stages: StageState[]
  startedAt: number
  endedAt: number | null
}

/** A workspace the pipeline can run in, as `workspace.list` reports it. */
export type Workspace = {
  id: string
  name: string
  path: string
  branch: string | null
  kind: 'worktree' | 'folder'
  project: string | null
}

declare module 'orca' {
  interface PluginRequests {
    /** Every pipeline this plugin knows, defaults included. */
    'pipelines.list': { output: { pipelines: Pipeline[] } }
    /** Creates or replaces one pipeline and answers the whole list. */
    'pipelines.save': { input: { pipeline: Pipeline }; output: { pipelines: Pipeline[] } }
    /** Removes a pipeline by id and answers the whole list. */
    'pipelines.remove': { input: { id: string }; output: { pipelines: Pipeline[] } }
    /** Every workspace Orca knows on this host. */
    'workspaces.list': { output: { workspaces: Workspace[] } }
    /** Every run, newest first, plus what the panel needs to start another. */
    'run.state': {
      output: {
        runs: Run[]
        pipelines: Pipeline[]
        defaultAgent: string
        availableAgents: string[]
        maxParallelRuns: number
      }
    }
    /** Starts a pipeline in a workspace; the first stage launches its own agent. */
    'run.start': {
      input: { pipelineId: string; workspaceId: string; task: string }
      output: { run: Run }
    }
    /** Stops one run; its agent keeps the terminal, and the run stays in the list. */
    'run.stop': { input: { runId: string }; output: { runs: Run[] } }
    /** Carries on with one run after its agent was blocked. */
    'run.resume': { input: { runId: string }; output: { runs: Run[] } }
    /** Sends one run's current stage prompt again. */
    'run.retry': { input: { runId: string }; output: { runs: Run[] } }
    /** Marks one run's current stage skipped and moves it on. */
    'run.skip': { input: { runId: string }; output: { runs: Run[] } }
    /** Drops a finished run from the list. */
    'run.remove': { input: { runId: string }; output: { runs: Run[] } }
  }
  interface PluginPanelEvents {
    /** The run list changed, from this or another panel. */
    'runs.changed': { runs: Run[] }
    /** The pipeline list changed, from this or another panel. */
    'pipelines.changed': { pipelines: Pipeline[] }
  }
}
