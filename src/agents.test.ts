// The picker must offer what is actually installed, so the detection is a pure function of the
// directories searched and the files that exist.
import { assert, test } from 'orca/testing'
import { AGENT_CHOICES, pickInstalled } from './agent-choices'

test('reports only the agents whose binary is present', () => {
  const present = new Set(['/home/me/.local/bin/opencode', '/usr/local/bin/claude'])
  const installed = pickInstalled(AGENT_CHOICES, ['/home/me/.local/bin', '/usr/local/bin'], (path) =>
    present.has(path)
  )
  assert.deepEqual(installed, ['claude', 'opencode'])
})

test('finds an agent by any of its binaries, and stays in catalog order', () => {
  const present = new Set(['/opt/homebrew/bin/kimi-code', '/opt/homebrew/bin/agy'])
  const installed = pickInstalled(AGENT_CHOICES, ['/opt/homebrew/bin'], (path) => present.has(path))
  assert.deepEqual(installed, ['antigravity', 'kimi'])
})

test('searches every directory, and reports nothing when nothing matches', () => {
  const present = new Set(['/snap/bin/codex'])
  assert.deepEqual(
    pickInstalled(AGENT_CHOICES, ['/usr/bin', '/snap/bin'], (path) => present.has(path)),
    ['codex']
  )
  assert.deepEqual(
    pickInstalled(AGENT_CHOICES, ['/usr/bin'], () => false),
    []
  )
})
