// Pipelines may belong to one Orca project instead of every workspace. The panel, the worker and
// the editor all compare projects through these helpers, so a missing project id falls back to the
// project name rather than hiding a repo's pipelines.
import type { Pipeline, Workspace } from './protocol'

type Scoped = Pick<Workspace, 'project' | 'projectId'>

/** A stable key for the project a workspace belongs to, or null when Orca names none. */
export function projectKey(space: Scoped | null | undefined): string | null {
  if (!space) return null
  const id = space.projectId?.trim()
  if (id) return id
  const name = space.project?.trim()
  return name ? `name:${name}` : null
}

/** The project a pipeline is scoped to, or null when it runs in every workspace. */
export function pipelineProjectKey(pipeline: Pick<Pipeline, 'projectId'>): string | null {
  return pipeline.projectId?.trim() || null
}

/** Whether a pipeline may run in a workspace belonging to `key` (null: no project known). */
export function appliesTo(
  pipeline: Pick<Pipeline, 'projectId' | 'projectName'>,
  key: string | null,
  projectName: string | null = null
): boolean {
  const scope = pipelineProjectKey(pipeline)
  if (scope === null) return true
  if (scope === key) return true
  // One side may not report a project id (older Orca, or a folder workspace): compare names then.
  const scopeByName = scope.startsWith('name:')
  const keyByName = key?.startsWith('name:') ?? false
  if (!scopeByName && !keyByName) return false
  const scopeName = scopeByName ? scope.slice(5) : (pipeline.projectName?.trim() ?? '')
  const workspaceName = keyByName ? (key ?? '').slice(5) : (projectName?.trim() ?? '')
  return Boolean(scopeName && workspaceName && scopeName === workspaceName)
}
