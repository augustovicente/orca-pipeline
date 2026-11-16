// Model chains for a stage. Orca's plugin API cannot hand a model to `agent.launch`, so a stage
// that names one starts its own agent process with `--model` through `terminal.create` — which
// means the agent's binary has to be known here, and a new model means a new process.
import { AGENT_CHOICES } from './agent-choices'
import type { Stage } from './protocol'

/** Tries per model before moving to the next one in the chain. */
export const DEFAULT_ATTEMPTS = 2

/** `model` first, then `fallbacks`, without blanks or repeats. Empty means "the agent's default". */
export function modelChain(stage: Stage): string[] {
  const chain = [stage.model ?? '', ...(stage.fallbacks ?? [])]
    .map((model) => model.trim())
    .filter(Boolean)
  return [...new Set(chain)]
}

export function attemptsPerModel(stage: Stage): number {
  const value = stage.attempts
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ATTEMPTS
  return Math.min(10, Math.max(1, Math.round(value)))
}

/** The CLI Orca detects this agent by, or null when it is not one this plugin knows. */
export function agentBinary(agent: string): string | null {
  return AGENT_CHOICES.find((choice) => choice.id === agent)?.bins[0] ?? null
}

/** The command a modeled stage runs in its own terminal. */
export function modeledCommand(binary: string, model: string): string {
  return `${binary} --model '${model.replaceAll("'", '')}'`
}
