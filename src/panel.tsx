// The panel: pick a pipeline and a workspace, type the task, run. A second tab edits the
// pipelines themselves. All state that must outlive a save lives in atoms or the worker.
import {
  atom,
  Badge,
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
  plugin,
  read,
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
import type {
  Pipeline,
  Reasoning,
  Run,
  Stage,
  StageState,
  StageStatus,
  Workspace
} from './protocol'

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
const tab = atom('tab', 'run')
const editing = atom<Pipeline | null>(null)
const notice = atom<string | null>(null)
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

const TONES: Record<StageStatus, Tone> = {
  pending: 'neutral',
  running: 'accent',
  done: 'success',
  blocked: 'warning',
  failed: 'danger',
  skipped: 'neutral'
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
    set(notice, messageOf(error))
  } finally {
    set(busy, false)
  }
}

async function refresh(): Promise<void> {
  const state = await plugin.request('run.state')
  set(pipelines, state.pipelines)
  set(runs, state.runs)
  set(defaultAgent, state.defaultAgent)
  set(maxParallelRuns, state.maxParallelRuns)
  set(availableAgents, state.availableAgents ?? [])
  set(levels, state.levels)
  const listed = await plugin.request('workspaces.list')
  set(workspaces, listed.workspaces)
  if (read(selectedPipeline) === '' && state.pipelines[0]) {
    set(selectedPipeline, state.pipelines[0].id)
  }
  if (read(selectedWorkspace) === '' && listed.workspaces[0]) {
    // Prefer the workspace the person is looking at.
    let focused = ''
    try {
      const context = await host.call('workspace.readContext')
      if (context) {
        const match = listed.workspaces.find((entry) => entry.name === context.displayName)
        focused = match?.id ?? ''
      }
    } catch {
      // Without a focused workspace the first one will do.
    }
    set(selectedWorkspace, focused || listed.workspaces[0].id)
  }
}

function startRun(): void {
  void attempt(async () => {
    const answer = await plugin.request('run.start', {
      pipelineId: read(selectedPipeline),
      workspaceId: read(selectedWorkspace),
      task: read(task)
    })
    // The worker also posts `runs.changed` with this run; without the filter the list holds it
    // twice and the parallel count goes wrong.
    set(runs, [answer.run, ...read(runs).filter((entry) => entry.id !== answer.run.id)])
  })
}

/** Reads one run's live terminal, and opens its viewer. */
function openOutput(run: Run): void {
  void attempt(async () => {
    const answer = await plugin.request('run.output', { runId: run.id, maxLines: 400 })
    set(outputs, {
      ...read(outputs),
      [run.id]: answer.text ?? 'Nothing in that terminal yet.'
    })
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

function pickPipeline(id: string): void {
  set(selectedPipeline, id)
  set(editing, null)
}

function newPipeline(): void {
  set(agentPicker, false)
  set(editing, {
    id: `pipeline-${Date.now()}`,
    name: 'New pipeline',
    agent: read(defaultAgent) || 'claude',
    stages: [{ id: `stage-${Date.now()}`, name: 'Plan', prompt: '' }]
  })
}

function editStage(index: number, patch: Partial<Stage>): void {
  const draft = read(editing)
  if (!draft) return
  set(editing, {
    ...draft,
    stages: draft.stages.map((stage, at) => (at === index ? { ...stage, ...patch } : stage))
  })
}

function addStage(): void {
  const draft = read(editing)
  if (!draft) return
  const at = draft.stages.length + 1
  set(editing, {
    ...draft,
    stages: [
      ...draft.stages,
      { id: `stage-${Date.now()}`, name: `Stage ${at}`, prompt: '' }
    ]
  })
}

function removeStage(index: number): void {
  const draft = read(editing)
  if (!draft) return
  set(editing, { ...draft, stages: draft.stages.filter((_, at) => at !== index) })
}

function savePipeline(): void {
  void attempt(async () => {
    const draft = read(editing)
    if (!draft) return
    const saved = await plugin.request('pipelines.save', { pipeline: draft })
    set(pipelines, saved.pipelines)
    set(selectedPipeline, draft.id)
    set(editing, null)
  })
}

function removePipeline(): void {
  void attempt(async () => {
    const draft = read(editing)
    if (!draft) return
    const saved = await plugin.request('pipelines.remove', { id: draft.id })
    set(pipelines, saved.pipelines)
    if (read(selectedPipeline) === draft.id) set(selectedPipeline, saved.pipelines[0]?.id ?? '')
    set(editing, null)
  })
}

/** Runs once before the first render; `ctx.subscriptions` end with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('runs.changed', (payload) => set(runs, payload.runs)))
  ctx.subscriptions.push(
    plugin.on('pipelines.changed', (payload) => set(pipelines, payload.pipelines))
  )
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

function stageDescription(stage: StageState): string {
  const took =
    stage.startedAt === null
      ? ''
      : stage.endedAt === null
        ? ' · running'
        : ` · ${Math.max(1, Math.round((stage.endedAt - stage.startedAt) / 1000))}s`
  return `${stage.status}${took}${stage.note ? ` · ${stage.note}` : ''}`
}

/** One run: its stages are the links into the agent's terminal, plus its own controls. */
function RunCard({ run }: { run: Run }) {
  const stage = run.stages[run.stageIndex]
  const done = run.stages.filter((item) => item.status === 'done').length
  const running = run.status === 'running'
  const blocked = run.status === 'blocked'
  const text = read(outputs)[run.id]
  const tried = run.triedModels ?? []
  return (
    <Collapsible
      title={run.pipelineName}
      description={`${run.workspaceName} · ${done}/${run.stages.length} stages · ${run.status}`}
      defaultOpen={running || blocked}
    >
      <Stack gap="sm">
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

        <List label={`Stages of ${run.pipelineName} in ${run.workspaceName}`}>
          {run.stages.map((item, index) => (
            <ListItem
              key={item.stageId}
              icon={stageIcon(item.status)}
              title={`${index + 1}. ${stageName(run, item.stageId)}`}
              description={stageDescription(item)}
              current={index === run.stageIndex}
              onPress={() => openOutput(run)}
            />
          ))}
        </List>

        <Row gap="xs" wrap>
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
          <Button variant="ghost" icon="terminal" onPress={() => openOutput(run)}>
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
          <CodeView code={text} label="Terminal output" maxHeight="md" wrap />
        ) : null}

        <Text size="xs" muted>
          {`Started ${new Date(run.startedAt).toLocaleTimeString()} with ${run.agent}${
            run.model ? ` · ${run.model}` : ''
          }${tried.length > 1 ? ` · tried ${tried.join(' → ')}` : ''}`}
        </Text>
      </Stack>
    </Collapsible>
  )
}

function RunTab() {
  const list = read(pipelines)
  const spaces = read(workspaces)
  const all = read(runs)
  const pipelineId = read(selectedPipeline)
  const workspaceId = read(selectedWorkspace)
  const limit = read(maxParallelRuns)
  const active = all.filter((run) => run.status === 'running' || run.status === 'blocked').length
  const blocked = all.filter((run) => run.status === 'blocked').length
  const full = active >= limit

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Pipeline</Heading>
        <Badge tone={blocked > 0 ? 'warning' : active > 0 ? 'accent' : 'neutral'}>
          {active === 0
            ? 'idle'
            : blocked > 0
              ? `${active} active · ${blocked} need you`
              : `${active} of ${limit} running`}
        </Badge>
      </Row>

      {spaces.length === 0 ? (
        <Callout tone="warning" title="No workspace">
          <Text size="sm">Open a worktree or folder in Orca, then reopen this panel.</Text>
        </Callout>
      ) : (
        <Select
          label="Workspace"
          value={workspaceId}
          options={spaces.map((space) => ({
            value: space.id,
            label: space.branch ? `${space.name} · ${space.branch}` : space.name
          }))}
          onChange={(value) => set(selectedWorkspace, value)}
        />
      )}

      <Select
        label="Pipeline"
        value={pipelineId}
        options={list.map((entry) => ({ value: entry.id, label: entry.name }))}
        onChange={(value) => set(selectedPipeline, value)}
      />

      <Textarea
        label="Task"
        rows={3}
        placeholder="What should the pipeline build, fix or review?"
        value={read(task)}
        onChange={(value) => set(task, value)}
      />

      <Row gap="xs" wrap align="center">
        <Button
          icon="play"
          onPress={startRun}
          disabled={read(busy) || full || !pipelineId || !workspaceId}
        >
          Run
        </Button>
        {full ? (
          <Text size="xs" muted>
            {`${limit} at a time is the limit; stop one to start another, or raise it in Settings.`}
          </Text>
        ) : null}
      </Row>

      {all.length === 0 ? (
        <EmptyState
          title="No run yet"
          description="Pick a pipeline and a workspace, describe the task, then press Run. Runs overlap, each with its own agent."
          icon="layers"
        />
      ) : (
        <Stack gap="sm">
          {all.map((entry) => (
            <RunCard key={entry.id} run={entry} />
          ))}
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
    { value: '', label: 'Inherit — the pipeline’s level, then the agent default' },
    one('high', 'High'),
    one('medium', 'Medium'),
    one('low', 'Low')
  ]
}

const LEVELS = [
  { level: 'high', title: 'High reasoning' },
  { level: 'medium', title: 'Medium reasoning' },
  { level: 'low', title: 'Low reasoning' }
] as const

/** The nine settings, editable where the runs are, instead of a trip to Settings → Plugins. */
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
      <Heading>Settings</Heading>
      <Text size="xs" muted>
        Each reasoning level names the agent and model a stage gets when it asks for that level.
        A stage can still override either one.
      </Text>
      {LEVELS.map(({ level, title }) => (
        <Stack gap="sm" key={level}>
          <Text weight="medium">{title}</Text>
          {field(`${level}Agent`, 'Agent', 'opencode')}
          {field(`${level}Model`, 'Model', 'provider/model')}
        </Stack>
      ))}
      <Separator />
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
        <Button variant="ghost" icon="refresh" onPress={() => void attempt(loadSettings)}>
          Reload
        </Button>
      </Row>
      {settingsSaved ? (
        <Callout tone="success" title="Saved">
          <Text size="sm">The next stage uses these; a run already going keeps its current model.</Text>
        </Callout>
      ) : null}
    </Stack>
  )
}

function PipelinesTab() {
  const list = read(pipelines)
  const draft = read(editing)

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Pipelines</Heading>
        <Button variant="ghost" icon="add" onPress={newPipeline}>
          New
        </Button>
      </Row>

      {list.length === 0 ? (
        <EmptyState title="No pipelines" description="Create one to get started." icon="layers" />
      ) : (
        <List label="Saved pipelines">
          {list.map((entry) => (
            <ListItem
              key={entry.id}
              title={entry.name}
              description={`${entry.stages.length} stages · ${entry.agent}`}
              current={draft ? draft.id === entry.id : read(selectedPipeline) === entry.id}
              onPress={() => {
                set(editing, entry)
                set(selectedPipeline, entry.id)
                set(agentPicker, false)
              }}
            />
          ))}
        </List>
      )}

      {draft ? (
        <Stack gap="md">
          <Separator />
          <Input
            label="Name"
            value={draft.name}
            onChange={(value) => set(editing, { ...draft, name: value })}
          />
          <Field label="Agent">
            <Stack gap="sm">
              <Row>
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
                  {AGENT_CHOICES.filter((choice) => {
                    const installed = read(availableAgents)
                    // Until the machine reports anything, show the catalog rather than nothing.
                    return (
                      installed.length === 0 ||
                      installed.includes(choice.id) ||
                      choice.id === draft.agent
                    )
                  }).map((choice) => (
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
            value={draft.reasoning ?? ''}
            options={reasoningOptions(read(levels))}
            onChange={(value) =>
              set(editing, {
                ...draft,
                reasoning: value === '' ? undefined : (value as Reasoning)
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
          {draft.stages.map((stage, index) => (
            <Collapsible
              key={stage.id}
              title={`${index + 1}. ${stage.name || 'Untitled stage'}`}
              description={stage.prompt.slice(0, 60) || 'No prompt yet'}
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
                  rows={5}
                  value={stage.prompt}
                  onChange={(value) => editStage(index, { prompt: value })}
                />
                <Select
                  label="Reasoning"
                  value={stage.reasoning ?? ''}
                  options={reasoningOptions(read(levels))}
                  onChange={(value) =>
                    editStage(index, {
                      reasoning: value === '' ? undefined : (value as Reasoning)
                    })
                  }
                />
                <Text size="xs" muted>
                  Levels and the agent behind each one live in the Settings tab.
                </Text>
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
                  A stage with a model starts its own agent process with {'`--model`'}, so it does
                  not share the previous stage&apos;s session. Failures move on to the next model
                  after the tries it is given.
                </Text>
                <Row justify="end">
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
          ))}
          <Row gap="xs" wrap>
            <Button variant="outline" icon="add" onPress={addStage}>
              Add stage
            </Button>
            <Button icon="check" onPress={savePipeline}>
              Save
            </Button>
            <Button variant="ghost" onPress={() => set(editing, null)}>
              Cancel
            </Button>
            <Button variant="ghost" tone="danger" icon="delete" onPress={removePipeline}>
              Delete
            </Button>
          </Row>
        </Stack>
      ) : null}
    </Stack>
  )
}

export default function Panel() {
  const noticeText = read(notice)
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
      {noticeText ? (
        <Callout tone="danger" title="That did not work">
          <Text size="sm">{noticeText}</Text>
        </Callout>
      ) : null}
    </Stack>
  )
}
