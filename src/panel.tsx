// The panel: pick a pipeline and a workspace, type the task, run. A second tab edits the
// pipelines themselves. All state that must outlive a save lives in atoms or the worker.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  CodeView,
  Collapsible,
  EmptyState,
  Field,
  Heading,
  host,
  IconButton,
  Input,
  List,
  ListItem,
  on,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  settings,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  Textarea,
  type PanelContext,
  type IconName,
  type Tone
} from 'orca'
import { AGENT_CHOICES } from './agent-choices'
import { canResume } from './models'
import type {
  Pipeline,
  Project,
  Reasoning,
  Run,
  RunStatus,
  Stage,
  StageState,
  StageStatus,
  Workspace
} from './protocol'
import { appliesTo, pipelineProjectKey, projectKey } from './scope'

/** The icon for an agent, or the generic one for an id this build does not know. */
function agentIcon(id: string): IconName {
  return (AGENT_CHOICES.find((choice) => choice.id === id)?.icon ?? 'agent') as IconName
}

const pipelines = atom<Pipeline[]>([])
const runs = atom<Run[]>([])
/** Terminal text per run, once someone asked for it. Key present means the viewer is open. */
const outputs = atom<Record<string, string>>({})
const maxParallelRuns = atom(5)
const workspaces = atom<Workspace[]>([])
const projects = atom<Project[]>([])
const selectedPipeline = atom('selectedPipeline', '', { persist: 'plugin' })
const selectedWorkspace = atom('selectedWorkspace', '', { persist: 'plugin' })
const agentPicker = atom(false)
const defaultAgent = atom('claude')
const availableAgents = atom<string[]>([])
const levels = atom<Record<Reasoning, { agent: string; model: string }>>({
  high: { agent: '', model: '' },
  medium: { agent: '', model: '' },
  low: { agent: '', model: '' }
})
const task = atom('task', '')
const tab = atom('tab', 'run', { persist: 'plugin' })
const editing = atom<Pipeline | null | 'closed'>(null)
/** Pressing Delete once arms it; pressing Confirm delete removes the pipeline. */
const deleteArmed = atom(false)
const notice = atom<{ text: string; tone: Tone; title: string } | null>(null)
const busy = atom(false)
/** The Settings tab's fields, as strings until saved. */
const settingsDraft = atom<Record<string, string>>({})
const settingsSaved = atom(false)

const SETTING_KEYS = [
  'highAgent',
  'highModel',
  'mediumAgent',
  'mediumModel',
  'lowAgent',
  'lowModel',
  'defaultAgent',
  'maxParallelRuns',
  'stageTimeoutMinutes',
  'modelBootSeconds',
  'notify'
] as const

const NUMBER_SETTINGS = new Set(['maxParallelRuns', 'stageTimeoutMinutes', 'modelBootSeconds'])

function editSetting(key: string, value: string): void {
  set(settingsDraft, { ...read(settingsDraft), [key]: value })
  set(settingsSaved, false)
}

async function loadSettings(): Promise<void> {
  const all = await settings.get()
  const next: Record<string, string> = {}
  for (const key of SETTING_KEYS) {
    const value = all[key]
    next[key] = value === undefined || value === null ? '' : String(value)
  }
  set(settingsDraft, next)
}

function saveSettings(): void {
  void attempt(async () => {
    const values = read(settingsDraft)
    for (const key of SETTING_KEYS) {
      const raw = (values[key] ?? '').trim()
      if (key === 'notify') {
        await settings.set(key, raw === 'true')
      } else if (NUMBER_SETTINGS.has(key)) {
        const parsed = Number(raw)
        if (raw === '' || !Number.isFinite(parsed)) {
          throw new Error(`${key} needs a number.`)
        }
        await settings.set(key, parsed)
      } else {
        await settings.set(key, raw)
      }
    }
    const state = await plugin.request('run.state')
    set(levels, state.levels)
    set(defaultAgent, state.defaultAgent)
    set(maxParallelRuns, state.maxParallelRuns)
    set(settingsSaved, true)
  })
}

const STAGE_TONES: Record<StageStatus, Tone> = {
  pending: 'neutral',
  running: 'accent',
  done: 'success',
  blocked: 'warning',
  failed: 'danger',
  skipped: 'neutral'
}

const RUN_TONES: Record<RunStatus, Tone> = {
  running: 'accent',
  blocked: 'warning',
  failed: 'danger',
  done: 'success',
  stopped: 'neutral'
}

const STAGE_LABELS: Record<StageStatus, string> = {
  pending: 'waiting',
  running: 'running',
  done: 'done',
  blocked: 'needs you',
  failed: 'failed',
  skipped: 'skipped'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function attempt(work: () => Promise<void>): Promise<void> {
  set(busy, true)
  set(notice, null)
  try {
    await work()
  } catch (error) {
    set(notice, { text: messageOf(error), tone: 'danger', title: 'That did not work' })
  } finally {
    set(busy, false)
  }
}

function info(text: string): void {
  set(notice, { text, tone: 'success', title: 'Done' })
}

async function refresh(): Promise<void> {
  const state = await plugin.request('run.state')
  const listed = await plugin.request('workspaces.list')
  const spaces = listed.workspaces

  set(pipelines, state.pipelines)
  set(projects, state.projects ?? [])
  set(runs, state.runs)
  set(defaultAgent, state.defaultAgent)
  set(maxParallelRuns, state.maxParallelRuns)
  set(availableAgents, state.availableAgents ?? [])
  set(levels, state.levels)
  set(workspaces, spaces)

  // Follow the workspace the person is looking at, and drop a selection that no longer exists.
  if (!spaces.some((space) => space.id === read(selectedWorkspace))) {
    let focused = ''
    try {
      const context = await host.call('workspace.readContext')
      if (context) {
        const match =
          spaces.find((space) => space.id === context.workspaceId) ??
          spaces.find((space) => space.name === context.displayName)
        focused = match?.id ?? ''
      }
    } catch {
      // Without a focused workspace the first one will do.
    }
    set(selectedWorkspace, focused || spaces[0]?.id || '')
  }
  if (!state.pipelines.some((entry) => entry.id === read(selectedPipeline))) {
    set(selectedPipeline, state.pipelines[0]?.id ?? '')
  }
}

function refreshNow(): void {
  void attempt(refresh)
}

/** Toggles the output viewer for a run, loading the live terminal the first time. */
function loadOutput(run: Run): void {
  void attempt(async () => {
    const answer = await plugin.request('run.output', { runId: run.id, maxLines: 400 })
    set(outputs, {
      ...read(outputs),
      [run.id]: answer.text ?? 'Nothing in that terminal yet.'
    })
  })
}

function closeOutput(run: Run): void {
  const next = { ...read(outputs) }
  delete next[run.id]
  set(outputs, next)
}

function refreshOutput(run: Run): void {
  loadOutput(run)
}

/** Shows the run's own terminal in Orca; if it is gone, reopens its session instead. */
function openRun(run: Run): void {
  void attempt(async () => {
    const answer = await plugin.request('run.open', { runId: run.id })
    if (answer.opened === 'session') {
      info('That terminal had closed, so the agent session opened in a new tab.')
    } else if (answer.opened === 'none') {
      info(
        `Could not open this run's terminal. Open ${run.workspaceName} in Orca and try again.`
      )
    }
  })
}

/** Opens the run's conversation in a fresh tab, leaving the pipeline's terminal alone. */
function openSession(run: Run): void {
  void attempt(async () => {
    const answer = await plugin.request('run.openSession', { runId: run.id })
    info(
      answer.started
        ? 'The agent session is open in its own tab.'
        : 'That session is already open in an Orca tab.'
    )
  })
}

function control(
  name: 'run.stop' | 'run.resume' | 'run.retry' | 'run.skip' | 'run.remove',
  runId: string
): void {
  void attempt(async () => {
    const answer = await plugin.request(name, { runId })
    set(runs, answer.runs)
  })
}

function newPipeline(project?: Project | null): void {
  set(agentPicker, false)
  set(deleteArmed, false)
  set(editing, {
    id: `pipeline-${Date.now()}`,
    name: project ? `${project.name} pipeline` : 'New pipeline',
    agent: read(defaultAgent) || 'claude',
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    stages: [{ id: `stage-${Date.now()}`, name: 'Plan', prompt: '' }]
  })
  set(tab, 'pipelines')
}

function duplicatePipeline(draft: Pipeline): void {
  set(deleteArmed, false)
  set(editing, {
    ...draft,
    id: `pipeline-${Date.now()}`,
    name: `${draft.name} copy`,
    stages: draft.stages.map((stage, index) => ({
      ...stage,
      id: `stage-${Date.now()}-${index}`
    }))
  })
}

function editStage(index: number, patch: Partial<Stage>): void {
  const draft = read(editing)
  if (!draft || draft === 'closed') return
  set(editing, {
    ...draft,
    stages: draft.stages.map((stage, at) => (at === index ? { ...stage, ...patch } : stage))
  })
}

function addStage(): void {
  const draft = read(editing)
  if (!draft || draft === 'closed') return
  const at = draft.stages.length + 1
  set(editing, {
    ...draft,
    stages: [...draft.stages, { id: `stage-${Date.now()}`, name: `Stage ${at}`, prompt: '' }]
  })
}

function removeStage(index: number): void {
  const draft = read(editing)
  if (!draft || draft === 'closed') return
  set(editing, { ...draft, stages: draft.stages.filter((_, at) => at !== index) })
}

function moveStage(index: number, delta: number): void {
  const draft = read(editing)
  if (!draft || draft === 'closed') return
  const at = index + delta
  if (at < 0 || at >= draft.stages.length) return
  const stages = [...draft.stages]
  const [moved] = stages.splice(index, 1)
  if (moved) stages.splice(at, 0, moved)
  set(editing, { ...draft, stages })
}

function savePipeline(): void {
  void attempt(async () => {
    const draft = read(editing)
    if (!draft || draft === 'closed') return
    const saved = await plugin.request('pipelines.save', { pipeline: draft })
    set(pipelines, saved.pipelines)
    set(selectedPipeline, draft.id)
    set(deleteArmed, false)
    set(editing, null)
  })
}

function removePipeline(): void {
  void attempt(async () => {
    const draft = read(editing)
    if (!draft || draft === 'closed') return
    if (!read(deleteArmed)) {
      set(deleteArmed, true)
      return
    }
    const saved = await plugin.request('pipelines.remove', { id: draft.id })
    set(pipelines, saved.pipelines)
    if (read(selectedPipeline) === draft.id) set(selectedPipeline, saved.pipelines[0]?.id ?? '')
    set(deleteArmed, false)
    set(editing, null)
  })
}

/** Runs once before the first render; `ctx.subscriptions` end with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('runs.changed', (payload) => set(runs, payload.runs)))
  ctx.subscriptions.push(
    plugin.on('pipelines.changed', (payload) => set(pipelines, payload.pipelines))
  )
  // A worktree or folder opened elsewhere in Orca shows up without closing the panel.
  ctx.subscriptions.push(on('workspace.created', () => refreshNow()))
  ctx.subscriptions.push(on('workspace.removed', () => refreshNow()))
  void attempt(async () => {
    await refresh()
    await loadSettings()
  })
}

function stageIcon(status: StageStatus): IconName {
  switch (status) {
    case 'done':
      return 'check'
    case 'running':
      return 'activity'
    case 'blocked':
      return 'warning'
    case 'failed':
      return 'error'
    case 'skipped':
      return 'close'
    default:
      return 'next'
  }
}

function stageName(run: Run, stageId: string): string {
  const declared = read(pipelines).find((entry) => entry.id === run.pipelineId)?.stages
  return declared?.find((item) => item.id === stageId)?.name ?? stageId
}

/** `12s`, `2m 4s`, `1h 3m`; enough to see how long a stage or a run has taken. */
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function trimmed(text: string | null, limit = 90): string {
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function stageDescription(stage: StageState): string {
  const took =
    stage.startedAt === null
      ? ''
      : stage.endedAt === null
        ? Date.now() - stage.startedAt > 0
          ? ` · ${duration(Date.now() - stage.startedAt)}`
          : ''
        : ` · ${duration(stage.endedAt - stage.startedAt)}`
  const note = stage.note ? ` · ${trimmed(stage.note)}` : ''
  return `${STAGE_LABELS[stage.status]}${took}${note}`
}

function runElapsed(run: Run): string {
  const end = run.endedAt ?? Date.now()
  return duration(end - run.startedAt)
}

function selectedProjectName(): string | null {
  const space = read(workspaces).find((entry) => entry.id === read(selectedWorkspace))
  return space?.project ?? null
}

function currentProject(): Project | null {
  const space = read(workspaces).find((entry) => entry.id === read(selectedWorkspace))
  const key = projectKey(space)
  if (!key) return null
  return (
    read(projects).find((project) => project.id === key) ?? {
      id: key,
      name: space?.project ?? key,
      path: space?.path ?? '',
      hostId: null
    }
  )
}

function scopeLabel(pipeline: Pipeline): string {
  if (!pipelineProjectKey(pipeline)) return 'Every workspace'
  return (
    read(projects).find((project) => project.id === pipeline.projectId)?.name ??
    pipeline.projectName ??
    'One repo'
  )
}

/** One run: its stages are the links into the agent's terminal, plus its own controls. */
function RunCard({ run }: { run: Run }) {
  const stage = run.stages[run.stageIndex]
  const done = run.stages.filter((item) => item.status === 'done').length
  const running = run.status === 'running'
  const blocked = run.status === 'blocked'
  const text = read(outputs)[run.id]
  const tried = run.triedModels ?? []
  const percent =
    run.stages.length === 0 ? 0 : Math.round((done / run.stages.length) * 100)

  return (
    <Collapsible
      title={run.pipelineName}
      description={`${run.workspaceName} · ${done}/${run.stages.length} stages · ${run.status}`}
      defaultOpen={running || blocked}
    >
      <Stack gap="sm">
        <Row justify="between" align="center" gap="sm" wrap>
          <Row gap="xs" align="center" wrap>
            <Badge tone={RUN_TONES[run.status]}>{run.status}</Badge>
            <Text size="xs" muted>
              {`${done} of ${run.stages.length} stages · ${runElapsed(run)}`}
            </Text>
          </Row>
          <Row gap="xs" align="center">
            <Button
              variant="outline"
              size="sm"
              icon="open-external"
              tooltip="Show this run's terminal in Orca"
              onPress={() => openRun(run)}
            >
              Open terminal
            </Button>
            {run.sessionId && canResume(run.agent) ? (
              <Button
                variant="outline"
                size="sm"
                icon="link"
                tooltip="Open the agent session in its own tab"
                onPress={() => openSession(run)}
              >
                New tab
              </Button>
            ) : null}
          </Row>
        </Row>

        {blocked ? (
          <Callout tone="warning" title="Needs you">
            <Text size="sm">{stage?.note ?? 'The agent is waiting for you in its terminal.'}</Text>
          </Callout>
        ) : null}
        {run.status === 'failed' ? (
          <Callout tone="danger" title="Stage failed">
            <Text size="sm">{stage?.note ?? 'The agent reported a failed turn.'}</Text>
          </Callout>
        ) : null}
        {run.status === 'stopped' ? (
          <Callout tone="neutral" title="Stopped">
            <Text size="sm">This run was stopped. Retry its stage or remove it.</Text>
          </Callout>
        ) : null}

        <Progress label="Stage progress" labelHidden value={percent} />

        <List label={`Stages of ${run.pipelineName} in ${run.workspaceName}`}>
          {run.stages.map((item, index) => (
            <ListItem
              key={item.stageId}
              icon={stageIcon(item.status)}
              title={`${index + 1}. ${stageName(run, item.stageId)}`}
              description={stageDescription(item)}
              current={index === run.stageIndex}
              onPress={() => loadOutput(run)}
            />
          ))}
        </List>

        <Row gap="xs" wrap align="center">
          {running ? (
            <Button variant="outline" icon="stop" onPress={() => control('run.stop', run.id)}>
              Stop
            </Button>
          ) : null}
          {blocked ? (
            <Button icon="next" onPress={() => control('run.resume', run.id)}>
              Carry on
            </Button>
          ) : null}
          {!running ? (
            <Button variant="ghost" icon="refresh" onPress={() => control('run.retry', run.id)}>
              Retry stage
            </Button>
          ) : null}
          {!running && run.status !== 'done' ? (
            <Button variant="ghost" icon="next" onPress={() => control('run.skip', run.id)}>
              Skip stage
            </Button>
          ) : null}
          <Button variant="ghost" icon="terminal" onPress={() => loadOutput(run)}>
            {text === undefined ? 'See output' : 'Refresh output'}
          </Button>
          {!running && !blocked ? (
            <Button
              variant="ghost"
              tone="danger"
              icon="delete"
              onPress={() => control('run.remove', run.id)}
            >
              Remove
            </Button>
          ) : null}
        </Row>

        {text !== undefined ? (
          <Box border radius="md" background="muted" padding="sm">
            <Stack gap="sm">
              <Row justify="between" align="center">
                <Stack gap="none">
                  <Text size="sm" weight="medium">
                    Terminal output
                  </Text>
                  <Text size="xs" muted>
                    {stageName(run, stage?.stageId ?? '') || 'The agent session'}
                  </Text>
                </Stack>
                <Row gap="xs" align="center">
                  <IconButton
                    icon="open-external"
                    label="Show this terminal in Orca"
                    variant="ghost"
                    onPress={() => openRun(run)}
                  />
                  <IconButton
                    icon="refresh"
                    label="Refresh the terminal output"
                    variant="ghost"
                    onPress={() => refreshOutput(run)}
                  />
                  <IconButton
                    icon="close"
                    label="Hide the terminal output"
                    variant="ghost"
                    onPress={() => closeOutput(run)}
                  />
                </Row>
              </Row>
              <CodeView code={text} label="Terminal output" maxHeight="md" wrap />
            </Stack>
          </Box>
        ) : null}

        <Row justify="between" align="center" gap="sm" wrap>
          <Text size="xs" muted>
            {'Started '}
            <RelativeTime at={run.startedAt} format="short" muted />
            {` with ${run.agent}${run.model ? ` · ${run.model}` : ''}${
              tried.length > 1 ? ` · tried ${tried.join(' → ')}` : ''
            }`}
          </Text>
          {run.stages.some((item) => item.tail) ? (
            <Text size="xs" muted>
              {`Last stage kept ${run.stages.filter((item) => item.tail).length} terminal tail${
                run.stages.filter((item) => item.tail).length === 1 ? '' : 's'
              }`}
            </Text>
          ) : null}
        </Row>
      </Stack>
    </Collapsible>
  )
}

function RunTab() {
  const list = read(pipelines)
  const spaces = read(workspaces)
  const all = read(runs)
  const workspaceId = read(selectedWorkspace)
  const limit = read(maxParallelRuns)
  const active = all.filter((run) => run.status === 'running' || run.status === 'blocked').length
  const blocked = all.filter((run) => run.status === 'blocked').length
  const full = active >= limit
  const live = all.filter((run) => run.status === 'running' || run.status === 'blocked')
  const finished = all.filter((run) => run.status !== 'running' && run.status !== 'blocked')
  const space = spaces.find((entry) => entry.id === workspaceId)
  const key = projectKey(space)
  const applicable = list.filter((entry) => appliesTo(entry, key, space?.project ?? null))
  const chosen =
    applicable.find((entry) => entry.id === read(selectedPipeline)) ?? applicable[0] ?? null
  const project = currentProject()

  function startRun(): void {
    if (!chosen || !workspaceId) return
    void attempt(async () => {
      const answer = await plugin.request('run.start', {
        pipelineId: chosen.id,
        workspaceId,
        task: read(task)
      })
      // The worker also posts `runs.changed` with this run; without the filter the list holds it
      // twice and the parallel count goes wrong.
      set(runs, [answer.run, ...read(runs).filter((entry) => entry.id !== answer.run.id)])
    })
  }

  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm" wrap>
        <Stack gap="none">
          <Heading level={2}>Runs</Heading>
          <Text size="xs" muted>
            {project ? `${selectedProjectName() ?? 'This repo'}` : 'Every workspace'}
          </Text>
        </Stack>
        <Row gap="xs" align="center">
          <Badge tone={blocked > 0 ? 'warning' : active > 0 ? 'accent' : 'neutral'}>
            {active === 0
              ? 'idle'
              : blocked > 0
                ? `${active} active · ${blocked} need you`
                : `${active} of ${limit} running`}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            tooltip="Refresh workspaces and pipelines"
            disabled={read(busy)}
            onPress={refreshNow}
          >
            Refresh
          </Button>
        </Row>
      </Row>

      {spaces.length === 0 ? (
        <Callout tone="warning" title="No workspace">
          <Text size="sm">
            Open a worktree or folder in Orca, then press Refresh. Runs need a workspace to type
            into.
          </Text>
        </Callout>
      ) : (
        <Box border radius="md" background="card" padding="sm">
          <Stack gap="sm">
            <Text weight="medium">New run</Text>
            <Select
              label="Workspace"
              value={workspaceId}
              options={spaces.map((space) => ({
                value: space.id,
                label: space.branch ? `${space.name} · ${space.branch}` : space.name
              }))}
              onChange={(value) => set(selectedWorkspace, value)}
            />

            {list.length === 0 ? (
              <Callout tone="warning" title="No pipeline yet">
                <Stack gap="xs">
                  <Text size="sm">
                    Write one first: a name, an agent and the prompts that run in order.
                  </Text>
                  <Row>
                    <Button variant="outline" icon="add" onPress={() => newPipeline(project)}>
                      New pipeline
                    </Button>
                  </Row>
                </Stack>
              </Callout>
            ) : applicable.length === 0 ? (
              <Callout tone="warning" title="No pipeline for this repo">
                <Stack gap="xs">
                  <Text size="sm">
                    {`${project?.name ?? 'This repo'} has no pipelines of its own, and the ones you saved belong to other repos.`}
                  </Text>
                  <Row>
                    <Button variant="outline" icon="add" onPress={() => newPipeline(project)}>
                      {`New pipeline for ${project?.name ?? 'this repo'}`}
                    </Button>
                  </Row>
                </Stack>
              </Callout>
            ) : (
              <Select
                label="Pipeline"
                value={chosen?.id ?? ''}
                options={applicable.map((entry) => {
                  const repeated =
                    applicable.filter((other) => other.name === entry.name).length > 1
                  return {
                    value: entry.id,
                    label: repeated ? `${entry.name} · ${scopeLabel(entry)}` : entry.name
                  }
                })}
                onChange={(value) => {
                  set(selectedPipeline, value)
                  set(editing, null)
                }}
              />
            )}

            {chosen ? (
              <Box background="muted" radius="sm" padding="sm">
                <Stack gap="xs">
                  <Row gap="xs" align="center" wrap>
                    <Text size="xs" muted>
                      {`${chosen.stages.length} stages · ${chosen.agent} · ${scopeLabel(chosen)}`}
                    </Text>
                  </Row>
                  <Text size="xs" muted truncate>
                    {chosen.stages.map((stage) => stage.name).join(' → ') || 'No stages yet'}
                  </Text>
                </Stack>
              </Box>
            ) : null}

            <Textarea
              label="Task"
              rows={3}
              placeholder="What should the pipeline build, fix or review?"
              value={read(task)}
              onChange={(value) => set(task, value)}
              onSubmit={() => {
                if (!read(busy) && !full) startRun()
              }}
            />

            <Row gap="xs" wrap align="center">
              <Button
                icon="play"
                onPress={startRun}
                disabled={read(busy) || full || !chosen || !workspaceId}
              >
                Run
              </Button>
              <Text size="xs" muted>
                {full
                  ? `${limit} at a time is the limit; stop one to start another, or raise it in Settings.`
                  : 'Cmd+Enter starts it. Every run gets its own agent and terminal.'}
              </Text>
            </Row>
          </Stack>
        </Box>
      )}

      {all.length === 0 ? (
        <EmptyState
          title="No run yet"
          description="Pick a pipeline and a workspace, describe the task, then press Run. Runs overlap, each with its own agent."
          icon="layers"
        />
      ) : (
        <Stack gap="md">
          {live.length > 0 ? (
            <Stack gap="sm">
              <Row justify="between" align="center">
                <Text weight="medium">Live</Text>
                <Text size="xs" muted>
                  {`${live.length} of ${limit}`}
                </Text>
              </Row>
              {live.map((entry) => (
                <RunCard key={entry.id} run={entry} />
              ))}
            </Stack>
          ) : null}
          {finished.length > 0 ? (
            <Stack gap="sm">
              <Row justify="between" align="center">
                <Text weight="medium">Finished</Text>
                <Text size="xs" muted>
                  {`${finished.length} kept`}
                </Text>
              </Row>
              {finished.map((entry) => (
                <RunCard key={entry.id} run={entry} />
              ))}
            </Stack>
          ) : null}
        </Stack>
      )}
    </Stack>
  )
}

export function reasoningOptions(current: Record<Reasoning, { agent: string; model: string }>) {
  const one = (level: Reasoning, title: string) => ({
    value: level,
    label: `${title} — ${current[level].model || 'no model set'}`
  })
  return [
    // Orca refuses an empty option value (requiredLabel is min(1)), so "inherit" is a sentinel.
    { value: 'inherit', label: 'Inherit — the pipeline’s level, then the agent default' },
    one('high', 'High'),
    one('medium', 'Medium'),
    one('low', 'Low')
  ]
}

const LEVELS = [
  {
    level: 'high',
    title: 'High reasoning',
    hint: 'Planning, review and judgement calls.'
  },
  {
    level: 'medium',
    title: 'Medium reasoning',
    hint: 'Building, running a checklist, writing a report.'
  },
  {
    level: 'low',
    title: 'Low reasoning',
    hint: 'Cheap verification and environment setup.'
  }
] as const

/** The settings, editable where the runs are, instead of a trip to Settings → Plugins. */
function SettingsTab() {
  const values = read(settingsDraft)
  const field = (key: string, label: string, placeholder?: string) => (
    <Input
      label={label}
      value={values[key] ?? ''}
      placeholder={placeholder}
      onChange={(value) => editSetting(key, value)}
    />
  )
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Settings</Heading>
        <Button variant="ghost" size="sm" icon="refresh" onPress={() => void attempt(loadSettings)}>
          Reload
        </Button>
      </Row>
      <Callout tone="neutral" title="How a stage picks its agent and model">
        <Text size="sm">
          A pipeline sets a default level for its stages; a stage can set its own. An explicit agent
          or model always wins over a level.
        </Text>
      </Callout>
      <Text weight="medium">Reasoning levels</Text>
      {LEVELS.map(({ level, title, hint }) => (
        <Box key={level} border radius="md" padding="sm">
          <Stack gap="sm">
            <Stack gap="none">
              <Text weight="medium">{title}</Text>
              <Text size="xs" muted>
                {hint}
              </Text>
            </Stack>
            {field(`${level}Agent`, 'Agent', 'opencode')}
            {field(`${level}Model`, 'Model', 'provider/model')}
          </Stack>
        </Box>
      ))}
      <Separator />
      <Text weight="medium">Runs</Text>
      {field('defaultAgent', 'Default agent', 'the agent in your focused workspace')}
      {field('maxParallelRuns', 'Runs at a time (1–8)', '5')}
      {field('stageTimeoutMinutes', 'Stage timeout (minutes)', '20')}
      {field('modelBootSeconds', 'Model boot wait (seconds)', '8')}
      <Switch
        label="Desktop notifications"
        checked={values.notify === 'true'}
        onChange={(checked) => editSetting('notify', String(checked))}
      />
      <Row gap="xs" align="center">
        <Button icon="check" onPress={saveSettings} disabled={read(busy)}>
          Save settings
        </Button>
      </Row>
      {read(settingsSaved) ? (
        <Callout tone="success" title="Saved">
          <Text size="sm">The next stage uses these; a run already going keeps its current model.</Text>
        </Callout>
      ) : null}
    </Stack>
  )
}

/** Groups the saved pipelines by scope, the current repo first, then every workspace. */
function pipelineGroups(list: Pipeline[], known: Project[], current: string | null) {
  const groups: { id: string; title: string; items: Pipeline[] }[] = []
  const scoped = new Map<string, Pipeline[]>()
  const global: Pipeline[] = []
  for (const entry of list) {
    const scope = pipelineProjectKey(entry)
    if (!scope) {
      global.push(entry)
      continue
    }
    scoped.set(scope, [...(scoped.get(scope) ?? []), entry])
  }
  for (const [id, items] of scoped) {
    const title = known.find((project) => project.id === id)?.name ?? items[0]?.projectName ?? id
    groups.push({ id, title, items })
  }
  groups.sort((left, right) => {
    if (left.id === current) return -1
    if (right.id === current) return 1
    return left.title.localeCompare(right.title)
  })
  if (global.length > 0) groups.push({ id: 'every', title: 'Every workspace', items: global })
  return groups
}

/** Whether the draft differs from the saved pipeline (a new one always does). */
function hasChanges(draft: Pipeline): boolean {
  const saved = read(pipelines).find((entry) => entry.id === draft.id)
  if (!saved) return true
  if (saved.name !== draft.name || saved.agent !== draft.agent) return true
  if ((saved.reasoning ?? null) !== (draft.reasoning ?? null)) return true
  if ((saved.projectId ?? null) !== (draft.projectId ?? null)) return true
  if (saved.stages.length !== draft.stages.length) return true
  return draft.stages.some((stage, index) => {
    const other = saved.stages[index]
    if (!other || other.id !== stage.id) return true
    return (
      other.name !== stage.name ||
      other.prompt !== stage.prompt ||
      (other.reasoning ?? null) !== (stage.reasoning ?? null) ||
      (other.agent ?? '') !== (stage.agent ?? '') ||
      (other.model ?? '') !== (stage.model ?? '') ||
      (other.attempts ?? null) !== (stage.attempts ?? null) ||
      (other.fallbacks ?? []).join(',') !== (stage.fallbacks ?? []).join(',')
    )
  })
}

function PipelinesTab() {
  const list = read(pipelines)
  const known = read(projects)
  const open = read(editing)
  const project = currentProject()
  // Nothing chosen yet: show the selected pipeline rather than an empty list. 'closed' means the
  // person cancelled and wants the list only.
  const draft =
    open === 'closed' ? null : (open ?? list.find((e) => e.id === read(selectedPipeline)) ?? null)
  const groups = pipelineGroups(list, known, project?.id ?? null)
  const changed = draft ? hasChanges(draft) : false
  const agents = AGENT_CHOICES.filter((choice) => {
    const installed = read(availableAgents)
    // Until the machine reports anything, show the catalog rather than nothing.
    return (
      installed.length === 0 || installed.includes(choice.id) || choice.id === draft?.agent
    )
  })

  function pick(entry: Pipeline): void {
    set(editing, entry)
    set(selectedPipeline, entry.id)
    set(agentPicker, false)
    set(deleteArmed, false)
  }

  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm" wrap>
        <Stack gap="none">
          <Heading level={2}>Pipelines</Heading>
          <Text size="xs" muted>
            {project
              ? `Saved flows for ${project.name} and every workspace`
              : 'Saved flows for every workspace'}
          </Text>
        </Stack>
        <Row gap="xs" align="center">
          <IconButton
            icon="refresh"
            label="Refresh workspaces and pipelines"
            variant="ghost"
            disabled={read(busy)}
            onPress={refreshNow}
          />
          {project ? (
            <Button variant="ghost" icon="add" onPress={() => newPipeline(project)}>
              {`For ${project.name}`}
            </Button>
          ) : null}
          <Button icon="add" onPress={() => newPipeline(null)}>
            New
          </Button>
        </Row>
      </Row>

      {list.length === 0 ? (
        <EmptyState
          title="No pipelines"
          description="Create one to get started: a name, an agent, and the prompts that run in order."
          icon="layers"
        />
      ) : (
        <Stack gap="sm">
          {groups.map((group) => (
            <Stack gap="xs" key={group.id}>
              <Text size="xs" muted>
                {group.title}
              </Text>
              <List label={group.title}>
                {group.items.map((entry) => (
                  <ListItem
                    key={entry.id}
                    title={entry.name}
                    description={`${entry.stages.length} stages · ${entry.agent}${
                      pipelineProjectKey(entry) ? ' · repo' : ''
                    }`}
                    current={draft ? draft.id === entry.id : read(selectedPipeline) === entry.id}
                    onPress={() => pick(entry)}
                  />
                ))}
              </List>
            </Stack>
          ))}
        </Stack>
      )}

      {draft ? (
        <Stack gap="md">
          <Separator />
          <Row justify="between" align="center" gap="sm" wrap>
            <Stack gap="none">
              <Row gap="xs" align="center">
                <Heading level={3}>{draft.name.trim() || 'New pipeline'}</Heading>
                {changed ? <Badge tone="accent">unsaved</Badge> : null}
              </Row>
              <Text size="xs" muted>
                {`${scopeLabel(draft)} · ${draft.stages.length} stages · ${draft.stages
                  .map((stage) => stage.name)
                  .join(' → ')}`}
              </Text>
            </Stack>
            <Row gap="xs" align="center">
              <IconButton
                icon="copy"
                label="Duplicate this pipeline"
                variant="ghost"
                onPress={() => duplicatePipeline(draft)}
              />
              <IconButton
                icon="check"
                label="Save this pipeline"
                variant="outline"
                disabled={read(busy) || !draft.name.trim() || !changed}
                onPress={savePipeline}
              />
              <IconButton
                icon="close"
                label="Close the editor"
                variant="ghost"
                onPress={() => {
                  set(deleteArmed, false)
                  set(editing, 'closed')
                }}
              />
            </Row>
          </Row>

          <Input
            label="Name"
            value={draft.name}
            onChange={(value) => set(editing, { ...draft, name: value })}
          />
          <Select
            label="Applies to"
            value={draft.projectId ?? 'any'}
            options={[
              { value: 'any', label: 'Every workspace — one flow for every repo' },
              ...known.map((entry) => ({ value: entry.id, label: entry.name })),
              ...(draft.projectId && !known.some((entry) => entry.id === draft.projectId)
                ? [{ value: draft.projectId, label: draft.projectName ?? draft.projectId }]
                : [])
            ]}
            onChange={(value) => {
              const chosen = known.find((entry) => entry.id === value)
              set(editing, {
                ...draft,
                projectId: value === 'any' ? null : value,
                projectName: value === 'any' ? null : (chosen?.name ?? draft.projectName ?? null)
              })
            }}
          />
          <Text size="xs" muted>
            A repo pipeline only appears when its repo&apos;s workspace is selected; use it for
            commands, checks and review lenses that make sense in that product alone.
          </Text>
          <Field label="Agent">
            <Stack gap="sm">
              <Row gap="xs" align="center">
                <Button
                  variant="outline"
                  icon={agentIcon(draft.agent)}
                  onPress={() => set(agentPicker, !read(agentPicker))}
                >
                  {draft.agent.trim() || 'Choose an agent'}
                </Button>
                <IconButton
                  icon={read(agentPicker) ? 'collapse' : 'expand'}
                  label={read(agentPicker) ? 'Hide the agent list' : 'Show the agent list'}
                  variant="ghost"
                  onPress={() => set(agentPicker, !read(agentPicker))}
                />
              </Row>
              {read(agentPicker) ? (
                <List label="Installed agents">
                  {agents.map((choice) => (
                    <ListItem
                      key={choice.id}
                      icon={choice.icon as IconName}
                      title={choice.id}
                      current={choice.id === draft.agent}
                      onPress={() => {
                        set(editing, { ...draft, agent: choice.id })
                        set(agentPicker, false)
                      }}
                    />
                  ))}
                </List>
              ) : null}
            </Stack>
          </Field>
          <Input
            label="Or another agent id"
            value={draft.agent}
            placeholder="claude"
            onChange={(value) => set(editing, { ...draft, agent: value })}
          />
          <Select
            label="Reasoning for its stages"
            value={draft.reasoning ?? 'inherit'}
            options={reasoningOptions(read(levels))}
            onChange={(value) =>
              set(editing, {
                ...draft,
                reasoning: value === 'inherit' ? undefined : (value as Reasoning)
              })
            }
          />
          <Text size="xs" muted>
            Only agents installed on this machine are listed. Any other agent id Orca can launch
            works in the field above, and the list marks whichever one is set.
          </Text>
          <Text size="xs" muted>
            Each stage sends one prompt to the same agent session. Write {'{{task}}'} where the
            task typed in the Run tab belongs; the first stage gets it prepended when it has none.
          </Text>

          <Row justify="between" align="center" gap="sm">
            <Text weight="medium">Stages</Text>
            <Button variant="outline" icon="add" onPress={addStage}>
              Add stage
            </Button>
          </Row>

          {draft.stages.map((stage, index) => {
            const advanced = Boolean(
              stage.agent?.trim() ||
                stage.model?.trim() ||
                (stage.fallbacks ?? []).length > 0 ||
                stage.attempts !== undefined
            )
            return (
              <Collapsible
                key={stage.id}
                title={`${index + 1}. ${stage.name || 'Untitled stage'}`}
                description={trimmed(stage.prompt, 70) || 'No prompt yet'}
                defaultOpen={index === 0}
              >
                <Stack gap="sm">
                  <Input
                    label="Stage name"
                    value={stage.name}
                    onChange={(value) => editStage(index, { name: value })}
                  />
                  <Textarea
                    label="Prompt"
                    rows={6}
                    placeholder="Write the prompt. Use {{task}} where the task typed in the Run tab belongs."
                    value={stage.prompt}
                    onChange={(value) => editStage(index, { prompt: value })}
                  />
                  <Select
                    label="Reasoning"
                    value={stage.reasoning ?? 'inherit'}
                    options={reasoningOptions(read(levels))}
                    onChange={(value) =>
                      editStage(index, {
                        reasoning: value === 'inherit' ? undefined : (value as Reasoning)
                      })
                    }
                  />
                  <Text size="xs" muted>
                    Levels and the agent behind each one live in the Settings tab.
                  </Text>
                  <Collapsible
                    title="Model and retries"
                    description={
                      advanced
                        ? 'This stage overrides its agent, model or retries'
                        : 'Optional: a specific agent, model or fallback chain'
                    }
                    defaultOpen={advanced}
                  >
                    <Stack gap="sm">
                      <Input
                        label="Agent override"
                        placeholder="the pipeline's agent"
                        value={stage.agent ?? ''}
                        onChange={(value) => editStage(index, { agent: value })}
                      />
                      <Input
                        label="Model"
                        placeholder="the agent's own default"
                        value={stage.model ?? ''}
                        onChange={(value) => editStage(index, { model: value })}
                      />
                      <Input
                        label="Fallback models"
                        placeholder="model-b, model-c"
                        value={(stage.fallbacks ?? []).join(', ')}
                        onChange={(value) =>
                          editStage(index, {
                            fallbacks: value
                              .split(',')
                              .map((model) => model.trim())
                              .filter(Boolean)
                          })
                        }
                      />
                      <Input
                        label="Tries per model"
                        placeholder="2"
                        value={stage.attempts === undefined ? '' : String(stage.attempts)}
                        onChange={(value) => {
                          const tries = Number(value.trim())
                          editStage(index, {
                            attempts:
                              value.trim() === '' || !Number.isFinite(tries) ? undefined : tries
                          })
                        }}
                      />
                      <Text size="xs" muted>
                        A stage with a model starts its own agent process with {'`--model`'}, so it
                        does not share the previous stage&apos;s session. Failures move on to the
                        next model after the tries it is given.
                      </Text>
                    </Stack>
                  </Collapsible>
                  <Row justify="between" align="center" gap="sm">
                    <Row gap="xs" align="center">
                      <Button
                        size="sm"
                        variant="ghost"
                        tooltip="Move this stage earlier"
                        disabled={index === 0}
                        onPress={() => moveStage(index, -1)}
                      >
                        Up
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        tooltip="Move this stage later"
                        disabled={index === draft.stages.length - 1}
                        onPress={() => moveStage(index, 1)}
                      >
                        Down
                      </Button>
                    </Row>
                    <IconButton
                      icon="delete"
                      label={`Remove stage ${index + 1}`}
                      variant="ghost"
                      tone="danger"
                      disabled={draft.stages.length === 1}
                      onPress={() => removeStage(index)}
                    />
                  </Row>
                </Stack>
              </Collapsible>
            )
          })}

          {read(deleteArmed) ? (
            <Callout tone="danger" title="Delete this pipeline?">
              <Text size="sm">
                It disappears from every workspace. Press Confirm delete to finish; Cancel keeps it.
              </Text>
            </Callout>
          ) : null}

          <Row gap="xs" wrap align="center">
            <Button icon="check" onPress={savePipeline} disabled={read(busy) || !draft.name.trim() || !changed}>
              Save
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                set(deleteArmed, false)
                set(editing, 'closed')
              }}
            >
              Cancel
            </Button>
            <Button
              variant="ghost"
              tone="danger"
              icon="delete"
              onPress={removePipeline}
              disabled={read(busy)}
            >
              {read(deleteArmed) ? 'Confirm delete' : 'Delete'}
            </Button>
          </Row>
        </Stack>
      ) : list.length > 0 ? (
        <EmptyState
          title="Pick a pipeline"
          description="Choose one above to edit its stages, or press New to write another."
          icon="layers"
        />
      ) : null}
    </Stack>
  )
}

export default function Panel() {
  const noticeValue = read(notice)
  return (
    <Stack gap="md">
      <Tabs label="Pipeline" value={read(tab)} onChange={(value) => set(tab, value)}>
        <Tab value="run" label="Run" icon="play">
          <RunTab />
        </Tab>
        <Tab value="pipelines" label="Pipelines" icon="layers">
          <PipelinesTab />
        </Tab>
        <Tab value="settings" label="Settings" icon="settings">
          <SettingsTab />
        </Tab>
      </Tabs>
      {noticeValue ? (
        <Callout tone={noticeValue.tone} title={noticeValue.title}>
          <Row justify="between" align="center" gap="sm">
            <Text size="sm">{noticeValue.text}</Text>
            <IconButton
              icon="close"
              label="Dismiss this message"
              variant="ghost"
              size="sm"
              onPress={() => set(notice, null)}
            />
          </Row>
        </Callout>
      ) : null}
    </Stack>
  )
}
