import type { Pipeline, Stage } from './protocol'

/**
 * Bring the app up. Shared by every review flow: all of them need the product running before
 * anything can be judged, and a review of nothing is worse than no review.
 */
const ENVIRONMENT: Stage = {
  id: 'environment',
  name: 'Environment',
  reasoning: 'low',
  prompt:
    'Bring the product up: install what is missing, start the dev server or build, and wait until ' +
    'it answers. Write down the URL, the account and the seed data you used, the commit, and how ' +
    'the app was started. If it will not start, stop here and say exactly what failed — never ' +
    'review nothing and call it a pass.'
}

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
        reasoning: 'high',
        prompt:
          'Task: {{task}}\n\n' +
          'Plan only — do not edit files. Read the code the task touches and answer with a short ' +
          'plan: the files you will change, the approach, the risks, and how you will verify it. ' +
          'Then stop and wait.'
      },
      {
        id: 'build',
        name: 'Build',
        reasoning: 'high',
        prompt:
          'Implement the plan you just wrote. Keep the change as small as the task allows, match ' +
          'the surrounding code, and leave unrelated files alone. When it is written, summarize ' +
          'what changed, then stop and wait.'
      },
      {
        id: 'test',
        name: 'Test',
        reasoning: 'low',
        prompt:
          'Verify the change: run the project’s tests, type check and lint for what you touched. ' +
          'Fix what fails. If something cannot be fixed here, say so plainly. End with the exact ' +
          'commands you ran and their result, then stop and wait.'
      },
      {
        id: 'review',
        name: 'Review',
        reasoning: 'high',
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
        reasoning: 'high',
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
        reasoning: 'medium',
        prompt:
          'Write the end-to-end checklist: for each journey, the happy path, at least two edge ' +
          'cases, and the regression most likely to slip through. Give every case an id, a ' +
          'precondition, the exact clicks and input a person would make, and the expected result ' +
          'on screen. Every case must be runnable through the UI — leave out anything only a unit ' +
          'test can see.'
      },
      { ...ENVIRONMENT },
      {
        id: 'run',
        name: 'Run',
        reasoning: 'medium',
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
        reasoning: 'medium',
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
    id: 'qa-design',
    name: 'QA · UX/UI review (senior designer)',
    agent: 'claude',
    stages: [
      {
        id: 'scope',
        name: 'Scope',
        reasoning: 'high',
        prompt:
          'Surfaces under review: {{task}}\n\n' +
          'You are a senior product designer reviewing this build as shipped, not as designed. ' +
          'List the screens and states the review covers — including empty, loading, error and ' +
          'success — the design-system source (tokens, components, Figma or the components ' +
          'folder), the breakpoints and themes you will check, and what is out of scope. Judge ' +
          'nothing yet.'
      },
      {
        id: 'criteria',
        name: 'Criteria',
        reasoning: 'high',
        prompt:
          'Write the checklist you will apply, as criteria you can see or measure on screen: ' +
          'hierarchy and scan path; spacing and alignment on a consistent grid; type scale and ' +
          'line length; colour and contrast to WCAG AA (4.5:1 for body text, 3:1 for large text ' +
          'and UI); visible focus and a logical tab order; affordances and feedback for every ' +
          'action; empty, loading and error copy; consistency with the design system; responsive ' +
          'behaviour at 360, 768 and 1440 px. One line per criterion, with what "pass" looks like.'
      },
      { ...ENVIRONMENT },
      {
        id: 'walkthrough',
        name: 'Walkthrough',
        reasoning: 'medium',
        prompt:
          'Walk every surface end to end in Orca’s embedded browser: `orca tab create --url`, ' +
          '`orca snapshot`, `orca click`, `orca fill`, `orca keypress`, and `orca eval` to measure ' +
          'rather than guess — computed font sizes, gaps, contrast ratios, focus outlines. Do ' +
          'each surface at 360, 768 and 1440 px, in both themes, and once keyboard-only. Record ' +
          'per criterion where you checked it (URL + element) and what you measured. Propose no ' +
          'fixes in this stage.'
      },
      {
        id: 'findings',
        name: 'Findings',
        reasoning: 'high',
        prompt:
          'Turn the evidence into findings. Each one: severity (blocker / major / minor / nit), ' +
          'the screen and element, expected versus actual, the criterion and the WCAG clause it ' +
          'breaks, why it costs the user, and the smallest fix. Rank by severity, not by the order ' +
          'you found them. No finding without evidence from the walkthrough; drop the ones you ' +
          'cannot point at.'
      },
      {
        id: 'report',
        name: 'Report',
        reasoning: 'medium',
        prompt:
          'Write ux-review.md at the repo root: what was reviewed (commit, breakpoints, themes, ' +
          'browser), the criteria table with pass/fail and the measurement behind each, the ' +
          'findings ranked with evidence, and a verdict — ship, ship with caveats, or do not ship ' +
          '— plus the three fixes worth doing first and the one thing a designer would notice ' +
          'immediately. Close the tabs you opened.'
      }
    ]
  },
  {
    id: 'qa-functional',
    name: 'QA · Functionality review (senior QA)',
    agent: 'claude',
    stages: [
      {
        id: 'scope',
        name: 'Scope',
        reasoning: 'high',
        prompt:
          'Under test: {{task}}\n\n' +
          'You are a senior QA engineer doing a risk-based end-to-end pass. State the commit, ' +
          'the entry point a person starts from, how the app runs, the accounts and roles ' +
          'available, and which areas the change touches. Say plainly what is out of scope and ' +
          'why.'
      },
      {
        id: 'risk',
        name: 'Risk',
        reasoning: 'high',
        prompt:
          'Design the pass before running it: a risk matrix (impact × likelihood) for what ' +
          'changed, the charters you will follow, and the data each needs — valid, boundary, ' +
          'invalid, empty, oversized, duplicate, concurrent. Call out the state transitions worth ' +
          'breaking (back button, reload mid-flow, two tabs) and the permissions each role should ' +
          'and should not have.'
      },
      {
        id: 'cases',
        name: 'Cases',
        reasoning: 'medium',
        prompt:
          'Write the checklist from the risk matrix. Every case gets an id, a precondition, the ' +
          'exact steps, the expected result on screen, the oracle you will judge it by, and the ' +
          'risk it covers. Include the negative and boundary cases now, not later — the happy ' +
          'path is the least interesting part.'
      },
      { ...ENVIRONMENT },
      {
        id: 'run',
        name: 'Run',
        reasoning: 'medium',
        prompt:
          'Run the checklist in Orca’s embedded browser — `orca tab create --url`, `orca snapshot`, ' +
          '`orca click/fill/keypress`, `orca tab close`; for a mobile app use `orca emulator ax`, ' +
          '`tap` and `logcat`. Watch the console and the network for 4xx/5xx and unhandled errors, ' +
          'repeat actions to check idempotency, and reload mid-flow where the risk matrix says it ' +
          'matters. Record each case as pass, fail or blocked with the evidence you actually saw. ' +
          'Fix nothing.'
      },
      {
        id: 'report',
        name: 'Report',
        reasoning: 'medium',
        prompt:
          'Write qa-report.md at the repo root: environment and build, the pass/fail table, then ' +
          'each defect with severity (S1 blocker, S2 major, S3 minor, S4 cosmetic), exact steps, ' +
          'expected versus actual, evidence, and the area it points at. End with a verdict — ship, ' +
          'ship with caveats, or do not ship — the top three risks left, and the one case you ' +
          'would add next. Close the tabs you opened.'
      }
    ]
  },
  {
    id: 'qa-value',
    name: 'QA · Product value review (senior PM)',
    agent: 'claude',
    stages: [
      {
        id: 'scope',
        name: 'Scope',
        reasoning: 'high',
        prompt:
          'Product under review: {{task}}\n\n' +
          'You are a senior product manager judging delivered commercial value, not code and not ' +
          'pixels. State the target user, the job they hire this product for, the promise the ' +
          'first screen makes, the pricing or packaging in play, and the metric the journey is ' +
          'supposed to move. Say what is out of scope.'
      },
      {
        id: 'journey',
        name: 'Journey',
        reasoning: 'medium',
        prompt:
          'Walk the commercial journey end to end in Orca’s embedded browser: first impression → ' +
          'signup or entry → activation (the first moment of real use) → the aha moment → the ' +
          'reason to come back → the paywall, upgrade or next action. Record the steps and the ' +
          'time to each milestone, and mark every point where a real user would drop out and why.'
      },
      { ...ENVIRONMENT },
      {
        id: 'audit',
        name: 'Value audit',
        reasoning: 'high',
        prompt:
          'Audit where value is delivered and where it leaks: is the value visible before any ' +
          'commitment; is time-to-value acceptable; does the copy sell outcomes or features; is ' +
          'there proof — numbers, customers, guarantees; is the price framed against the value; ' +
          'what happens at the free limit; what earns a second visit. Judge against the metric ' +
          'from the scope, not against taste, and quote the screen that shows it.'
      },
      {
        id: 'report',
        name: 'Report',
        reasoning: 'high',
        prompt:
          'Write product-review.md at the repo root: the promise as the product states it versus ' +
          'what a new user actually experiences; the journey with the friction points and ' +
          'drop-off risks you saw; a ranked opportunity list (impact on the metric × effort, with ' +
          'the evidence behind each); commercial risks; and a verdict — delivers the value it ' +
          'claims, delivers with friction, or does not yet deliver — plus the single change you ' +
          'would make first. Close the tabs you opened.'
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
        reasoning: 'high',
        prompt:
          'Bug: {{task}}\n\n' +
          'Find the cause first. Locate the code involved, state the root cause in a few lines, ' +
          'and describe the smallest reproduction you can run. Do not edit files yet.'
      },
      {
        id: 'fix',
        name: 'Fix',
        reasoning: 'high',
        prompt:
          'Fix the root cause you found, not the symptom. Keep the diff small and add a test that ' +
          'fails before the fix. Then stop and wait.'
      },
      {
        id: 'prove',
        name: 'Prove',
        reasoning: 'low',
        prompt:
          'Run the reproduction and the test suite. Show that the fix holds and that nothing else ' +
          'moved. End with the commands you ran, their result, and any remaining risk.'
      }
    ]
  }
]
