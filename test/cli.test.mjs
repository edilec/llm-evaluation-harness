import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const cli = new URL('../bin/llm-evaluation-harness.mjs', import.meta.url).pathname
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
const dataset = {
  schemaVersion: '1', seed: 0, policy: { maxCostMicros: 5, maxRetries: 0 },
  cases: [{ id: 'first', prompt: 'Return yes', assertions: [{ kind: 'exact', expected: 'yes' }], mock: { attempts: [{ response: 'yes', costMicros: 1 }] } }],
}

test('CLI good case, failing local fixture and missing response have distinct exits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'llm-eval-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'dataset.json')
  const fixture = join(root, 'responses.json')
  await writeFile(input, JSON.stringify(dataset))
  const clean = run('--dataset', input, '--json')
  assert.equal(clean.status, 0)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')
  assert.equal(clean.stderr, '')

  await writeFile(fixture, JSON.stringify({ schemaVersion: '1', responses: { first: { attempts: [{ response: 'wrong-secret-text', costMicros: 1 }] } } }))
  const failed = run('--dataset', input, '--responses', fixture, '--json')
  assert.equal(failed.status, 1)
  assert.deepEqual(JSON.parse(failed.stdout).findings.map((item) => item.ruleId), ['assertion-failed'])
  assert.ok(!failed.stdout.includes('wrong-secret-text'))

  await writeFile(fixture, JSON.stringify({ schemaVersion: '1', responses: {} }))
  const missing = run('--dataset', input, '--responses', fixture, '--json')
  assert.equal(missing.status, 2)
  assert.equal(JSON.parse(missing.stdout).status, 'incomplete')
  assert.deepEqual(JSON.parse(missing.stdout).findings.map((item) => item.ruleId), ['response-missing'])
})

test('CLI usage errors have empty stdout; named unreadable input has incomplete JSON', () => {
  const help = run('--help')
  assert.equal(help.status, 0)
  assert.equal(help.stdout, '')
  assert.match(help.stderr, /--dataset FILE/)
  for (const args of [[], ['--wrong'], ['--dataset', 'x', '--timeout-ms', '0']]) {
    const result = run(...args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
  }
  const missing = run('--dataset', '/not-a-real-edilec-test-path.json', '--json')
  assert.equal(missing.status, 2)
  assert.equal(JSON.parse(missing.stdout).status, 'incomplete')
})

test('malformed local response fixture is incomplete evidence, not a guessed mock pass', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'llm-eval-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'dataset.json')
  const fixture = join(root, 'responses.json')
  await writeFile(input, JSON.stringify(dataset))
  await writeFile(fixture, '{"responses":')
  const result = run('--dataset', input, '--responses', fixture, '--json')
  assert.equal(result.status, 2)
  assert.deepEqual(JSON.parse(result.stdout).findings.map((item) => item.ruleId), ['input-invalid'])
})
