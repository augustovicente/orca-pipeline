// The plugin's worker: it owns the run state machines. Each run gets its own agent terminal; a
// stage ends its turn in that terminal, the worker hears `agent.status.changed` for it, and the
// next stage's prompt goes into the same terminal, so every stage sees the conversation before it.
//
// Runs are independent and may overlap, so nothing here is global to the plugin except the run
// list, the pipelines and the settings. A save restarts the worker and drops in-memory state, so
// the runs and the pipelines live in orca.storage.
import type { JsonValue } from 'orca/worker'
import type { OrcaWorkerApi } from 'orca/worker'
import { detectInstalledAgents } from './agent-detect'
import { DEFAULT_PIPELINES } from './defaults'
import type { Pipeline, Run, Stage, StageState, Workspace } from './protocol'

const PIPELINES_KEY = 'pipelines'
/** Ids of the seeded pipelines this plugin has already offered, so a deleted seed stays deleted. */
const SEEDED_KEY = 'seeded'
/** Set once the seeded flows have picked up the resolved default agent. */
const AGENT_SEEDS_KEY = 'seedAgentMigrated'
const RUNS_KEY = 'runs'
/** Written by 0.4.x, which kept one run at a time; adopted into `runs` on activation. */
const LEGACY_RUN_KEY = 'run'
const STATUS_BAR_ID = 'run'
/** Finished runs kept for reference; older ones are dropped. */
const KEEP_FINISHED = 12

/** Cached settings: the worker re-reads them when the person changes one. */
let stageTimeoutMinutes = 20
let notify = true
let maxParallelRuns = 5

/** What a new pipeline, and the seeded ones, use. Orca keeps its own default agent in settings
 *  that plugins cannot read, so this is: the `defaultAgent` setting when set, else the agent
 *  running in the focused workspace, else the first installed one, else claude. */
let defaultAgent = 'claude'
/** Agent ids whose CLI is installed here; the picker offers only these. */
let availableAgents: string[] = []

let pipelines: Pipeline[] = []
/** Newest first. */
let runs: Run[] = []
/** Stage timeouts, by run id. */
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** "The agent never came up" watchdogs, by run id; cleared by the first `working`. */
const startups = new Map<string, ReturnType<typeof setTimeout>>()
/** Whether each run's current stage has reported `working`; a stage cannot be done before it starts. */
const sawWorking = new Map<string, boolean>()
/** Runs paused because their worktree was not active: carrying on must re-send, not just wait. */
const scopeBlocked = new Set<string>()

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Orca refuses terminal input outside the worktree the app has active; that is a "do this" not a failure. */
function isScopeError(error: unknown): boolean {
  const text = message(error).toLowerCase()
  return text.includes('outside the active worktree') || text.includes('no active worktree')
}

function scopeNote(run: Run): string {
  return `Open ${run.workspaceName} in Orca so the pipeline may type into its agent, then press Carry on.`
}

/** The workspace the app has focused, when it can be told apart from the others. */
async function activeWorkspace(orca: OrcaWorkerApi): Promise<Workspace | null> {
  try {
    const context = await orca.host.call('workspace.readContext')
    if (!context) return null
    const listed = await orca.host.call('workspace.list')
    const entries = listed?.workspaces ?? []
    const match = entries.filter((entry) => entry.name === context.displayName)
    return match.length === 1
      ? {
          id: match[0]!.id,
          name: match[0]!.name,
          path: match[0]!.path,
          branch: match[0]!.branch,
          kind: match[0]!.kind,
          project: match[0]!.project ?? null
        }
      : null
  } catch {
    return null
  }
}

/** Copies through JSON so a panel never shares a mutable object with the worker. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asJson(value: unknown): JsonValue {
  return plain(value) as JsonValue
}

function runById(id: string): Run | undefined {
  return runs.find((entry) => entry.id === id)
}

function currentStage(run: Run): StageState | undefined {
  return run.stages[run.stageIndex]
}

function pipelineOf(id: string): Pipeline | undefined {
  return pipelines.find((entry) => entry.id === id)
}

/** Replaces `{{task}}` in every stage prompt, and gives the first stage one if it has none. */
function promptFor(stage: Stage, index: number, task: string): string {
  const body = stage.prompt.replaceAll('{{task}}', task.trim())
  if (index > 0 || stage.prompt.includes('{{task}}')) return body
  return task.trim() ? `Task: ${task.trim()}\n\n${body}` : body
}

function clearTimer(runId: string): void {
  const timer = timers.get(runId)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(runId)
  }
  const startup = startups.get(runId)
  if (startup !== undefined) {
    clearTimeout(startup)
    startups.delete(runId)
  }
}

function clearStartup(runId: string): void {
  const startup = startups.get(runId)
  if (startup === undefined) return
  clearTimeout(startup)
  startups.delete(runId)
}

/**
 * A launched agent that never reports `working` usually means the launch prompt never landed:
 * Orca logs `agent_launch_terminal_not_running_agent` when it cannot confirm the agent is ready,
 * even though the TUI is up. So the first watchdog types the prompt into the terminal instead,
 * and only a second silence fails the stage.
 */
function armStartup(
  orca: OrcaWorkerApi,
  run: Run,
  index: number,
  mayResend: boolean
): void {
  clearStartup(run.id)
  const timer = setTimeout(() => {
    startups.delete(run.id)
    if (sawWorking.get(run.id)) return
    void rescue(orca, run, index, mayResend)
  }, mayResend ? 45_000 : 60_000)
  const unrefable = timer as unknown as { unref?: () => void }
  unrefable.unref?.()
  startups.set(run.id, timer)
}

async function rescue(
  orca: OrcaWorkerApi,
  run: Run,
  index: number,
  mayResend: boolean
): Promise<void> {
  if (!mayResend || !run.terminalId) {
    await fail(
      orca,
      run,
      index,
      'The agent never reported working (no signal in about two minutes). Check that its CLI runs here, then Retry stage.'
    )
    return
  }
  const terminalId = run.terminalId
  const stage = run.stages[index]
  const declared = pipelineOf(run.pipelineId)?.stages.find((item) => item.id === stage?.stageId)
  const text = promptFor(
    declared ?? { id: stage?.stageId ?? 'stage', name: stage?.stageId ?? 'stage', prompt: '' },
    index,
    run.task
  )

  // The launch call could not hand the prompt over (Orca logs
  // agent_launch_terminal_not_running_agent for an agent it cannot confirm yet). Type it instead,
  // and give a TUI that boots slowly more than one try.
  let last = 'no answer from the terminal'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const sent = await orca.host.call('terminal.sendText', {
        terminalId,
        text,
        enter: true
      })
      if (sent.accepted) {
        armStartup(orca, run, index, false)
        return
      }
      last = 'the terminal refused the input'
    } catch (error) {
      if (isScopeError(error)) {
        scopeBlocked.add(run.id)
        await block(orca, run, scopeNote(run))
        return
      }
      last = message(error)
    }
    orca.log(`run.output: retrying the prompt for ${run.id} (${last})`)
    await new Promise((resolve) => setTimeout(resolve, 15_000))
    if (sawWorking.get(run.id)) return
  }
  await fail(orca, run, index, `The prompt could not be delivered to the agent terminal (${last}).`)
}

function armTimer(orca: OrcaWorkerApi, run: Run, index: number): void {
  clearTimer(run.id)
  const minutes = Math.min(240, Math.max(1, stageTimeoutMinutes))
  const timer = setTimeout(() => {
    timers.delete(run.id)
    void fail(orca, run, index, `No completion signal after ${minutes} min.`)
  }, minutes * 60_000)
  const unrefable = timer as unknown as { unref?: () => void }
  unrefable.unref?.()
  timers.set(run.id, timer)
}

function activeRuns(): Run[] {
  return runs.filter((run) => run.status === 'running' || run.status === 'blocked')
}

function setStatusBar(orca: OrcaWorkerApi): void {
  if (!orca.host.has('statusBar.update')) return
  const active = activeRuns()
  const blocked = active.filter((run) => run.status === 'blocked').length
  const text =
    active.length === 0
      ? ''
      : blocked > 0
        ? `${active.length} running · ${blocked} needs you`
        : `${active.length} running`
  orca.host
    .call('statusBar.update', {
      id: STATUS_BAR_ID,
      text,
      icon: active.length > 0 ? 'activity' : 'layers',
      tone: blocked > 0 ? 'warning' : 'accent',
      visible: active.length > 0
    })
    .catch(() => undefined)
}

function show(orca: OrcaWorkerApi): void {
  orca.panels.post('runs.changed', { runs: plain(runs) })
}

/** Drops the oldest finished runs once too many are kept. */
function prune(): void {
  const finished = runs.filter((run) => run.status !== 'running' && run.status !== 'blocked')
  if (finished.length <= KEEP_FINISHED) return
  const drop = new Set(finished.slice(KEEP_FINISHED).map((run) => run.id))
  runs = runs.filter((run) => !drop.has(run.id))
}

async function persist(orca: OrcaWorkerApi): Promise<void> {
  prune()
  await orca.storage.set(RUNS_KEY, asJson(runs))
  show(orca)
  setStatusBar(orca)
}

function tell(orca: OrcaWorkerApi, title: string, body: string): void {
  if (!notify) return
  orca.host.call('notifications.show', { title, body }).catch(() => undefined)
}

function label(run: Run): string {
  return `${run.pipelineName} in ${run.workspaceName}`
}

async function readTail(orca: OrcaWorkerApi, run: Run): Promise<string | null> {
  if (!run.terminalId) return null
  try {
    const read = await orca.host.call('terminal.read', {
      terminalId: run.terminalId,
      maxLines: 60
    })
    const text = read.lines.join('\n').trim()
    return text ? text.slice(-8000) : null
  } catch {
    return null
  }
}

async function startStage(orca: OrcaWorkerApi, run: Run, index: number): Promise<void> {
  const stage = run.stages[index]
  if (!stage) return
  const declared = pipelineOf(run.pipelineId)?.stages.find((entry) => entry.id === stage.stageId)
  run.stageIndex = index
  run.status = 'running'
  run.endedAt = null
  stage.status = 'running'
  stage.startedAt = Date.now()
  stage.endedAt = null
  stage.note = null
  stage.tail = null
  sawWorking.set(run.id, false)
  scopeBlocked.delete(run.id)
  await persist(orca)
  armTimer(orca, run, index)

  const prompt = promptFor(
    declared ?? { id: stage.stageId, name: stage.stageId, prompt: '' },
    index,
    run.task
  )

  try {
    if (run.terminalId === null) {
      const launched = await orca.host.call('agent.launch', {
        workspaceId: run.workspaceId,
        agent: run.agent,
        prompt
      })
      run.terminalId = launched.terminalId
      armStartup(orca, run, index, true)
      await persist(orca)
    } else {
      const sent = await orca.host.call('terminal.sendText', {
        terminalId: run.terminalId,
        text: prompt,
        enter: true
      })
      if (!sent.accepted) throw new Error('The terminal did not accept the prompt.')
      // A prompt sent to a terminal whose agent is gone also never reports `working`.
      armStartup(orca, run, index, false)
    }
  } catch (error) {
    if (isScopeError(error)) {
      scopeBlocked.add(run.id)
      await block(orca, run, scopeNote(run))
      return
    }
    await fail(orca, run, index, message(error))
  }
}

async function finishStage(
  orca: OrcaWorkerApi,
  run: Run,
  index: number,
  note: string | null
): Promise<void> {
  const stage = run.stages[index]
  if (!stage) return
  clearTimer(run.id)
  stage.status = 'done'
  stage.endedAt = Date.now()
  stage.note = note
  stage.tail = await readTail(orca, run)

  if (index >= run.stages.length - 1) {
    run.status = 'done'
    run.endedAt = Date.now()
    await persist(orca)
    tell(orca, 'Pipeline complete', label(run))
    return
  }
  await persist(orca)
  await startStage(orca, run, index + 1)
}

async function fail(
  orca: OrcaWorkerApi,
  run: Run,
  index: number,
  reason: string
): Promise<void> {
  clearTimer(run.id)
  const stage = run.stages[index]
  if (stage) {
    stage.status = 'failed'
    stage.note = reason
    stage.endedAt = Date.now()
    stage.tail = await readTail(orca, run)
  }
  run.status = 'failed'
  run.endedAt = Date.now()
  await persist(orca)
  tell(orca, 'Pipeline failed', `${label(run)}: ${reason}`)
}

async function block(orca: OrcaWorkerApi, run: Run, note: string): Promise<void> {
  const stage = currentStage(run)
  if (!stage) return
  clearTimer(run.id)
  run.status = 'blocked'
  stage.status = 'blocked'
  stage.note = note
  await persist(orca)
  tell(orca, 'Pipeline needs you', `${label(run)}: ${note}`)
}

async function onAgentStatus(
  orca: OrcaWorkerApi,
  event: {
    terminalId?: string
    state: 'working' | 'blocked' | 'waiting' | 'done'
    mainAgent?: { state: string; outcome?: string }
  }
): Promise<void> {
  if (!event.terminalId) return
  const run = runs.find((entry) => entry.terminalId === event.terminalId)
  if (!run || run.status !== 'running') return
  const stage = currentStage(run)
  if (!stage || stage.status !== 'running') return
  const index = run.stageIndex

  if (event.state === 'working') {
    sawWorking.set(run.id, true)
    clearStartup(run.id)
    return
  }
  if (event.state === 'blocked') {
    await block(orca, run, 'The agent is waiting for you in its terminal.')
    return
  }
  // `waiting` is an idle agent whose turn ended; `done` is the same with a finished turn.
  if (event.state !== 'waiting' && event.state !== 'done') return
  if (!sawWorking.get(run.id) && Date.now() - (stage.startedAt ?? Date.now()) < 2500) return

  const outcome = event.mainAgent?.outcome
  if (outcome === 'failure') {
    await fail(orca, run, index, 'The agent reported a failed turn.')
    return
  }
  if (outcome === 'interruption' || outcome === 'cancellation' || outcome === 'superseded') {
    await fail(orca, run, index, `The turn ended as ${outcome}.`)
    return
  }
  await finishStage(orca, run, index, null)
}

async function storedPipelines(orca: OrcaWorkerApi): Promise<Pipeline[]> {
  const stored = await orca.storage.get(PIPELINES_KEY)
  const existing: Pipeline[] = Array.isArray(stored) ? (plain(stored) as Pipeline[]) : []
  const seededRaw = await orca.storage.get(SEEDED_KEY)
  const present = new Set(existing.map((entry) => entry.id))
  // Before the seeded list existed, whatever the defaults left in storage counted as offered.
  const offered = new Set<string>(
    Array.isArray(seededRaw)
      ? seededRaw.map(String)
      : DEFAULT_PIPELINES.filter((entry) => present.has(entry.id)).map((entry) => entry.id)
  )

  let next = existing
  for (const seed of DEFAULT_PIPELINES) {
    if (offered.has(seed.id) || present.has(seed.id)) {
      offered.add(seed.id)
      continue
    }
    next = [...next, { ...plain(seed), agent: defaultAgent }]
    offered.add(seed.id)
  }

  if (next !== existing || !Array.isArray(stored)) {
    await orca.storage.set(PIPELINES_KEY, asJson(next))
  }
  await orca.storage.set(SEEDED_KEY, asJson([...offered]))
  return next
}

/** One-shot: an install whose seeded flows still say `claude` adopts the resolved default. */
async function adoptDefaultAgent(orca: OrcaWorkerApi, list: Pipeline[]): Promise<Pipeline[]> {
  if ((await orca.storage.get(AGENT_SEEDS_KEY)) === true) return list
  const seedIds = new Set(DEFAULT_PIPELINES.map((seed) => seed.id))
  const next = list.map((entry) =>
    seedIds.has(entry.id) && entry.agent === 'claude' && defaultAgent !== 'claude'
      ? { ...entry, agent: defaultAgent }
      : entry
  )
  const changed = next.some((entry, at) => entry.agent !== list[at]?.agent)
  if (changed) await orca.storage.set(PIPELINES_KEY, asJson(next))
  await orca.storage.set(AGENT_SEEDS_KEY, true)
  return next
}

async function storedRuns(orca: OrcaWorkerApi): Promise<Run[]> {
  const stored = await orca.storage.get(RUNS_KEY)
  let list: Run[] = Array.isArray(stored) ? (plain(stored) as Run[]) : []
  if (list.length === 0) {
    // 0.4.x wrote a single run here; keep it as the first entry instead of losing it.
    const legacy = await orca.storage.get(LEGACY_RUN_KEY)
    if (legacy !== null && typeof legacy === 'object' && !Array.isArray(legacy)) {
      list = [plain(legacy) as Run]
      await orca.storage.set(RUNS_KEY, asJson(list))
    }
  }
  for (const run of list) {
    if (run.status !== 'running') continue
    // The process waiting for that agent is gone; ask the person to carry on.
    const stage = run.stages[run.stageIndex]
    if (stage) {
      stage.status = 'blocked'
      stage.note = 'Orca restarted while this stage was running.'
    }
    run.status = 'blocked'
  }
  if (list.some((run) => run.status === 'blocked')) await orca.storage.set(RUNS_KEY, asJson(list))
  return list
}

async function resolveDefaultAgent(orca: OrcaWorkerApi): Promise<string> {
  try {
    const pinned = await orca.settings.get('defaultAgent')
    if (typeof pinned === 'string' && pinned.trim()) return pinned.trim()
  } catch {
    // Fall through to the running agent.
  }
  try {
    const listed = await orca.host.call('agents.list')
    const agents = (listed?.agents ?? []).filter((entry) => entry.agent)
    const active =
      agents.find((entry) => entry.state === 'working') ??
      agents.find((entry) => entry.state === 'waiting') ??
      agents[0]
    if (active?.agent) return active.agent
  } catch {
    // No focused workspace, or no agent in it yet.
  }
  if (availableAgents[0]) return availableAgents[0]
  return 'claude'
}

async function readSettings(orca: OrcaWorkerApi): Promise<void> {
  try {
    const timeout = await orca.settings.get('stageTimeoutMinutes')
    if (typeof timeout === 'number' && Number.isFinite(timeout)) stageTimeoutMinutes = timeout
    const shouldNotify = await orca.settings.get('notify')
    if (typeof shouldNotify === 'boolean') notify = shouldNotify
    const parallel = await orca.settings.get('maxParallelRuns')
    if (typeof parallel === 'number' && Number.isFinite(parallel)) {
      maxParallelRuns = Math.min(8, Math.max(1, Math.round(parallel)))
    }
  } catch {
    // Settings are optional; the defaults above apply.
  }
  defaultAgent = await resolveDefaultAgent(orca)
}

function conflict(text: string): Error {
  return Object.assign(new Error(text), { code: 'conflict' })
}

function missing(): Error {
  return Object.assign(new Error('That run is no longer here.'), { code: 'invalid_params' })
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  availableAgents = detectInstalledAgents()
  await readSettings(orca)
  pipelines = await adoptDefaultAgent(orca, await storedPipelines(orca))
  runs = await storedRuns(orca)
  setStatusBar(orca)

  orca.settings.onDidChange(() => void readSettings(orca))

  orca.events.on('agent.status.changed', (event) => {
    void onAgentStatus(orca, event)
  })

  orca.panels.handle('pipelines.list', () => ({ pipelines: plain(pipelines) }))

  orca.panels.handle('pipelines.save', async ({ pipeline }) => {
    if (!pipeline.name.trim()) throw new Error('A pipeline needs a name.')
    if (!pipeline.agent.trim()) throw new Error('A pipeline needs an agent.')
    if (pipeline.stages.length === 0) throw new Error('A pipeline needs at least one stage.')
    const saved: Pipeline = { ...plain(pipeline), agent: pipeline.agent.trim() }
    const at = pipelines.findIndex((entry) => entry.id === saved.id)
    pipelines =
      at === -1 ? [...pipelines, saved] : pipelines.map((e) => (e.id === saved.id ? saved : e))
    await orca.storage.set(PIPELINES_KEY, asJson(pipelines))
    orca.panels.post('pipelines.changed', { pipelines: plain(pipelines) })
    return { pipelines: plain(pipelines) }
  })

  orca.panels.handle('pipelines.remove', async ({ id }) => {
    pipelines = pipelines.filter((entry) => entry.id !== id)
    await orca.storage.set(PIPELINES_KEY, asJson(pipelines))
    orca.panels.post('pipelines.changed', { pipelines: plain(pipelines) })
    return { pipelines: plain(pipelines) }
  })

  orca.panels.handle('workspaces.list', async () => {
    let entries: Awaited<ReturnType<typeof orca.host.call<'workspace.list'>>>['workspaces'] = []
    try {
      const listed = await orca.host.call('workspace.list')
      entries = listed?.workspaces ?? []
    } catch {
      // Without a workspace list the panel says there is nothing to run in.
      entries = []
    }
    const workspaces: Workspace[] = entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      path: entry.path,
      branch: entry.branch,
      kind: entry.kind,
      project: entry.project ?? null
    }))
    return { workspaces }
  })

  orca.panels.handle('run.state', () => {
    // Re-read the machine each time the panel asks, so an agent installed since activation shows up.
    availableAgents = detectInstalledAgents()
    return {
      runs: plain(runs),
      pipelines: plain(pipelines),
      defaultAgent,
      availableAgents,
      maxParallelRuns
    }
  })

  orca.panels.handle('run.start', async ({ pipelineId, workspaceId, task }) => {
    const pipeline = pipelineOf(pipelineId)
    if (!pipeline) throw new Error('That pipeline no longer exists.')
    if (!pipeline.agent.trim()) throw new Error('That pipeline has no agent.')
    if (pipeline.stages.length === 0) throw new Error('That pipeline has no stages.')
    if (activeRuns().length >= maxParallelRuns) {
      throw conflict(
        `${maxParallelRuns} run${maxParallelRuns === 1 ? '' : 's'} at a time is the limit; stop one or raise it in Settings.`
      )
    }

    let workspaceName = workspaceId
    try {
      const listed = await orca.host.call('workspace.list')
      const match = (listed?.workspaces ?? []).find((entry) => entry.id === workspaceId)
      if (match) workspaceName = match.name
    } catch {
      // The name is cosmetic; the id is what the host needs.
    }

    // Orca lets a plugin type only into the active worktree, so a run elsewhere would stall at
    // stage two. Say so now, while it is one click to fix.
    const active = await activeWorkspace(orca)
    if (active && active.id !== workspaceId) {
      throw new Error(
        `Open ${workspaceName} in Orca first: a pipeline can only type into the worktree that is active, and ${active.name} is active now.`
      )
    }

    const run: Run = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      workspaceId,
      workspaceName,
      agent: pipeline.agent,
      task,
      terminalId: null,
      stageIndex: 0,
      status: 'running',
      stages: pipeline.stages.map((stage) => ({
        stageId: stage.id,
        status: 'pending' as const,
        startedAt: null,
        endedAt: null,
        note: null,
        tail: null
      })),
      startedAt: Date.now(),
      endedAt: null
    }
    runs = [run, ...runs]
    await persist(orca)
    await startStage(orca, run, 0)
    return { run: plain(run) }
  })

  orca.panels.handle('run.stop', async ({ runId }) => {
    const run = runById(runId)
    if (!run) throw missing()
    clearTimer(run.id)
    const stage = currentStage(run)
    if (stage && (stage.status === 'running' || stage.status === 'blocked')) {
      stage.status = 'skipped'
      stage.note = 'Stopped.'
      stage.endedAt = Date.now()
    }
    run.status = 'stopped'
    run.endedAt = Date.now()
    await persist(orca)
    return { runs: plain(runs) }
  })

  orca.panels.handle('run.resume', async ({ runId }) => {
    const run = runById(runId)
    if (!run) throw missing()
    if (run.status !== 'blocked') return { runs: plain(runs) }
    const stage = currentStage(run)
    if (stage) {
      stage.status = 'running'
      stage.note = null
    }
    const resend = scopeBlocked.delete(run.id)
    run.status = 'running'
    sawWorking.set(run.id, false)
    await persist(orca)
    if (resend) {
      // The prompt never landed; carrying on means sending it again with the worktree now active.
      await startStage(orca, run, run.stageIndex)
      return { runs: plain(runs) }
    }
    armTimer(orca, run, run.stageIndex)
    // If this run never showed signs of life, hold the terminal to the same two-minute standard.
    if (!sawWorking.get(run.id)) armStartup(orca, run, run.stageIndex, false)
    return { runs: plain(runs) }
  })

  orca.panels.handle('run.retry', async ({ runId }) => {
    const run = runById(runId)
    if (!run) throw missing()
    if (run.status === 'running') throw conflict('That stage is still running.')
    await startStage(orca, run, run.stageIndex)
    return { runs: plain(runs) }
  })

  orca.panels.handle('run.skip', async ({ runId }) => {
    const run = runById(runId)
    if (!run) throw missing()
    if (run.status === 'running') throw conflict('Stop that run before skipping a stage.')
    clearTimer(run.id)
    const stage = currentStage(run)
    if (stage) {
      stage.status = 'skipped'
      stage.note = 'Skipped.'
      stage.endedAt = Date.now()
    }
    const next = run.stageIndex + 1
    if (next >= run.stages.length) {
      run.status = 'done'
      run.endedAt = Date.now()
      await persist(orca)
      return { runs: plain(runs) }
    }
    await startStage(orca, run, next)
    return { runs: plain(runs) }
  })

  orca.panels.handle('run.output', async ({ runId, maxLines }) => {
    const run = runById(runId)
    if (!run) throw missing()
    if (!run.terminalId) return { text: null }
    try {
      const read = await orca.host.call('terminal.read', {
        terminalId: run.terminalId,
        maxLines: Math.min(2000, Math.max(20, maxLines ?? 400))
      })
      const text = read.lines.join('\n').trim()
      return { text: text ? text.slice(-20000) : null }
    } catch {
      // The terminal is gone (closed, or the worktree slept): fall back to what the last stage kept.
      const tail = [...run.stages].reverse().find((stage) => stage.tail)?.tail ?? null
      return { text: tail }
    }
  })

  orca.panels.handle('run.remove', async ({ runId }) => {
    const run = runById(runId)
    if (!run) throw missing()
    if (run.status === 'running' || run.status === 'blocked') {
      throw conflict('Stop that run before removing it.')
    }
    runs = runs.filter((entry) => entry.id !== runId)
    await persist(orca)
    return { runs: plain(runs) }
  })
}

export function deactivate(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  for (const timer of startups.values()) clearTimeout(timer)
  startups.clear()
}
