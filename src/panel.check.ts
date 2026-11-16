// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Seed what the worker reads so check shows more than the first state.
import { defineCheck } from 'orca/testing'
import type { Run } from './protocol'

function run(overrides: Partial<Run> & { id: string; pipelineId: string }): Run {
  const { id, pipelineId, ...rest } = overrides
  return {
    id,
    pipelineId,
    pipelineName: pipelineId,
    workspaceId: 'workspace-1',
    workspaceName: 'demo',
    agent: 'claude',
    task: 'Crash on empty input',
    terminalId: 'terminal-1',
    stageIndex: 1,
    status: 'running',
    stages: [
      {
        stageId: 'reproduce',
        status: 'done',
        startedAt: 1,
        endedAt: 61,
        note: null,
        tail: 'root cause: empty string'
      },
      { stageId: 'fix', status: 'running', startedAt: 61, endedAt: null, note: null, tail: null },
      { stageId: 'prove', status: 'pending', startedAt: null, endedAt: null, note: null, tail: null }
    ],
    startedAt: 1,
    endedAt: null,
    ...rest
  }
}

const workspaceList = {
  workspaces: [
    {
      id: 'workspace-1',
      kind: 'worktree',
      name: 'demo',
      project: 'demo',
      path: '/tmp/demo',
      branch: 'main',
      hostId: null
    }
  ],
  truncated: false
}

export default defineCheck({
  fresh: {},
  'mid-run': {
    storage: { runs: [run({ id: 'run-1', pipelineId: 'bugfix' })] },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': workspaceList
    }
  },
  'two in parallel': {
    storage: {
      runs: [
        run({ id: 'run-2', pipelineId: 'qa-design', pipelineName: 'QA · UX/UI review', stageIndex: 0 }),
        run({ id: 'run-1', pipelineId: 'bugfix', pipelineName: 'Bug fix' })
      ]
    },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': workspaceList
    }
  },
  'one run a time': {
    settings: { maxParallelRuns: 1 },
    storage: { runs: [run({ id: 'run-1', pipelineId: 'bugfix' })] },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': workspaceList
    }
  }
})
