// Finds the agents actually installed on this machine. A GUI app's PATH is thinner than a login
// shell's, so this adds the same fallback directories Orca's own detector uses before concluding
// an agent is missing.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { AGENT_CHOICES, pickInstalled } from './agent-choices'

function searchDirs(): string[] {
  const fromPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const home = homedir()
  const extra = [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, '.nix-profile', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/snap/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/nix/var/nix/profiles/default/bin'
  ]
  return [...new Set([...fromPath, ...extra])]
}

/** Agent ids with an installed CLI, in catalog order. */
export function detectInstalledAgents(): string[] {
  // Windows installers land behind PATHEXT and shims this scan does not model; an empty answer
  // makes the panel fall back to the whole catalog rather than hide everything.
  if (process.platform === 'win32') return []
  return pickInstalled(AGENT_CHOICES, searchDirs(), existsSync)
}
