import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluateDataset, exitCodeFor, readDataset, renderReport } from '../src/index.mjs'

const dataset = {
  schemaVersion: '1',
  seed: 7,
  policy: { maxCostMicros: 10, maxRetries: 1 },
  cases: [{
    id: 'case-1', prompt: 'Reply alpha',
    assertions: [{ kind: 'exact', expected: 'alpha' }],
    mock: { attempts: [{ response: 'alpha', costMicros: 2 }] },
  }],
}

test('correct local mock answer passes with one graded case and no findings', () => {
  const report = evaluateDataset(dataset, { now: () => 0 })
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.executionOrder, ['case-1'])
  assert.equal(report.summary.checked, 1)
  assert.equal(report.cases[0].status, 'pass')
  assert.equal(report.cases[0].costMicros, 2)
  assert.equal(renderReport(report).endsWith('\n'), true)
})

test('shared in-memory assertion arrays are valid but a genuine dataset cycle is incomplete', () => {
  const input = structuredClone(dataset)
  const second = { ...structuredClone(input.cases[0]), id: 'case-2', assertions: input.cases[0].assertions }
  input.cases.push(second)
  const shared = evaluateDataset(input, { now: () => 0 })
  assert.equal(shared.status, 'pass')
  assert.equal(shared.summary.checked, 2)
  assert.deepEqual(shared.findings, [])
  assert.deepEqual(shared, evaluateDataset(JSON.parse(JSON.stringify(input)), { now: () => 0 }))

  input.extra = input
  const cyclic = evaluateDataset(input, { now: () => 0 })
  assert.equal(cyclic.status, 'incomplete')
  assert.deepEqual(ruleIds(cyclic), ['input-invalid'])
})

const clone = () => structuredClone(dataset)
const ruleIds = (report) => report.findings.map((finding) => finding.ruleId)

test('case count is accepted at N and incomplete at N+1', () => {
  const one = evaluateDataset(clone(), { limits: { maxCases: 1 }, now: () => 0 })
  const two = clone()
  two.cases.push({ ...structuredClone(two.cases[0]), id: 'case-2' })
  const exceeded = evaluateDataset(two, { limits: { maxCases: 1 }, now: () => 0 })
  assert.equal(one.status, 'pass')
  assert.equal(exceeded.status, 'incomplete')
  assert.deepEqual(ruleIds(exceeded), ['case-limit-exceeded'])
  assert.equal(exceeded.summary.checked, 0)
})

test('assertion and attempt count are accepted at N and incomplete at N+1', () => {
  const one = evaluateDataset(clone(), { limits: { maxAssertions: 1, maxAttempts: 1 }, now: () => 0 })
  const twoAssertions = clone()
  twoAssertions.cases[0].assertions.push({ kind: 'contains', expected: 'alpha' })
  const twoAttempts = clone()
  twoAttempts.cases[0].mock.attempts.push({ response: 'alpha', costMicros: 1 })
  assert.equal(one.status, 'pass')
  assert.deepEqual(ruleIds(evaluateDataset(twoAssertions, { limits: { maxAssertions: 1 }, now: () => 0 })), ['assertion-limit-exceeded'])
  assert.deepEqual(ruleIds(evaluateDataset(twoAttempts, { limits: { maxAttempts: 1 }, now: () => 0 })), ['attempt-limit-exceeded'])
})

test('the nesting limit accepts the exact depth of a legal dataset and fires one below', () => {
  assert.equal(evaluateDataset(clone(), { limits: { maxDepth: 6 }, now: () => 0 }).status, 'pass')
  assert.deepEqual(ruleIds(evaluateDataset(clone(), { limits: { maxDepth: 5 }, now: () => 0 })), ['depth-limit-exceeded'])
})

test('timeout stays silent at N and produces incomplete at N+1 with an injected clock', () => {
  let reads = 0
  const atLimit = evaluateDataset(clone(), { limits: { timeoutMs: 5 }, now: () => (reads++ === 0 ? 0 : 5) })
  reads = 0
  const exceeded = evaluateDataset(clone(), { limits: { timeoutMs: 5 }, now: () => (reads++ === 0 ? 0 : 6) })
  assert.equal(atLimit.status, 'pass')
  assert.deepEqual(ruleIds(exceeded), ['analysis-timeout'])
  assert.equal(exceeded.status, 'incomplete')
  assert.equal(exitCodeFor(exceeded), 2)
})

test('text size accepts exactly N characters and becomes incomplete at N+1', () => {
  assert.equal(evaluateDataset(clone(), { limits: { maxTextChars: 11 }, now: () => 0 }).status, 'pass')
  assert.deepEqual(ruleIds(evaluateDataset(clone(), { limits: { maxTextChars: 10 }, now: () => 0 })), ['text-limit-exceeded'])
})

test('unusable dataset IDs and empty case lists are incomplete, not clean', () => {
  const invalid = clone()
  invalid.cases[0].id = 'secret\u202e\nline'
  assert.deepEqual(ruleIds(evaluateDataset(invalid, { now: () => 0 })), ['input-invalid'])
  assert.ok(!renderReport(evaluateDataset(invalid, { now: () => 0 })).includes('secret'))
  const empty = clone()
  empty.cases = []
  assert.equal(evaluateDataset(empty, { now: () => 0 }).status, 'incomplete')
})

test('visually empty prompts and assertion operands are unknown, not passing comparisons', () => {
  const valid = clone()
  assert.equal(evaluateDataset(valid, { now: () => 0 }).status, 'pass')

  const hiddenPrompt = clone()
  hiddenPrompt.cases[0].prompt = '\u200b'
  const promptReport = evaluateDataset(hiddenPrompt, { now: () => 0 })
  assert.equal(promptReport.status, 'incomplete')
  assert.deepEqual(ruleIds(promptReport), ['input-invalid'])
  assert.equal(promptReport.summary.checked, 0)

  const hiddenExpected = clone()
  hiddenExpected.cases[0].assertions = [{ kind: 'exact', expected: '\u200b' }]
  hiddenExpected.cases[0].mock.attempts[0].response = '\u200b'
  const assertionReport = evaluateDataset(hiddenExpected, { now: () => 0 })
  assert.equal(assertionReport.status, 'incomplete')
  assert.deepEqual(ruleIds(assertionReport), ['input-invalid'])
  assert.equal(assertionReport.summary.checked, 0)
})

test('an attempt cannot claim both a response and an error', () => {
  const input = clone()
  input.cases[0].mock.attempts[0].error = 'failed'
  const report = evaluateDataset(input, { now: () => 0 })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['input-invalid'])
})

test('unknown library limit is invalid configuration, not an ignored green run', () => {
  assert.throws(() => evaluateDataset(clone(), { limits: { maxCase: 1 } }), /Unknown limit/)
})

test('file reader accepts exactly N bytes and reports N+1, unreadable and malformed evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'llm-eval-test-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }) })
  const good = join(root, 'dataset.json')
  const encoded = Buffer.from(JSON.stringify(dataset))
  await writeFile(good, encoded)
  assert.equal((await readDataset(good, { limits: { maxBytes: encoded.length }, now: () => 0 })).status, 'pass')
  assert.deepEqual(ruleIds(await readDataset(good, { limits: { maxBytes: encoded.length - 1 }, now: () => 0 })), ['byte-limit-exceeded'])
  assert.deepEqual(ruleIds(await readDataset(join(root, 'missing.json'), { now: () => 0 })), ['input-unreadable'])
  await writeFile(join(root, 'bad.json'), Buffer.from([0xff]))
  assert.deepEqual(ruleIds(await readDataset(join(root, 'bad.json'), { now: () => 0 })), ['input-invalid'])
})

test('an invalid injected clock is configuration failure, not an input report', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'llm-eval-clock-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }) })
  const path = join(root, 'dataset.json')
  await writeFile(path, JSON.stringify(dataset))
  let reads = 0
  await assert.rejects(readDataset(path, { now: () => (reads++ === 0 ? 0 : NaN) }), /now must return a finite number/)
})

test('a named non-file is unreadable evidence, not silently parsed as empty JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'llm-eval-directory-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }) })
  const report = await readDataset(root, { now: () => 0 })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['input-unreadable'])
})
