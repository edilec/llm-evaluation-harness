import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateDataset, exitCodeFor, renderReport } from '../src/index.mjs'

function oneCase() {
  return {
    schemaVersion: '1', seed: 11,
    policy: { maxCostMicros: 10, maxRetries: 1 },
    cases: [{ id: 'A', prompt: 'Return ok', assertions: [{ kind: 'exact', expected: 'ok' }], mock: { attempts: [{ response: 'ok', costMicros: 2 }] } }],
  }
}

const ids = (report) => report.findings.map((finding) => finding.ruleId)

test('a known failed assertion fails the aggregate with a bounded digest, not answer text', () => {
  const input = oneCase()
  input.cases[0].mock.attempts[0].response = 'wrong-private-answer'
  const report = evaluateDataset(input, { now: () => 0 })
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.deepEqual(ids(report), ['assertion-failed'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.cases[0].checks[0].status, 'fail')
  assert.equal(report.cases[0].checks[0].evidence.actualLength, 20)
  assert.ok(!renderReport(report).includes('wrong-private-answer'))
})

test('a terminal error makes the case incomplete despite an earlier successful response', () => {
  const input = oneCase()
  input.cases[0].mock.attempts.push({ error: 'local-error', costMicros: 1 })
  const report = evaluateDataset(input, { now: () => 0 })
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.deepEqual(ids(report), ['response-missing'])
  assert.equal(report.cases[0].retries, 1)
  assert.equal(report.cases[0].costMicros, 3)
  assert.equal(report.cases[0].status, 'incomplete')
})

test('a missing cost needed to evaluate the budget is visible and incomplete', () => {
  const input = oneCase()
  delete input.cases[0].mock.attempts[0].costMicros
  const report = evaluateDataset(input, { now: () => 0 })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['cost-unknown'])
  assert.equal(report.summary.costMicros, null)
  assert.equal(report.cases[0].costMicros, null)
})

test('a declared cost sum outside safe integer precision is unknown, not a green budget', () => {
  const input = oneCase()
  input.policy.maxCostMicros = Number.MAX_SAFE_INTEGER
  input.cases[0].mock.attempts = [
    { error: 'retry', costMicros: Number.MAX_SAFE_INTEGER },
    { response: 'ok', costMicros: 1 },
  ]
  const report = evaluateDataset(input, { now: () => 0 })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['cost-unknown'])
  assert.equal(report.summary.costMicros, null)
})

test('manual grading is explicitly undetermined and never a pass', () => {
  const input = oneCase()
  input.cases[0].assertions = [{ kind: 'manual' }]
  const report = evaluateDataset(input, { now: () => 0 })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['grade-undetermined'])
  assert.equal(report.cases[0].checks[0].status, 'unknown')
})

test('known retry and cost budget overruns fail and remain visible', () => {
  const input = oneCase()
  input.policy = { maxCostMicros: 2, maxRetries: 0 }
  input.cases[0].mock.attempts.unshift({ error: 'transient', costMicros: 1 })
  const report = evaluateDataset(input, { now: () => 0 })
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.deepEqual(ids(report), ['cost-budget-exceeded', 'retry-budget-exceeded'])
  assert.equal(report.summary.costMicros, 3)
  assert.equal(report.summary.retries, 1)
})

test('cost and retry budgets are silent at their exact thresholds', () => {
  const input = oneCase()
  input.policy = { maxCostMicros: 3, maxRetries: 1 }
  input.cases[0].mock.attempts.unshift({ error: 'transient', costMicros: 1 })
  const report = evaluateDataset(input, { now: () => 0 })
  assert.equal(report.status, 'pass')
  assert.deepEqual(ids(report), [])
  assert.equal(report.summary.costMicros, 3)
  assert.equal(report.summary.retries, 1)
})

test('an oversized terminal response from a local adapter is incomplete before grading or hashing', () => {
  const input = oneCase()
  const report = evaluateDataset(input, {
    limits: { maxTextChars: 9 }, now: () => 0,
    adapter: () => ({ attempts: [{ response: 'long-answer', costMicros: 1 }] }),
  })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['text-limit-exceeded'])
  assert.deepEqual(report.cases[0].checks, [])
})

test('local adapter attempts consume the total attempt limit across cases', () => {
  const input = oneCase()
  input.cases.push({ ...structuredClone(input.cases[0]), id: 'B' })
  const report = evaluateDataset(input, {
    limits: { maxAttempts: 2 }, now: () => 0,
    adapter: () => ({ attempts: [{ response: 'ok', costMicros: 0 }, { response: 'ok', costMicros: 0 }] }),
  })
  assert.equal(report.status, 'incomplete')
  assert.ok(ids(report).includes('attempt-limit-exceeded'))
})

test('a synchronous local adapter supplies attempts, but a promise is not silently accepted', () => {
  const input = oneCase()
  input.cases[0].mock.attempts[0].response = 'not-used'
  const good = evaluateDataset(input, { now: () => 0, adapter: ({ id, seed }) => {
    assert.equal(id, 'A')
    assert.equal(seed, 11)
    return { attempts: [{ response: 'ok', costMicros: 1 }] }
  } })
  assert.equal(good.status, 'pass')
  const promised = evaluateDataset(input, { now: () => 0, adapter: () => Promise.resolve({ attempts: [{ response: 'ok', costMicros: 1 }] }) })
  assert.equal(promised.status, 'incomplete')
  assert.deepEqual(ids(promised), ['adapter-invalid'])
})

test('contains and excludes are literal deterministic checks, not regexes', () => {
  const input = oneCase()
  input.cases[0].assertions = [{ kind: 'contains', expected: '[ok]' }, { kind: 'excludes', expected: 'wrong' }]
  input.cases[0].mock.attempts[0].response = 'literal [ok] result'
  const report = evaluateDataset(input, { now: () => 0 })
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.cases[0].checks.map((check) => check.status), ['pass', 'pass'])
})

test('seed changes local execution order reproducibly after code-unit ID ordering', () => {
  const input = oneCase()
  input.cases = [
    { ...structuredClone(input.cases[0]), id: 'Z' },
    { ...structuredClone(input.cases[0]), id: 'A' },
  ]
  input.seed = 0
  const zero = evaluateDataset(input, { now: () => 0 })
  const again = evaluateDataset(input, { now: () => 0 })
  input.seed = 1
  const one = evaluateDataset(input, { now: () => 0 })
  assert.deepEqual(zero.executionOrder, ['A', 'Z'])
  assert.deepEqual(one.executionOrder, ['Z', 'A'])
  assert.equal(renderReport(zero), renderReport(again))
})
