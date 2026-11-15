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
    id: 'qa',
    name: 'QA (e2e): scope → cases → environment → run → report',
    agent: 'claude',
    stages: [
      {
        id: 'scope',
        name: 'Scope',
        prompt:
          'Under test: {{task}}\n\n' +
          'Establish what is being tested before anything else: the change under review (diff, ' +
          'branch or feature), the user-facing journeys it touches, the entry point a person ' +
          'starts from, and how this project is run locally (read the README, package scripts, ' +
          'or the docs). List what you will NOT cover and why. Do not start anything yet.'
      },
      {
        id: 'cases',
        name: 'Cases',
        prompt:
          'Write the end-to-end checklist: for each journey, the happy path, at least two edge ' +
          'cases, and the regression most likely to slip through. Give every case an id, a ' +
          'precondition, the exact clicks and input a person would make, and the expected result ' +
          'on screen. Every case must be runnable through the UI — leave out anything only a unit ' +
          'test can see.'
      },
      {
        id: 'environment',
        name: 'Environment',
        prompt:
          'Bring the app up: start what the project needs (dependencies, dev server or build), ' +
          'wait for it to answer, and write down the URL and the account or seed data you used. ' +
          'If it cannot start, stop here and say exactly what failed — do not skip to testing.'
      },
      {
        id: 'run',
        name: 'Run',
        prompt:
          'Run the checklist against the running app in Orca’s embedded browser — use ' +
          '`orca tab create --url`, `orca snapshot`, `orca click --element`, `orca fill`, ' +
          '`orca keypress` and `orca tab close`; never webfetch or an external browser. Take a ' +
          'snapshot before each interaction and after it, and record each case as pass, fail or ' +
          'blocked with the evidence you actually saw: the URL, the element, the text on screen. ' +
          'Do not fix anything in this stage, and close the tabs you opened when you are done.'
      },
      {
        id: 'report',
        name: 'Report',
        prompt:
          'Write the QA report: what was tested and on what commit, the pass/fail table, then ' +
          'each failure with the shortest reproduction, its impact and a suggested fix. Include ' +
          'the console or network error behind a failure when you saw one. End with a clear ' +
          'verdict — ship, ship with caveats, or do not ship — and the reasons. A failure you ' +
          'cannot reproduce is still reported, marked as such.'
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
