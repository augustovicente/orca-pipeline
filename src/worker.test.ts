// Runs the worker the way Orca does: start runs, let each agent finish its stage, and check every
// prompt reached the right terminal.
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

type Sent = { terminalId: string; text: string }

function hostOptions(sent: Sent[]) {
  let launches = 0
  return {
    results: {
      'workspace.list': { workspaces: [workspace], truncated: false },
      'agent.launch': ({ prompt }: { prompt?: string }) => {
        launches += 1
        const terminalId = `terminal-${launches}`
        sent.push({ terminalId, text: prompt ?? '' })
        return { terminalId }
      },
      'terminal.sendText': ({ terminalId, text }: { terminalId: string; text: string }) => {
        sent.push({ terminalId, text })
        return { accepted: true }
      },
      'terminal.read': { lines: ['all good'], truncated: false }
    }
  }
}

function hostFor(sent: Sent[]) {
  return mockHost(hostOptions(sent))
}

function idle(terminalId: string, state: 'working' | 'waiting' | 'blocked' | 'done') {
  return { paneKey: 'tab:pane', terminalId, workspaceId: 'workspace-1', state, receivedAt: 1 }
}

test('chains every stage in one agent session', async () => {
  const sent: Sent[] = []
  const worker = await mountWorker(main, { host: hostFor(sent) })

  const started = await worker.request('run.start', {
    pipelineId: 'feature',
    workspaceId: 'workspace-1',
    task: 'Add a search endpoint'
  })
  assert.equal(started.run.status, 'running')
  assert.equal(sent.length, 1)
  assert.match(sent[0]?.text ?? '', /Add a search endpoint/)

  for (let stage = 0; stage < 4; stage += 1) {
    await worker.emit('agent.status.changed', idle('terminal-1', 'working'))
    await worker.emit('agent.status.changed', idle('terminal-1', 'waiting'))
  }

  const final = await worker.request('run.state')
  const run = final.runs[0]
  assert.equal(run?.status, 'done')
  assert.equal(run?.terminalId, 'terminal-1')
  assert.deepEqual(
    run?.stages.map((stage) => stage.status),
    ['done', 'done', 'done', 'done']
  )
  assert.equal(sent.length, 4)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('runs two pipelines at once, each on its own terminal', async () => {
  const sent: Sent[] = []
  const worker = await mountWorker(main, { host: hostFor(sent) })

  const feature = await worker.request('run.start', {
    pipelineId: 'feature',
    workspaceId: 'workspace-1',
    task: 'Add search'
  })
  const bugfix = await worker.request('run.start', {
    pipelineId: 'bugfix',
    workspaceId: 'workspace-1',
    task: 'Crash on empty input'
  })
  assert.notEqual(feature.run.id, bugfix.run.id)

  // Finishing a stage of the feature run must not move the bug fix run.
  await worker.emit('agent.status.changed', idle('terminal-1', 'working'))
  await worker.emit('agent.status.changed', idle('terminal-1', 'waiting'))

  let state = await worker.request('run.state')
  assert.equal(state.runs.length, 2)
  assert.equal(state.runs.find((run) => run.pipelineId === 'feature')?.stageIndex, 1)
  assert.equal(state.runs.find((run) => run.pipelineId === 'bugfix')?.stageIndex, 0)

  // Its prompt went to the feature terminal, not the bug fix one.
  const stageTwo = sent.filter((entry) => entry.text.includes('Implement the plan'))
  assert.deepEqual(
    stageTwo.map((entry) => entry.terminalId),
    ['terminal-1']
  )

  // Both keep going independently.
  await worker.emit('agent.status.changed', idle('terminal-2', 'working'))
  await worker.emit('agent.status.changed', idle('terminal-2', 'waiting'))
  state = await worker.request('run.state')
  assert.equal(state.runs.find((run) => run.pipelineId === 'bugfix')?.stageIndex, 1)
  assert.equal(state.runs.find((run) => run.pipelineId === 'feature')?.stageIndex, 1)

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('the parallel limit is a setting, and the refusal names it', async () => {
  const sent: Sent[] = []
  const host = hostFor(sent)
  const worker = await mountWorker(main, { host })

  for (const task of ['one', 'two', 'three', 'four', 'five']) {
    await worker.request('run.start', { pipelineId: 'feature', workspaceId: 'workspace-1', task })
  }
  await assert.rejects(
    worker.request('run.start', { pipelineId: 'feature', workspaceId: 'workspace-1', task: 'six' }),
    /5 runs at a time is the limit/
  )

  // The limit itself is a setting.
  const worker2 = await mountWorker(main, {
    host: mockHost({ ...hostOptions([]), settings: { maxParallelRuns: 1 } })
  })
  await worker2.request('run.start', {
    pipelineId: 'feature',
    workspaceId: 'workspace-1',
    task: 'one'
  })
  await assert.rejects(
    worker2.request('run.start', { pipelineId: 'feature', workspaceId: 'workspace-1', task: 'two' }),
    /1 run at a time is the limit/
  )
  await worker2.deactivate()
  await worker.deactivate()
})

test('stops one run when its agent is blocked, and carries it on alone', async () => {
  const sent: Sent[] = []
  const worker = await mountWorker(main, { host: hostFor(sent) })

  const { run } = await worker.request('run.start', {
    pipelineId: 'bugfix',
    workspaceId: 'workspace-1',
    task: 'Crash on empty input'
  })

  await worker.emit('agent.status.changed', idle('terminal-1', 'blocked'))
  let state = await worker.request('run.state')
  assert.equal(state.runs[0]?.status, 'blocked')
  assert.equal(sent.length, 1)

  await worker.request('run.resume', { runId: run.id })
  state = await worker.request('run.state')
  assert.equal(state.runs[0]?.status, 'running')

  await worker.emit('agent.status.changed', idle('terminal-1', 'working'))
  await worker.emit('agent.status.changed', idle('terminal-1', 'done'))
  state = await worker.request('run.state')
  assert.equal(state.runs[0]?.stageIndex, 1)
  assert.equal(sent.length, 2)
  assert.deepEqual(worker.refusals, [])
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
    ['bugfix', 'feature', 'qa', 'qa-design', 'qa-functional', 'qa-value']
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

test('adopts a single-run install, and finishes a run it finds running', async () => {
  const host = mockHost({
    storage: {
      run: {
        id: 'run-legacy',
        pipelineId: 'bugfix',
        pipelineName: 'Bug fix',
        workspaceId: 'workspace-1',
        workspaceName: 'demo',
        agent: 'claude',
        task: 'old',
        terminalId: 'terminal-9',
        stageIndex: 1,
        status: 'running',
        stages: [
          { stageId: 'reproduce', status: 'done', startedAt: 1, endedAt: 2, note: null, tail: null },
          { stageId: 'fix', status: 'running', startedAt: 3, endedAt: null, note: null, tail: null },
          { stageId: 'prove', status: 'pending', startedAt: null, endedAt: null, note: null, tail: null }
        ],
        startedAt: 1,
        endedAt: null
      }
    }
  })
  const worker = await mountWorker(main, { host })
  const state = await worker.request('run.state')
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0]?.id, 'run-legacy')
  // The process that waited on that agent is gone, so it is paused, not silently running.
  assert.equal(state.runs[0]?.status, 'blocked')
  assert.match(state.runs[0]?.stages[1]?.note ?? '', /restarted/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('new pipelines and the seeds use the agent running in the focused workspace', async () => {
  const host = mockHost({
    results: {
      'agents.list': {
        agents: [
          { terminalId: 't1', title: 'Codex', agent: 'codex', state: 'working', stateStartedAt: 0 }
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

test('pauses, rather than fails, when Orca refuses input outside the active worktree', async () => {
  const sent: Sent[] = []
  const host = hostFor(sent)
  const worker = await mountWorker(main, { host })
  const { run } = await worker.request('run.start', {
    pipelineId: 'bugfix',
    workspaceId: 'workspace-1',
    task: 'Crash on empty input'
  })

  // Orca only types into the worktree the app has active; stage two is refused.
  host.respond('terminal.sendText', () => {
    throw new Error('terminal is outside the active worktree')
  })
  await worker.emit('agent.status.changed', idle('terminal-1', 'working'))
  await worker.emit('agent.status.changed', idle('terminal-1', 'waiting'))

  let state = await worker.request('run.state')
  assert.equal(state.runs[0]?.status, 'blocked')
  assert.match(state.runs[0]?.stages[1]?.note ?? state.runs[0]?.stages[0]?.note ?? '', /Open demo in Orca/)

  // Once the worktree is active, carrying on re-sends instead of waiting for a turn that never came.
  host.respond('terminal.sendText', ({ text }: { text: string }) => {
    sent.push({ terminalId: 'terminal-1', text })
    return { accepted: true }
  })
  await worker.request('run.resume', { runId: run.id })
  state = await worker.request('run.state')
  assert.equal(state.runs[0]?.status, 'running')
  assert.equal(sent.length, 2)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a modeled stage starts its own process and falls back to the next model', async () => {
  const created: string[] = []
  const sent: Sent[] = []
  const host = mockHost({
    settings: { modelBootSeconds: 0 },
    storage: {
      pipelines: [
        {
          id: 'modeled',
          name: 'Modeled',
          agent: 'claude',
          stages: [
            {
              id: 'only',
              name: 'Only',
              prompt: 'Do {{task}}',
              model: 'first',
              fallbacks: ['second'],
              attempts: 1
            }
          ]
        }
      ]
    },
    results: {
      'workspace.list': { workspaces: [workspace], truncated: false },
      'terminal.create': ({ command }: { command?: string }) => {
        created.push(command ?? '')
        return { terminalId: `modeled-${created.length}` }
      },
      'terminal.sendText': ({ terminalId, text }: { terminalId: string; text: string }) => {
        sent.push({ terminalId, text })
        return { accepted: true }
      },
      'terminal.read': { lines: [], truncated: false }
    }
  })
  const worker = await mountWorker(main, { host })

  const { run } = await worker.request('run.start', {
    pipelineId: 'modeled',
    workspaceId: 'workspace-1',
    task: 'review the app'
  })
  assert.match(created[0] ?? '', /claude --model 'first'/)
  assert.deepEqual(sent.map((entry) => entry.terminalId), ['modeled-1'])
  assert.equal(run.model, 'first')

  // One failure is the whole allowance for that model, so the next one starts a new process.
  await worker.emit('agent.status.changed', idle('modeled-1', 'working'))
  await worker.emit('agent.status.changed', {
    ...idle('modeled-1', 'done'),
    mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 }
  })

  const state = await worker.request('run.state')
  const current = state.runs[0]
  assert.match(created[1] ?? '', /claude --model 'second'/)
  assert.equal(current?.model, 'second')
  assert.deepEqual(current?.triedModels, ['first', 'second'])
  assert.equal(current?.status, 'running')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
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
