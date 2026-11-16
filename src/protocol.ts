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

/** One pass of a pipeline over a workspace. */
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
    /** The current run, if there is one, plus the pipelines, the agent new ones start with, and
     *  the agents installed on this machine. */
    'run.state': {
      output: {
        run: Run | null
        pipelines: Pipeline[]
        defaultAgent: string
        availableAgents: string[]
      }
    }
    /** Starts a pipeline in a workspace; the first stage launches the agent. */
    'run.start': {
      input: { pipelineId: string; workspaceId: string; task: string }
      output: { run: Run }
    }
    /** Stops the current run; the agent keeps its terminal. */
    'run.stop': { output: { run: Run | null } }
    /** Carries on after the agent was blocked. */
    'run.resume': { output: { run: Run | null } }
    /** Sends the current stage's prompt again. */
    'run.retry': { output: { run: Run | null } }
    /** Marks the current stage skipped and moves on. */
    'run.skip': { output: { run: Run | null } }
  }
  interface PluginPanelEvents {
    /** The run changed; null once there is none. */
    'run.changed': { run: Run | null }
    /** The pipeline list changed, from this or another panel. */
    'pipelines.changed': { pipelines: Pipeline[] }
  }
}
