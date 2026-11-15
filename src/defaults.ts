import type { Pipeline } from './protocol'

/**
 * Pipelines Orca starts with. `{{task}}` is replaced by the task typed in the panel; a first
 * stage without it gets the task prepended. Each stage ends its turn, so the next prompt
 * arrives in the same agent session, with the whole conversation behind it.
 */
export const DEFAULT_PIPELINES: Pipeline[] = [
  {
    id: 'feature',
    name: 'Feature: plan → build → test → review',
    agent: 'claude',
    stages: [
      {
        id: 'plan',
        name: 'Plan',
        prompt:
          'Task: {{task}}\n\n' +
          'Plan only — do not edit files. Read the code the task touches and answer with a short ' +
          'plan: the files you will change, the approach, the risks, and how you will verify it. ' +
          'Then stop and wait.'
      },
      {
        id: 'build',
        name: 'Build',
        prompt:
          'Implement the plan you just wrote. Keep the change as small as the task allows, match ' +
          'the surrounding code, and leave unrelated files alone. When it is written, summarize ' +
          'what changed, then stop and wait.'
      },
      {
        id: 'test',
        name: 'Test',
        prompt:
          'Verify the change: run the project’s tests, type check and lint for what you touched. ' +
          'Fix what fails. If something cannot be fixed here, say so plainly. End with the exact ' +
          'commands you ran and their result, then stop and wait.'
      },
      {
        id: 'review',
        name: 'Review',
        prompt:
          'Review your own change as a strict reviewer: correctness, edge cases, error handling, ' +
          'tests, and anything that broke elsewhere. Fix what you find. Finish with a short ' +
          'report: what the change does, what you verified, and what a human should still check.'
      }
    ]
  },
  {
    id: 'bugfix',
    name: 'Bug fix: reproduce → fix → prove',
    agent: 'claude',
    stages: [
      {
        id: 'reproduce',
        name: 'Reproduce',
        prompt:
          'Bug: {{task}}\n\n' +
          'Find the cause first. Locate the code involved, state the root cause in a few lines, ' +
          'and describe the smallest reproduction you can run. Do not edit files yet.'
      },
      {
        id: 'fix',
        name: 'Fix',
        prompt:
          'Fix the root cause you found, not the symptom. Keep the diff small and add a test that ' +
          'fails before the fix. Then stop and wait.'
      },
      {
        id: 'prove',
        name: 'Prove',
        prompt:
          'Run the reproduction and the test suite. Show that the fix holds and that nothing else ' +
          'moved. End with the commands you ran, their result, and any remaining risk.'
      }
    ]
  }
]
