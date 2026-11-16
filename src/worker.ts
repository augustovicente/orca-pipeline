// The plugin's worker: it owns the run state machine. A stage ends its turn in the agent, the
// worker hears `agent.status.changed`, and the next stage's prompt goes into the same terminal,
// so every stage sees the conversation before it.
//
// A save restarts the worker and drops in-memory state, so the run and the pipelines live in
// orca.storage.
import type { JsonValue } from 'orca/worker'
import type { OrcaWorkerApi } from 'orca/worker'
import { DEFAULT_PIPELINES } from './defaults'
import type { Pipeline, Run, Stage, StageState, Workspace } from './protocol'

const PIPELINES_KEY = 'pipelines'
/** Ids of the seeded pipelines this plugin has already offered, so a deleted seed stays deleted. */
const SEEDED_KEY = 'seeded'
const RUN_KEY = 'run'
const STATUS_BAR_ID = 'run'

/** Cached settings: the worker re-reads them when the person changes one. */
let stageTimeoutMinutes = 20
let notify = true

let pipelines: Pipeline[] = []
let run: Run | null = null
let timer: ReturnType<typeof setTimeout> | null = null
/** Whether this stage has reported `working` yet; a stage cannot be done before it starts. */
let sawWorking = false

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Copies through JSON so a panel never shares a mutable object with the worker. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asJson(value: unknown): JsonValue {
  return plain(value) as JsonValue
}

function stageNow(): StageState | null {
  if (!run) return null
  return run.stages[run.stageIndex] ?? null
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

function clearTimer(): void {
  if (timer === null) return
  clearTimeout(timer)
  timer = null
}

function armTimer(orca: OrcaWorkerApi, index: number): void {
  clearTimer()
  const minutes = Math.min(240, Math.max(1, stageTimeoutMinutes))
  timer = setTimeout(() => {
    timer = null
    void fail(orca, index, `No completion signal after ${minutes} min.`)
  }, minutes * 60_000)
  // Never hold the process open for a pending stage.
  const unrefable = timer as unknown as { unref?: () => void }
  unrefable.unref?.()
}

function setStatusBar(orca: OrcaWorkerApi): void {
  if (!orca.host.has('statusBar.update')) return
  const done = run ? run.stages.filter((stage) => stage.status === 'done').length : 0
  const total = run ? run.stages.length : 0
  const text =
    run === null
      ? ''
      : run.status === 'running'
        ? `${done}/${total} ${run.stages[run.stageIndex]?.stageId ?? ''}`.trim()
        : run.status
  const tone =
    run?.status === 'done'
      ? 'success'
      : run?.status === 'failed'
        ? 'danger'
        : run?.status === 'blocked'
          ? 'warning'
          : 'accent'
  orca.host
    .call('statusBar.update', {
      id: STATUS_BAR_ID,
      text,
      icon: run?.status === 'running' ? 'activity' : 'layers',
      tone,
      visible: run !== null
    })
    .catch(() => undefined)
}

function show(orca: OrcaWorkerApi): void {
  orca.panels.post('run.changed', { run: run === null ? null : plain(run) })
}

async function persist(orca: OrcaWorkerApi): Promise<void> {
  await orca.storage.set(RUN_KEY, asJson(run))
  show(orca)
  setStatusBar(orca)
}

function tell(orca: OrcaWorkerApi, title: string, body: string): void {
  if (!notify) return
  orca.host.call('notifications.show', { title, body }).catch(() => undefined)
}

async function readTail(orca: OrcaWorkerApi): Promise<string | null> {
  if (!run?.terminalId) return null
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

async function startStage(orca: OrcaWorkerApi, index: number): Promise<void> {
  if (!run) return
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
  sawWorking = false
  await persist(orca)
  armTimer(orca, index)

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
      await persist(orca)
    } else {
      const sent = await orca.host.call('terminal.sendText', {
        terminalId: run.terminalId,
        text: prompt,
        enter: true
      })
      if (!sent.accepted) throw new Error('The terminal did not accept the prompt.')
    }
  } catch (error) {
    await fail(orca, index, message(error))
  }
}

async function finishStage(orca: OrcaWorkerApi, index: number, note: string | null): Promise<void> {
  if (!run) return
  const stage = run.stages[index]
  if (!stage) return
  clearTimer()
  stage.status = 'done'
  stage.endedAt = Date.now()
  stage.note = note
  stage.tail = await readTail(orca)

  if (index >= run.stages.length - 1) {
    run.status = 'done'
    run.endedAt = Date.now()
    await persist(orca)
    tell(orca, 'Pipeline complete', `${run.pipelineName} finished in ${run.workspaceName}.`)
    return
  }
  await persist(orca)
  await startStage(orca, index + 1)
}

async function fail(orca: OrcaWorkerApi, index: number, reason: string): Promise<void> {
  if (!run) return
  clearTimer()
  const stage = run.stages[index]
  if (stage) {
    stage.status = 'failed'
    stage.note = reason
    stage.endedAt = Date.now()
    stage.tail = await readTail(orca)
  }
  run.status = 'failed'
  run.endedAt = Date.now()
  await persist(orca)
  tell(orca, 'Pipeline failed', `${run.pipelineName}: ${reason}`)
}

async function block(orca: OrcaWorkerApi, note: string): Promise<void> {
  if (!run) return
  const stage = stageNow()
  if (!stage) return
  clearTimer()
  run.status = 'blocked'
  stage.status = 'blocked'
  stage.note = note
  await persist(orca)
  tell(orca, 'Pipeline needs you', `${run.pipelineName}: ${note}`)
}

async function onAgentStatus(
  orca: OrcaWorkerApi,
  event: {
    terminalId?: string
    state: 'working' | 'blocked' | 'waiting' | 'done'
    mainAgent?: { state: string; outcome?: string }
  }
): Promise<void> {
  if (!run || run.status !== 'running') return
  if (!event.terminalId || event.terminalId !== run.terminalId) return
  const stage = stageNow()
  if (!stage || stage.status !== 'running') return
  const index = run.stageIndex

  if (event.state === 'working') {
    sawWorking = true
    return
  }
  if (event.state === 'blocked') {
    await block(orca, 'The agent is waiting for you in its terminal.')
    return
  }
  // `waiting` is an idle agent whose turn ended; `done` is the same with a finished turn.
  if (event.state !== 'waiting' && event.state !== 'done') return
  if (!sawWorking && Date.now() - (stage.startedAt ?? Date.now()) < 2500) return

  const outcome = event.mainAgent?.outcome
  if (outcome === 'failure') {
    await fail(orca, index, 'The agent reported a failed turn.')
    return
  }
  if (outcome === 'interruption' || outcome === 'cancellation' || outcome === 'superseded') {
    await fail(orca, index, `The turn ended as ${outcome}.`)
    return
  }
  await finishStage(orca, index, null)
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
    next = [...next, plain(seed)]
    offered.add(seed.id)
  }

  if (next !== existing || !Array.isArray(stored)) {
    await orca.storage.set(PIPELINES_KEY, asJson(next))
  }
  await orca.storage.set(SEEDED_KEY, asJson([...offered]))
  return next
}

async function storedRun(orca: OrcaWorkerApi): Promise<Run | null> {
  const stored = await orca.storage.get(RUN_KEY)
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null
  const restored = plain(stored) as Run
  if (restored.status === 'running') {
    // The process that was waiting for the agent is gone; ask the person to carry on.
    const stage = restored.stages[restored.stageIndex]
    if (stage) {
      stage.status = 'blocked'
      stage.note = 'Orca restarted while this stage was running.'
    }
    restored.status = 'blocked'
    await orca.storage.set(RUN_KEY, asJson(restored))
  }
  return restored
}

async function readSettings(orca: OrcaWorkerApi): Promise<void> {
  try {
    const timeout = await orca.settings.get('stageTimeoutMinutes')
    if (typeof timeout === 'number' && Number.isFinite(timeout)) stageTimeoutMinutes = timeout
    const shouldNotify = await orca.settings.get('notify')
    if (typeof shouldNotify === 'boolean') notify = shouldNotify
  } catch {
    // Settings are optional; the defaults above apply.
  }
}

function conflict(text: string): Error {
  return Object.assign(new Error(text), { code: 'conflict' })
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  pipelines = await storedPipelines(orca)
  run = await storedRun(orca)
  await readSettings(orca)
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
    pipelines = at === -1 ? [...pipelines, saved] : pipelines.map((e) => (e.id === saved.id ? saved : e))
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

  orca.panels.handle('run.state', () => ({
    run: run === null ? null : plain(run),
    pipelines: plain(pipelines)
  }))

  orca.panels.handle('run.start', async ({ pipelineId, workspaceId, task }) => {
    const pipeline = pipelineOf(pipelineId)
    if (!pipeline) throw new Error('That pipeline no longer exists.')
    if (run && run.status === 'running') throw conflict('A run is already going.')
    if (!pipeline.agent.trim()) throw new Error('That pipeline has no agent.')
    if (pipeline.stages.length === 0) throw new Error('That pipeline has no stages.')

    let workspaceName = workspaceId
    try {
      const listed = await orca.host.call('workspace.list')
      const match = (listed?.workspaces ?? []).find((entry) => entry.id === workspaceId)
      if (match) workspaceName = match.name
    } catch {
      // The name is cosmetic; the id is what the host needs.
    }

    const next: Run = {
      id: `run-${Date.now()}`,
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
    run = next
    await persist(orca)
    await startStage(orca, 0)
    return { run: plain(next) }
  })

  orca.panels.handle('run.stop', async () => {
    if (!run) return { run: null }
    clearTimer()
    const stage = stageNow()
    if (stage && stage.status === 'running') {
      stage.status = 'skipped'
      stage.note = 'Stopped.'
      stage.endedAt = Date.now()
    }
    run.status = 'stopped'
    run.endedAt = Date.now()
    await persist(orca)
    return { run: plain(run) }
  })

  orca.panels.handle('run.resume', async () => {
    if (!run || run.status !== 'blocked') return { run: run === null ? null : plain(run) }
    const stage = stageNow()
    if (stage) {
      stage.status = 'running'
      stage.note = null
    }
    run.status = 'running'
    sawWorking = false
    await persist(orca)
    armTimer(orca, run.stageIndex)
    return { run: plain(run) }
  })

  orca.panels.handle('run.retry', async () => {
    if (!run) return { run: null }
    if (run.status === 'running') throw conflict('The stage is still running.')
    await startStage(orca, run.stageIndex)
    return { run: plain(run) }
  })

  orca.panels.handle('run.skip', async () => {
    if (!run) return { run: null }
    if (run.status === 'running') throw conflict('Stop the run before skipping a stage.')
    clearTimer()
    const stage = stageNow()
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
      return { run: plain(run) }
    }
    await startStage(orca, next)
    return { run: plain(run) }
  })
}

export function deactivate(): void {
  clearTimer()
}
