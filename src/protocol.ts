// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// It also carries the plain data both sides pass around, so neither has to redeclare it.
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped'
export type RunStatus = 'running' | 'blocked' | 'failed' | 'done' | 'stopped'

/** How much reasoning a stage is worth, mapped to an agent and model in Settings. */
export type Reasoning = 'high' | 'medium' | 'low'

/** One step of a pipeline: a name and the prompt sent to the agent for it. */
export type Stage = {
  id: string
  name: string
  prompt: string
  /** Reasoning level this stage needs; resolves to the agent and model set for it in Settings. */
  reasoning?: Reasoning
  /** Agent for this stage, overriding the pipeline's. */
  agent?: string
  /** Model for this stage. Set, the stage runs its own agent process with it. */
  model?: string
  /** Models to try, in order, after `model` gives up. */
  fallbacks?: string[]
  /** Tries per model before moving to the next one. Default 2. */
  attempts?: number
}

/** A staged workflow: an ordered list of prompts run in one agent session. */
export type Pipeline = {
  id: string
  name: string
  agent: string
  /** Default reasoning level for this pipeline's stages, when a stage names none. */
  reasoning?: Reasoning
  stages: Stage[]
  /** Orca project this pipeline belongs to; absent or null means every workspace. */
  projectId?: string | null
  /** The project's name when it was saved, so the panel can label a scope it cannot resolve. */
  projectName?: string | null
}

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
  /** The agent session behind that terminal, when Orca reported it; resuming it opens a new tab. */
  sessionId: string | null
  /** The model the current stage is running with, when it models one. */
  model: string | null
  /** Position in the stage's model chain; advances only when a model gives up. */
  modelIndex: number
  /** Tries already spent on this stage's current model. */
  attempt: number
  /** Models this stage has already used, in order, for the report. */
  triedModels: string[]
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
  /** Id `project.list` gives the project, when Orca reports one. */
  projectId: string | null
}

/** A repository or folder Orca knows, for scoping a pipeline to it. */
export type Project = {
  id: string
  name: string
  path: string
  hostId: string | null
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
        /** Projects a pipeline may be scoped to, from `project.list` or the workspace list. */
        projects: Project[]
        defaultAgent: string
        availableAgents: string[]
        maxParallelRuns: number
        levels: Record<Reasoning, { agent: string; model: string }>
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
    /** The live terminal of one run, as text: the fastest way to see what a stage is doing. */
    'run.output': { input: { runId: string; maxLines?: number }; output: { text: string | null } }
    /** Brings one run's terminal to the front in Orca, falling back to resuming its session. */
    'run.open': {
      input: { runId: string }
      output: { opened: 'terminal' | 'session' | 'none' }
    }
    /** Resumes one run's agent session in a new tab of its workspace. */
    'run.openSession': {
      input: { runId: string }
      output: { terminalId: string; started: boolean }
    }
  }
  interface PluginPanelEvents {
    /** The run list changed, from this or another panel. */
    'runs.changed': { runs: Run[] }
    /** The pipeline list changed, from this or another panel. */
    'pipelines.changed': { pipelines: Pipeline[] }
  }
}
