---
name: orca-pipeline
description: >-
  Run a staged agent workflow — feature, end-to-end QA, or bug fix — from a single prompt, the way
  the Orca Pipeline plugin does it, without opening the panel. Use when someone asks to "run the
  pipeline", "QA this branch end to end", "test this worktree", or to start a scheduled QA
  automation, including from a phone Quick Command.
license: MIT
---

# Orca Pipeline

Three workflows, run as an ordered set of stages in **one session**, so each stage sees everything
the stages before it did. This skill reproduces the Orca Pipeline plugin from a prompt: it is what
you load when the person is on a phone, in a chat, or simply does not want to click.

| Flow | Stages |
| --- | --- |
| **Feature** | plan → build → test → review |
| **QA (e2e)** | scope → cases → environment → run → report |
| **Bug fix** | reproduce → fix → prove |

## How to run one

1. **Name the work.** Restate the task in one line and list the stages you will run. If the person
   named no flow, infer it: a change to make → Feature, a branch to verify → QA, a defect → Bug fix.
2. **Work the stages in order.** Each stage is a turn's worth of real work, not a plan to do it
   later.
3. **Mark every boundary** so a phone reader can follow:

   ```
   ▶ Stage 2/4 — Build
   ...work...
   ✓ Stage 2/4 — Build: 3 files changed, new test added
   ```

4. **Keep going.** Run the stages one after another unless the person asked for gates ("step by
   step", "stop after each stage", "gated"). If you are blocked on a decision, ask **one** question
   and stop — do not guess and do not ask three.
5. **Finish with a summary** of six lines or fewer: what ran, what changed, what passed, what is
   left, where the report is.

## The flows

### Feature — plan → build → test → review

- **Plan.** Read the code the task touches. Answer with the files, the approach, the risks and how
  you will verify it. Edit nothing yet.
- **Build.** Implement the plan. Smallest change that does the job, matching the surrounding code.
- **Test.** Run the project's tests, type check and lint for what you touched. Fix what fails. End
  with the commands and their result.
- **Review.** Read your own diff as a strict reviewer: correctness, edge cases, error handling,
  tests, collateral damage. Fix what you find, then report what a human should still check.

### QA (e2e) — scope → cases → environment → run → report

This one needs a running app, so it is the flow most worth handing to a phone: it ends in a file
the person can read on the way home.

- **Scope.** The change under review (diff, branch, feature), the journeys it touches, the entry
  point a person starts from, and how the project runs locally (README, package scripts, docs).
  Say what you will not cover.
- **Cases.** An end-to-end checklist: per journey the happy path, two edge cases, and the
  regression most likely to slip through. Each case gets an id, a precondition, the exact steps a
  person takes, and the expected result **on screen**. Nothing only a unit test can see.
- **Environment.** Start what the project needs, wait until it answers, and record the URL, the
  account and the seed data. If it will not start, stop and say what failed — never test nothing
  and call it a pass.
- **Run.** Execute the checklist in **Orca's embedded browser**, not webfetch:

  ```sh
  orca tab create --url http://localhost:3000
  orca snapshot                       # element refs: e1, e2, ...
  orca click --element e4
  orca fill --element e7 --value "qa@example.com"
  orca keypress --key Enter
  orca snapshot                       # refs change after navigation — re-read them
  orca tab close --page <id>          # close what you opened
  ```

  For a mobile app use the emulator instead:

  ```sh
  orca emulator devices --json
  orca emulator attach "iPhone 16 Pro"
  orca emulator ax --json             # frames are normalized 0..1
  orca emulator tap 0.5 0.7
  orca emulator type "qa@example.com" # US-ASCII only
  orca emulator button home
  orca emulator logcat --json         # Android evidence
  orca emulator shutdown
  ```

  Record each case as pass, fail or blocked **with the evidence you actually saw**: the URL, the
  element label, the text on screen, the log line. Fix nothing in this stage.
- **Report.** Write `qa-report.md` at the repository root:

  ```markdown
  # QA report — <branch> — <date>

  Commit: <sha> · Tested in: <browser or device, OS> · Build: <how it was started>
  Scope: <what was in and what was out>

  | Case | What it checks | Result | Evidence |
  | --- | --- | --- | --- |
  | Q1 | Invite by email | pass | /settings/members shows "invited" |
  | Q2 | Duplicate invite | fail | toast absent, console 409 in network log |

  ## Failures
  ### Q2 — duplicate invite
  Steps: ... · Expected: ... · Actual: ... · Impact: ... · Suggested fix: ...

  ## Verdict
  Ship / ship with caveats / do not ship — and why.
  ```

  A failure you cannot reproduce is still reported, marked as such.

### Bug fix — reproduce → fix → prove

- **Reproduce.** Find the cause first: the code involved, the root cause in a few lines, the
  smallest reproduction. Edit nothing yet.
- **Fix.** Fix the cause, not the symptom. Small diff, plus a test that fails without it.
- **Prove.** Run the reproduction and the suite. Show the fix holds and nothing else moved.

## Starting a scheduled QA automation

If a QA automation already exists for the repo, start it instead of running the flow yourself:

```sh
orca automations list --json                      # find the QA automation's id
orca automations run <automationId> --json        # starts a separate agent run now
orca automations runs --id <automationId> --json  # its history and outcome
```

Run now bypasses the automation's precheck on purpose. Say that you started a run and where its
report will land; the run is its own session, so do not wait for it.

## Rules that keep this usable from a phone

- **Short lines, marked stages.** No walls of diff, no pasted logs over ten lines — say what
  matters and name the file.
- **One question, then stop.** A phone reply is a sentence, so make the question answerable in a
  sentence.
- **Write the evidence to a file.** `qa-report.md` is the deliverable; the chat is the summary.
- **Leave the machine as you found it.** Close the tabs you opened, stop the dev server you
  started (or say you left it running and on which port), and never commit or push unless asked.
- **Permissions.** The browser, emulator and dev-server commands need approval once; if a command
  stops on a prompt, say which one so it can be allowed on the desktop.
