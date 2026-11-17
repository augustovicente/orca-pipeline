// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Pipeline, Run } from './protocol'

const pipeline: Pipeline = {
  id: 'feature',
  name: 'Feature',
  agent: 'claude',
  stages: [
    { id: 'plan', name: 'Plan', prompt: 'Plan {{task}}' },
    { id: 'build', name: 'Build', prompt: 'Build it' }
  ]
}

const workspace = {
  id: 'workspace-1',
  kind: 'worktree' as const,
  name: 'demo',
  project: 'demo',
  projectId: 'project-demo',
  path: '/tmp/demo',
  branch: 'main',
  hostId: null
}

const otherWorkspace = {
  ...workspace,
  id: 'workspace-2',
  name: 'other',
  project: 'other',
  projectId: 'project-other',
  path: '/tmp/other'
}

const run: Run = {
  id: 'run-1',
  pipelineId: 'feature',
  pipelineName: 'Feature',
  workspaceId: 'workspace-1',
  workspaceName: 'demo',
  agent: 'claude',
  task: 'Ship it',
  terminalId: 'terminal-1',
  sessionId: 'session-1',
  model: null,
  modelIndex: 0,
  attempt: 0,
  triedModels: [],
  stageIndex: 0,
  status: 'running',
  stages: [
    { stageId: 'plan', status: 'running', startedAt: 1, endedAt: null, note: null, tail: null },
    { stageId: 'build', status: 'pending', startedAt: null, endedAt: null, note: null, tail: null }
  ],
  startedAt: 1,
  endedAt: null
}

function hostWith(requests: Record<string, unknown>) {
  return mockHost({
    settings: {
      highAgent: 'opencode',
      highModel: 'opencode-go/deepseek-v4.1-flash',
      mediumAgent: 'opencode',
      mediumModel: 'opencode/mimo-v2.6-flash-free',
      lowAgent: 'opencode',
      lowModel: 'opencode-go/beam-free',
      defaultAgent: '',
      maxParallelRuns: 5,
      stageTimeoutMinutes: 20,
      modelBootSeconds: 8,
      notify: true
    },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] }
    },
    requests: {
      'run.state': {
        runs: [],
        pipelines: [pipeline],
        projects: [{ id: 'project-demo', name: 'demo', path: '/tmp/demo', hostId: null }],
        defaultAgent: 'claude',
        availableAgents: ['claude', 'codex', 'opencode'],
        maxParallelRuns: 5,
        levels: {
          high: { agent: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
          medium: { agent: 'opencode', model: 'opencode/mimo-v2.6-flash-free' },
          low: { agent: 'opencode', model: 'opencode-go/beam-free' }
        }
      },
      'workspaces.list': { workspaces: [workspace] },
      ...requests
    }
  })
}

test('starts the selected pipeline with the typed task', async () => {
  const started: unknown[] = []
  const view = await mount(panel, {
    host: hostWith({
      'run.start': (input: unknown) => {
        started.push(input)
        return { run }
      }
    })
  })
  await view.settled()

  assert.ok(view.find({ role: 'button', text: 'Run' }))
  await view.type({ label: 'Task' }, 'Ship it')
  await view.press({ role: 'button', text: 'Run' })

  assert.deepEqual(started, [{ pipelineId: 'feature', workspaceId: 'workspace-1', task: 'Ship it' }])
  assert.ok(view.find({ text: /1 of 5 running/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('follows a run the worker posts', async () => {
  const view = await mount(panel, { host: hostWith({}) })
  await view.settled()

  await view.post('runs.changed', { runs: [run] })
  // Stages are links into the agent's terminal, one row each.
  assert.ok(view.find({ label: '1. Plan' }))
  assert.ok(view.find({ label: '2. Build' }))

  await view.post('runs.changed', {
    runs: [{
      ...run,
      status: 'blocked',
      stages: [{ ...run.stages[0]!, status: 'blocked', note: 'Waiting for you' }, run.stages[1]!]
    }]
  })
  assert.ok(view.find({ text: /Waiting for you/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('picks an agent from the list, with icons, including opencode', async () => {
  const saved: { pipeline: Pipeline }[] = []
  const view = await mount(panel, {
    host: hostWith({
      'pipelines.save': (input: { pipeline: Pipeline }) => (saved.push(input), { pipelines: [pipeline] })
    })
  })
  await view.settled()

  await view.select({ type: 'Tabs' }, 'pipelines')
  await view.press({ role: 'button', text: 'New' })

  // The picker is collapsed until pressed, then lists the common agents.
  assert.equal(view.find({ text: 'opencode' }), null)
  await view.press({ role: 'button', text: 'claude' })
  assert.ok(view.find({ text: 'opencode' }))
  assert.ok(view.find({ text: 'codex' }))
  assert.equal(view.find({ role: 'button', text: 'claude' })?.props.icon, 'bot')
  assert.equal(view.find({ text: 'opencode' })?.props.icon, 'terminal')
  assert.equal(view.find({ text: 'codex' })?.props.icon, 'code')

  await view.press({ text: 'opencode' })
  assert.ok(view.find({ role: 'button', text: 'opencode' }))
  assert.equal(view.find({ text: 'claude' }), null)

  await view.press({ role: 'button', text: 'Save' })
  assert.equal(saved[0]?.pipeline.agent, 'opencode')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows each parallel run with its own stage table', async () => {
  const view = await mount(panel, { host: hostWith({}) })
  await view.settled()

  await view.post('runs.changed', {
    runs: [run, { ...run, id: 'run-2', pipelineId: 'bugfix', pipelineName: 'Bug fix' }]
  })
  assert.equal(view.findAll({ type: 'List' }).length, 2)
  // Two runs, each with its own stage list.
  assert.equal(view.findAll({ label: /^1\. / }).length, 2)
  assert.ok(view.find({ text: /2 of 5 running/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('refuses to start past the parallel limit', async () => {
  const view = await mount(panel, {
    host: hostWith({
      'run.state': {
        // Three live runs against a ceiling of three: the button must be unavailable.
        runs: [
          { ...run, id: 'run-1' },
          { ...run, id: 'run-2' },
          { ...run, id: 'run-3' }
        ],
        pipelines: [pipeline],
        defaultAgent: 'claude',
        availableAgents: ['claude'],
        maxParallelRuns: 3,
        levels: {
          high: { agent: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
          medium: { agent: 'opencode', model: 'opencode/mimo-v2.6-flash-free' },
          low: { agent: 'opencode', model: 'opencode-go/beam-free' }
        }
      }
    })
  })
  await view.settled()

  assert.equal(view.find({ role: 'button', text: 'Run' })?.disabled, true)
  assert.ok(view.find({ text: /stop one to start another/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('lists a started run once, and opens its terminal from a stage', async () => {
  const view = await mount(panel, {
    host: hostWith({
      'run.start': { run },
      'run.output': { text: '> building…\nall good' }
    })
  })
  await view.settled()
  await view.type({ label: 'Task' }, 'Ship it')

  // The worker also posts the run it just started; the list must still hold it once.
  await view.press({ role: 'button', text: 'Run' })
  await view.press({ role: 'button', text: 'Run' })
  assert.equal(view.findAll({ label: /^1\. / }).length, 1)

  await view.press({ label: '2. Build' })
  assert.ok(view.find({ text: /all good/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('edits the reasoning levels from the panel itself', async () => {
  const view = await mount(panel, { host: hostWith({}) })
  await view.settled()

  await view.select({ type: 'Tabs' }, 'settings')
  assert.ok(view.find({ text: 'High reasoning' }))
  assert.ok(view.find({ text: 'Low reasoning' }))

  // The first "Model" field belongs to High.
  await view.type({ label: 'Model' }, 'opencode-go/deepseek-v4-max', { replace: true })
  await view.press({ role: 'button', text: 'Save settings' })

  assert.equal(view.host.data().settings.highModel, 'opencode-go/deepseek-v4-max')
  assert.equal(view.host.data().settings.maxParallelRuns, 5)
  assert.ok(view.find({ text: /next stage uses these/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('the reasoning picker names the model each level maps to', () => {
  const options = panel.reasoningOptions({
    high: { agent: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
    medium: { agent: 'opencode', model: 'opencode/mimo-v2.6-flash-free' },
    low: { agent: 'opencode', model: 'opencode-go/beam-free' }
  })
  assert.deepEqual(
    options.map((option) => option.value),
    ['inherit', 'high', 'medium', 'low']
  )
  assert.match(options[1]?.label ?? '', /High — opencode-go\/deepseek-v4\.1-flash/)
  assert.match(options[2]?.label ?? '', /Medium — opencode\/mimo-v2\.6-flash-free/)
  assert.match(options[3]?.label ?? '', /Low — opencode-go\/beam-free/)
})

test('the pipeline editor draws its pickers without a placeholder', async () => {
  const view = await mount(panel, { host: hostWith({}) })
  await view.settled()
  await view.select({ type: 'Tabs' }, 'pipelines')
  await view.press({ label: 'Feature' })

  const selects = view.findAll({ type: 'Select' })
  assert.ok(selects.length >= 2, `expected the pipeline and stage pickers, saw ${selects.length}`)
  const labels = selects.map((element) => element.props.label)
  assert.ok(labels.includes('Reasoning for its stages'))
  assert.ok(labels.includes('Reasoning'))
  // Orca draws a placeholder when a control's props are refused; nothing here should be.
  assert.equal(view.find({ text: /not available in this version/ }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('saves an edited pipeline', async () => {
  const saved: unknown[] = []
  const view = await mount(panel, {
    host: hostWith({ 'pipelines.save': (input: unknown) => (saved.push(input), { pipelines: [pipeline] }) })
  })
  await view.settled()

  await view.select({ type: 'Tabs' }, 'pipelines')
  await view.press({ role: 'button', text: 'New' })
  assert.ok(view.find({ label: 'Name' }))
  await view.press({ role: 'button', text: 'Save' })

  assert.equal(saved.length, 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('offers the pipelines of this repo and the ones for every workspace only', async () => {
  const scoped = (id: string, projectId: string, projectName: string): Pipeline => ({
    ...pipeline,
    id,
    name: id,
    projectId,
    projectName
  })
  const view = await mount(panel, {
    host: hostWith({
      'run.state': {
        runs: [],
        pipelines: [
          pipeline,
          scoped('demo-only', 'project-demo', 'demo'),
          scoped('other-only', 'project-other', 'other')
        ],
        projects: [
          { id: 'project-demo', name: 'demo', path: '/tmp/demo', hostId: null },
          { id: 'project-other', name: 'other', path: '/tmp/other', hostId: null }
        ],
        defaultAgent: 'claude',
        availableAgents: ['claude'],
        maxParallelRuns: 5,
        levels: {
          high: { agent: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
          medium: { agent: 'opencode', model: 'opencode/mimo-v2.6-flash-free' },
          low: { agent: 'opencode', model: 'opencode-go/beam-free' }
        }
      },
      'workspaces.list': { workspaces: [workspace, otherWorkspace] }
    })
  })
  await view.settled()

  const values = () =>
    ((view.find({ label: 'Pipeline' })?.props.options ?? []) as { value: string }[]).map(
      (option) => option.value
    )
  assert.deepEqual(values(), ['feature', 'demo-only'])

  await view.select({ label: 'Workspace' }, 'workspace-2')
  assert.deepEqual(values(), ['feature', 'other-only'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('refreshes workspaces and pipelines from the Run tab', async () => {
  const laterWorkspace = { ...otherWorkspace, id: 'workspace-3', name: 'later', projectId: 'later' }
  const laterPipeline: Pipeline = {
    ...pipeline,
    id: 'later-flow',
    name: 'Later flow',
    projectId: 'later',
    projectName: 'later'
  }
  let spaces = [workspace]
  let state = {
    runs: [],
    pipelines: [pipeline],
    projects: [{ id: 'project-demo', name: 'demo', path: '/tmp/demo', hostId: null }],
    defaultAgent: 'claude',
    availableAgents: ['claude'],
    maxParallelRuns: 5,
    levels: {
      high: { agent: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
      medium: { agent: 'opencode', model: 'opencode/mimo-v2.6-flash-free' },
      low: { agent: 'opencode', model: 'opencode-go/beam-free' }
    }
  }
  const view = await mount(panel, {
    host: hostWith({
      'workspaces.list': () => ({ workspaces: spaces }),
      'run.state': () => state
    })
  })
  await view.settled()

  spaces = [workspace, laterWorkspace]
  state = {
    ...state,
    pipelines: [pipeline, laterPipeline],
    projects: [{ id: 'later', name: 'later', path: '/tmp/later', hostId: null }]
  }
  await view.press({ role: 'button', text: 'Refresh' })
  await view.settled()

  const workspaces = (view.find({ label: 'Workspace' })?.props.options ?? []) as {
    value: string
  }[]
  assert.ok(workspaces.some((option) => option.value === 'workspace-3'))
  // The new flow belongs to another repo, so this workspace's picker keeps the global one.
  const values = ((view.find({ label: 'Pipeline' })?.props.options ?? []) as { value: string }[]).map(
    (option) => option.value
  )
  assert.deepEqual(values, ['feature'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('opens a run terminal and its session from the run card', async () => {
  const opens: unknown[] = []
  const sessions: unknown[] = []
  const view = await mount(panel, {
    host: hostWith({
      'run.open': (input: unknown) => (opens.push(input), { opened: 'terminal' as const }),
      'run.openSession': (input: unknown) => (
        sessions.push(input), { terminalId: 'terminal-2', started: true }
      )
    })
  })
  await view.settled()
  await view.post('runs.changed', { runs: [run] })

  await view.press({ role: 'button', text: 'Open terminal' })
  assert.deepEqual(opens, [{ runId: 'run-1' }])

  await view.press({ role: 'button', text: 'New tab' })
  assert.deepEqual(sessions, [{ runId: 'run-1' }])
  assert.ok(view.find({ text: /open in its own tab/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('scopes a pipeline to the selected repo', async () => {
  const saved: { pipeline: Pipeline }[] = []
  const view = await mount(panel, {
    host: hostWith({
      'pipelines.save': (input: { pipeline: Pipeline }) => (
        saved.push(input), { pipelines: [input.pipeline] }
      )
    })
  })
  await view.settled()

  await view.select({ type: 'Tabs' }, 'pipelines')
  await view.press({ role: 'button', text: 'New' })
  await view.select({ label: 'Applies to' }, 'project-demo')
  await view.press({ role: 'button', text: 'Save' })

  assert.equal(saved[0]?.pipeline.projectId, 'project-demo')
  assert.equal(saved[0]?.pipeline.projectName, 'demo')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
