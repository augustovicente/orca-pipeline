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
    sessionId: 'session-1',
    model: null,
    modelIndex: 0,
    attempt: 0,
    triedModels: [],
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
      projectId: 'project-demo',
      path: '/tmp/demo',
      branch: 'main',
      hostId: null
    }
  ],
  truncated: false
}

const projects = {
  projects: [
    { id: 'project-demo', name: 'demo', path: '/tmp/demo', hostId: null },
    { id: 'project-other', name: 'other', path: '/tmp/other', hostId: null }
  ],
  truncated: false
}

export default defineCheck({
  fresh: {},
  'mid-run': {
    storage: { runs: [run({ id: 'run-1', pipelineId: 'bugfix' })] },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': workspaceList,
      'project.list': projects
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
      'workspace.list': workspaceList,
      'project.list': projects
    }
  },
  'pipeline editor': {
    // The editor only draws on its own tab; this is what catches a component Orca refuses.
    persisted: { plugin: { tab: 'pipelines', selectedPipeline: 'qa-value' } },
    storage: { runs: [] },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': workspaceList,
      'project.list': projects
    }
  },
  'settings tab': {
    persisted: { plugin: { tab: 'settings' } },
    storage: { runs: [] }
  },
  'repo pipelines': {
    persisted: { plugin: { tab: 'pipelines', selectedPipeline: 'demo-checks' } },
    storage: {
      runs: [],
      pipelines: [
        {
          id: 'demo-checks',
          name: 'Demo checks',
          agent: 'claude',
          projectId: 'project-demo',
          projectName: 'demo',
          stages: [{ id: 'only', name: 'Only', prompt: 'Check {{task}}' }]
        },
        {
          id: 'other-checks',
          name: 'Other checks',
          agent: 'claude',
          projectId: 'project-other',
          projectName: 'other',
          stages: [{ id: 'only', name: 'Only', prompt: 'Check {{task}}' }]
        }
      ]
    },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': workspaceList,
      'project.list': projects
    }
  },
  'one run a time': {
    settings: { maxParallelRuns: 1 },
    storage: { runs: [run({ id: 'run-1', pipelineId: 'bugfix' })] },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': workspaceList,
      'project.list': projects
    }
  }
})
