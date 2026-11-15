// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Seed what the worker reads so check shows more than the first state.
import { defineCheck } from 'orca/testing'
import type { Run } from './protocol'

const run: Run = {
  id: 'run-1',
  pipelineId: 'bugfix',
  pipelineName: 'Bug fix: reproduce → fix → prove',
  workspaceId: 'workspace-1',
  workspaceName: 'demo',
  agent: 'claude',
  task: 'Crash on empty input',
  terminalId: 'terminal-1',
  stageIndex: 1,
  status: 'running',
  stages: [
    { stageId: 'reproduce', status: 'done', startedAt: 1, endedAt: 61, note: null, tail: 'root cause: empty string' },
    { stageId: 'fix', status: 'running', startedAt: 61, endedAt: null, note: null, tail: null },
    { stageId: 'prove', status: 'pending', startedAt: null, endedAt: null, note: null, tail: null }
  ],
  startedAt: 1,
  endedAt: null
}

export default defineCheck({
  fresh: {},
  'mid-run': {
    storage: { run },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': {
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
    }
  }
})
