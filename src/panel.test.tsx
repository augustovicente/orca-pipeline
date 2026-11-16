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
  path: '/tmp/demo',
  branch: 'main',
  hostId: null
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
