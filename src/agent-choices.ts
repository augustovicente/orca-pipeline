// Which agents this plugin can offer, and the CLI each one is found by. The binaries mirror
// Orca's own catalog (src/shared/agent-launch/catalog/tui-agent-config.ts), so a picker entry
// only appears when the same command Orca would detect is on this machine.
export type AgentChoice = { id: string; icon: string; bins: readonly string[] }

export const AGENT_CHOICES: readonly AgentChoice[] = [
  { id: 'claude', icon: 'bot', bins: ['claude'] },
  { id: 'codex', icon: 'code', bins: ['codex'] },
  { id: 'opencode', icon: 'terminal', bins: ['opencode'] },
  { id: 'opencode2', icon: 'terminal', bins: ['opencode2'] },
  { id: 'gemini', icon: 'star', bins: ['gemini'] },
  { id: 'copilot', icon: 'cloud', bins: ['copilot'] },
  { id: 'cursor', icon: 'file', bins: ['cursor-agent'] },
  { id: 'grok', icon: 'zap', bins: ['grok'] },
  { id: 'omp', icon: 'gauge', bins: ['omp'] },
  { id: 'pi', icon: 'activity', bins: ['pi'] },
  { id: 'aider', icon: 'wrench', bins: ['aider'] },
  { id: 'amp', icon: 'lightbulb', bins: ['amp'] },
  { id: 'kiro', icon: 'layers', bins: ['kiro-cli'] },
  { id: 'droid', icon: 'package', bins: ['droid'] },
  { id: 'crush', icon: 'hammer', bins: ['crush'] },
  { id: 'qwen-code', icon: 'globe', bins: ['qwen'] },
  { id: 'antigravity', icon: 'rocket', bins: ['agy'] },
  { id: 'kimi', icon: 'book', bins: ['kimi', 'kimi-code'] },
  { id: 'goose', icon: 'flag', bins: ['goose'] },
  { id: 'cline', icon: 'plug', bins: ['cline'] }
]

/**
 * The ids whose binary exists in one of `dirs`. Pure so the panel and the tests can use it
 * without touching the disk.
 */
export function pickInstalled(
  choices: readonly AgentChoice[],
  dirs: readonly string[],
  exists: (path: string) => boolean
): string[] {
  const found = new Set<string>()
  for (const dir of dirs) {
    for (const choice of choices) {
      if (found.has(choice.id)) continue
      if (choice.bins.some((bin) => exists(`${dir}/${bin}`))) found.add(choice.id)
    }
  }
  return choices.filter((choice) => found.has(choice.id)).map((choice) => choice.id)
}
