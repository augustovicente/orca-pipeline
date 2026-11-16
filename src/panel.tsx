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
  Stack,
  Tab,
  Tabs,
  Table,
  Text,
  Textarea,
  type PanelContext,
  type IconName,
  type TableRow,
  type Tone
} from 'orca'
import type { Pipeline, Run, Stage, StageStatus, Workspace } from './protocol'

/**
 * The agents worth one click. `Select` options cannot carry an icon, so the picker is a button
 * and a List; anything not listed is still reachable through the free-text field beside it.
 */
const AGENT_CHOICES: readonly { id: string; icon: IconName }[] = [
  { id: 'claude', icon: 'bot' },
  { id: 'codex', icon: 'code' },
  { id: 'opencode', icon: 'terminal' },
  { id: 'gemini', icon: 'star' },
  { id: 'copilot', icon: 'cloud' },
  { id: 'cursor', icon: 'file' },
  { id: 'grok', icon: 'zap' },
  { id: 'omp', icon: 'gauge' },
  { id: 'pi', icon: 'activity' },
  { id: 'aider', icon: 'wrench' },
  { id: 'amp', icon: 'lightbulb' },
  { id: 'kiro', icon: 'layers' },
  { id: 'droid', icon: 'package' },
  { id: 'crush', icon: 'hammer' },
  { id: 'qwen-code', icon: 'globe' }
]

function agentIcon(id: string): IconName {
  return AGENT_CHOICES.find((choice) => choice.id === id)?.icon ?? 'agent'
}

const pipelines = atom<Pipeline[]>([])
const run = atom<Run | null>(null)
const workspaces = atom<Workspace[]>([])
const selectedPipeline = atom('selectedPipeline', '', { persist: 'plugin' })
const selectedWorkspace = atom('selectedWorkspace', '', { persist: 'plugin' })
const agentPicker = atom(false)
const task = atom('task', '')
const tab = atom('tab', 'run')
const editing = atom<Pipeline | null>(null)
const notice = atom<string | null>(null)
const busy = atom(false)

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
  set(run, state.run)
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
    set(run, answer.run)
  })
}

function control(name: 'run.stop' | 'run.resume' | 'run.retry' | 'run.skip'): void {
  void attempt(async () => {
    const answer = await plugin.request(name)
    set(run, answer.run)
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
    agent: 'claude',
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
  ctx.subscriptions.push(plugin.on('run.changed', (payload) => set(run, payload.run)))
  ctx.subscriptions.push(
    plugin.on('pipelines.changed', (payload) => set(pipelines, payload.pipelines))
  )
  void attempt(refresh)
}

function stageRows(current: Run | null): TableRow[] {
  if (!current) return []
  const declaredStages = read(pipelines).find((entry) => entry.id === current.pipelineId)?.stages
  return current.stages.map((stage, index) => {
    const declared = declaredStages?.find((item) => item.id === stage.stageId)
    const elapsed =
      stage.startedAt === null
        ? null
        : stage.endedAt === null
          ? { type: 'relative' as const, at: stage.startedAt, format: 'duration' as const }
          : `${Math.max(1, Math.round((stage.endedAt - stage.startedAt) / 1000))}s`
    return {
      key: stage.stageId,
      cells: {
        stage: `${index + 1}. ${declared?.name ?? stage.stageId}`,
        state: stage.status,
        elapsed
      }
    }
  })
}

function Progress({ current }: { current: Run | null }) {
  if (!current) return null
  const done = current.stages.filter((stage) => stage.status === 'done').length
  return (
    <Badge tone={current.status === 'failed' ? 'danger' : 'accent'}>
      {`${done}/${current.stages.length} · ${current.status}`}
    </Badge>
  )
}

function RunTab() {
  const current = read(run)
  const list = read(pipelines)
  const spaces = read(workspaces)
  const pipelineId = read(selectedPipeline)
  const workspaceId = read(selectedWorkspace)
  const blocked = current?.status === 'blocked'
  const running = current?.status === 'running'
  const stage = current ? current.stages[current.stageIndex] : null
  const tail = current?.stages.find((item) => item.tail)?.tail ?? null

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Pipeline</Heading>
        <Progress current={current} />
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
          disabled={running}
          onChange={(value) => set(selectedWorkspace, value)}
        />
      )}

      <Select
        label="Pipeline"
        value={pipelineId}
        options={list.map((entry) => ({ value: entry.id, label: entry.name }))}
        disabled={running}
        onChange={(value) => set(selectedPipeline, value)}
      />

      <Textarea
        label="Task"
        rows={3}
        placeholder="What should the pipeline build, fix or review?"
        value={read(task)}
        disabled={running}
        onChange={(value) => set(task, value)}
      />

      <Row gap="xs" wrap>
        <Button
          icon="play"
          onPress={startRun}
          disabled={read(busy) || running || !pipelineId || !workspaceId}
        >
          Run
        </Button>
        <Button variant="outline" icon="stop" onPress={() => control('run.stop')} disabled={!running}>
          Stop
        </Button>
        {blocked ? (
          <Button icon="next" onPress={() => control('run.resume')}>
            Carry on
          </Button>
        ) : null}
        {current && !running ? (
          <Button variant="ghost" icon="refresh" onPress={() => control('run.retry')}>
            Retry stage
          </Button>
        ) : null}
        {current && !running && current.status !== 'done' ? (
          <Button variant="ghost" icon="next" onPress={() => control('run.skip')}>
            Skip stage
          </Button>
        ) : null}
      </Row>

      {blocked ? (
        <Callout tone="warning" title="Needs you">
          <Text size="sm">{stage?.note ?? 'The agent is waiting for you in its terminal.'}</Text>
        </Callout>
      ) : null}

      {current?.status === 'failed' ? (
        <Callout tone="danger" title="Stage failed">
          <Text size="sm">{stage?.note ?? 'The agent reported a failed turn.'}</Text>
        </Callout>
      ) : null}

      {current ? (
        <Table
          label="Stages"
          columns={[
            { key: 'stage', label: 'Stage', minWidth: 'sm' },
            { key: 'state', label: 'State', width: 'sm' },
            { key: 'elapsed', label: 'Took', width: 'xs', hideBelow: 'sm' }
          ]}
          rows={stageRows(current)}
        />
      ) : (
        <EmptyState
          title="No run yet"
          description="Pick a pipeline and a workspace, describe the task, then press Run."
          icon="layers"
        />
      )}

      {current && stage ? (
        <Text size="xs" muted>
          {`Stage ${current.stageIndex + 1} of ${current.stages.length} in ${current.workspaceName} with ${current.agent}`}
        </Text>
      ) : null}

      {tail ? (
        <Collapsible title="Last terminal output" description="The end of the agent's terminal">
          <CodeView code={tail} maxHeight="md" wrap />
        </Collapsible>
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
                <List label="Common agents">
                  {AGENT_CHOICES.map((choice) => (
                    <ListItem
                      key={choice.id}
                      icon={choice.icon}
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
          <Text size="xs" muted>
            The list is the common ones; any agent id Orca can launch works in the field above, and
            the list marks whichever one is set.
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
      </Tabs>
      {noticeText ? (
        <Callout tone="danger" title="That did not work">
          <Text size="sm">{noticeText}</Text>
        </Callout>
      ) : null}
    </Stack>
  )
}
