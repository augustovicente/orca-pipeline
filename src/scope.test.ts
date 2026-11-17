// A pipeline with no project applies everywhere; one with a project only in that repo.
import { assert, test } from 'orca/testing'
import { appliesTo, pipelineProjectKey, projectKey } from './scope'

test('prefers the project id and falls back to the project name', () => {
  assert.equal(projectKey({ project: 'demo', projectId: 'project-demo' }), 'project-demo')
  assert.equal(projectKey({ project: 'demo', projectId: null }), 'name:demo')
  assert.equal(projectKey({ project: null, projectId: null }), null)
  assert.equal(projectKey(undefined), null)
})

test('a scoped pipeline runs in its project only; an unscoped one runs anywhere', () => {
  const scoped = { projectId: 'project-demo', projectName: 'demo' }
  const global = { projectId: null, projectName: null }
  assert.equal(pipelineProjectKey(scoped), 'project-demo')
  assert.equal(pipelineProjectKey(global), null)
  assert.equal(appliesTo(scoped, 'project-demo'), true)
  assert.equal(appliesTo(scoped, 'project-other'), false)
  assert.equal(appliesTo(global, 'project-other'), true)
  assert.equal(appliesTo(global, null), true)
})

test('falls back to the project name only when an id is missing on one side', () => {
  const scoped = { projectId: 'project-demo', projectName: 'demo' }
  assert.equal(appliesTo(scoped, 'name:demo'), true)
  assert.equal(appliesTo(scoped, 'name:other'), false)
  // Two real ids that share a name are still different projects.
  assert.equal(appliesTo(scoped, 'project-other', 'demo'), false)
})
