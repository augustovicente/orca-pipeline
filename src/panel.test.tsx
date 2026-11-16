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
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] }
    },
    requests: {
      'run.state': { run: null, pipelines: [pipeline], defaultAgent: 'claude' },
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
  assert.ok(view.find({ text: /running/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('follows a run the worker posts', async () => {
  const view = await mount(panel, { host: hostWith({}) })
  await view.settled()

  await view.post('run.changed', { run })
  assert.ok(view.find({ type: 'Table' }))
  assert.deepEqual(view.rowsOf({ type: 'Table' }), ['plan', 'build'])

  await view.post('run.changed', {
    run: {
      ...run,
      status: 'blocked',
      stages: [{ ...run.stages[0]!, status: 'blocked', note: 'Waiting for you' }, run.stages[1]!]
    }
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
