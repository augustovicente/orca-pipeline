// Runs the worker the way Orca does: start a run, let the agent finish each stage, and check
// the next prompt reached the same terminal.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const workspace = {
  id: 'workspace-1',
  kind: 'worktree' as const,
  name: 'demo',
  project: 'demo',
  path: '/tmp/demo',
  branch: 'pipeline-test',
  hostId: null
}

function hostFor(prompts: string[]) {
  return mockHost({
    results: {
      'workspace.list': { workspaces: [workspace], truncated: false },
      'agent.launch': ({ prompt }: { prompt?: string }) => {
        prompts.push(prompt ?? '')
        return { terminalId: 'terminal-1' }
      },
      'terminal.sendText': ({ text }: { text: string }) => {
        prompts.push(text)
        return { accepted: true }
      },
      'terminal.read': { lines: ['all good'], truncated: false }
    }
  })
}

const idle = {
  paneKey: 'tab:pane',
  terminalId: 'terminal-1',
  workspaceId: 'workspace-1'
}

test('chains every stage in one agent session', async () => {
  const prompts: string[] = []
  const host = hostFor(prompts)
  const worker = await mountWorker(main, { host })

  const { run } = await worker.request('run.start', {
    pipelineId: 'feature',
    workspaceId: 'workspace-1',
    task: 'Add a search endpoint'
  })
  assert.equal(run.status, 'running')
  assert.equal(prompts.length, 1)
  assert.match(prompts[0] ?? '', /Add a search endpoint/)

  // Four stages, each ending its turn: working, then waiting.
  for (let stage = 0; stage < 4; stage += 1) {
    await worker.emit('agent.status.changed', { ...idle, state: 'working', receivedAt: 1 })
    await worker.emit('agent.status.changed', { ...idle, state: 'waiting', receivedAt: 2 })
  }

  const final = await worker.request('run.state')
  assert.equal(final.run?.status, 'done')
  assert.equal(final.run?.terminalId, 'terminal-1')
  assert.equal(prompts.length, 4)
  assert.deepEqual(
    final.run?.stages.map((stage) => stage.status),
    ['done', 'done', 'done', 'done']
  )
  assert.equal(host.callsOf('agent.launch').length, 1)
  assert.equal(host.callsOf('terminal.sendText').length, 3)
  assert.equal(host.callsOf('notifications.show').length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('stops when the agent is blocked and carries on when resumed', async () => {
  const prompts: string[] = []
  const worker = await mountWorker(main, { host: hostFor(prompts) })

  await worker.request('run.start', {
    pipelineId: 'bugfix',
    workspaceId: 'workspace-1',
    task: 'Crash on empty input'
  })

  await worker.emit('agent.status.changed', { ...idle, state: 'blocked', receivedAt: 3 })
  let state = await worker.request('run.state')
  assert.equal(state.run?.status, 'blocked')
  assert.equal(prompts.length, 1)

  await worker.request('run.resume')
  state = await worker.request('run.state')
  assert.equal(state.run?.status, 'running')

  await worker.emit('agent.status.changed', { ...idle, state: 'working', receivedAt: 4 })
  await worker.emit('agent.status.changed', { ...idle, state: 'done', receivedAt: 5 })
  state = await worker.request('run.state')
  assert.equal(state.run?.stageIndex, 1)
  assert.equal(prompts.length, 2)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('rejects a second run while one is going', async () => {
  const worker = await mountWorker(main, { host: hostFor([]) })
  await worker.request('run.start', {
    pipelineId: 'feature',
    workspaceId: 'workspace-1',
    task: 'one'
  })
  await assert.rejects(
    worker.request('run.start', { pipelineId: 'feature', workspaceId: 'workspace-1', task: 'two' }),
    /already going/
  )
  await worker.deactivate()
})

test('adds a new seeded pipeline to storage that predates it, once', async () => {
  const host = mockHost({
    results: { 'workspace.list': { workspaces: [workspace], truncated: false } },
    storage: {
      pipelines: [
        {
          id: 'feature',
          name: 'Feature',
          agent: 'claude',
          stages: [{ id: 'plan', name: 'Plan', prompt: 'Plan' }]
        }
      ]
    }
  })
  let worker = await mountWorker(main, { host })
  const seeded = await worker.request('pipelines.list')
  assert.deepEqual(
    seeded.pipelines.map((pipeline) => pipeline.id).sort(),
    ['bugfix', 'feature', 'qa']
  )
  // The edited one is kept, not overwritten.
  assert.equal(seeded.pipelines.find((pipeline) => pipeline.id === 'feature')?.name, 'Feature')
  await worker.deactivate()

  // Removing a seeded pipeline keeps it removed after a reload.
  worker = await mountWorker(main, { host })
  await worker.request('pipelines.remove', { id: 'qa' })
  await worker.deactivate()
  worker = await mountWorker(main, { host })
  const after = await worker.request('pipelines.list')
  assert.equal(
    after.pipelines.some((pipeline) => pipeline.id === 'qa'),
    false
  )
  await worker.deactivate()
})

test('new pipelines and the seeds use the agent running in the focused workspace', async () => {
  const host = mockHost({
    results: {
      'agents.list': {
        agents: [
          {
            terminalId: 't1',
            title: 'Codex',
            agent: 'codex',
            state: 'working',
            stateStartedAt: 0
          }
        ]
      }
    }
  })
  const worker = await mountWorker(main, { host })
  const state = await worker.request('run.state')
  assert.equal(state.defaultAgent, 'codex')
  assert.ok(state.pipelines.every((pipeline) => pipeline.agent === 'codex'))
  await worker.deactivate()
})

test('the default agent setting wins, and adopted seeds stay edited', async () => {
  const host = mockHost({
    settings: { defaultAgent: 'gemini' },
    results: {
      'agents.list': {
        agents: [
          { terminalId: 't1', title: 'Codex', agent: 'codex', state: 'working', stateStartedAt: 0 }
        ]
      }
    },
    storage: {
      pipelines: [
        {
          id: 'feature',
          name: 'Feature',
          agent: 'claude',
          stages: [{ id: 'plan', name: 'Plan', prompt: 'Plan' }]
        }
      ]
    }
  })
  const worker = await mountWorker(main, { host })
  const adopted = await worker.request('pipelines.list')
  assert.equal(adopted.pipelines.find((p) => p.id === 'feature')?.agent, 'gemini')

  // A later change to a pipeline's agent is not undone by the one-shot adoption.
  await worker.request('pipelines.save', {
    pipeline: {
      id: 'feature',
      name: 'Feature',
      agent: 'opencode',
      stages: [{ id: 'plan', name: 'Plan', prompt: 'Plan' }]
    }
  })
  await worker.deactivate()

  const again = await mountWorker(main, { host })
  const kept = await again.request('pipelines.list')
  assert.equal(kept.pipelines.find((p) => p.id === 'feature')?.agent, 'opencode')
  await again.deactivate()
})

test('saves and removes a pipeline', async () => {
  const host = hostFor([])
  const worker = await mountWorker(main, { host })
  const saved = await worker.request('pipelines.save', {
    pipeline: {
      id: 'custom',
      name: 'Custom',
      agent: 'codex',
      stages: [{ id: 'only', name: 'Only', prompt: 'Do it' }]
    }
  })
  assert.ok(saved.pipelines.some((pipeline) => pipeline.id === 'custom'))

  const removed = await worker.request('pipelines.remove', { id: 'custom' })
  assert.equal(
    removed.pipelines.some((pipeline) => pipeline.id === 'custom'),
    false
  )
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
