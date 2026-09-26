import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { hasDuplicateObjectKeys } from './json.mjs'

export const TOOL_ID = 'llm-evaluation-harness'
export const SCHEMA_VERSION = '1'

export const byCodeUnit = (a, b) => (a === b ? 0 : a < b ? -1 : 1)
export class ConfigError extends Error {}
class DeadlineExceeded extends Error {}

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1048576,
  maxCases: 1000,
  maxAssertions: 10000,
  maxAttempts: 10000,
  maxTextChars: 65536,
  maxDepth: 16,
  timeoutMs: 30000,
})

const HARD_LIMITS = Object.freeze({
  maxBytes: 16777216, maxCases: 10000, maxAssertions: 100000,
  maxAttempts: 100000, maxDepth: 64, timeoutMs: 3600000,
  maxTextChars: 1048576,
})

export const RULES = Object.freeze({
  'assertion-failed': Object.freeze({ severity: 'error', incomplete: false }),
  'response-missing': Object.freeze({ severity: 'error', incomplete: true }),
  'adapter-invalid': Object.freeze({ severity: 'error', incomplete: true }),
  'cost-unknown': Object.freeze({ severity: 'warning', incomplete: true }),
  'grade-undetermined': Object.freeze({ severity: 'warning', incomplete: true }),
  'cost-budget-exceeded': Object.freeze({ severity: 'error', incomplete: false }),
  'retry-budget-exceeded': Object.freeze({ severity: 'error', incomplete: false }),
  'input-invalid': Object.freeze({ severity: 'error', incomplete: true }),
  'input-unreadable': Object.freeze({ severity: 'error', incomplete: true }),
  'byte-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'case-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'assertion-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'attempt-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'text-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'depth-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'analysis-timeout': Object.freeze({ severity: 'error', incomplete: true }),
})

export function validateLimits(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new ConfigError('limits must be an object')
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new ConfigError(`Unknown limit "${key}"`)
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) {
      throw new ConfigError(`${key} must be a positive integer at most ${HARD_LIMITS[key]}`)
    }
  }
  return { ...DEFAULT_LIMITS, ...overrides }
}

function deadline(now, timeoutMs) {
  if (typeof now !== 'function') throw new ConfigError('now must be a function')
  let start
  try { start = now() } catch { throw new ConfigError('now must return a finite number') }
  if (!Number.isFinite(start)) throw new ConfigError('now must return a finite number')
  return () => {
    let current
    try { current = now() } catch { throw new ConfigError('now must return a finite number') }
    if (!Number.isFinite(current)) throw new ConfigError('now must return a finite number')
    if (current - start > timeoutMs) throw new DeadlineExceeded()
  }
}

function incomplete(ruleId, pointer, message) {
  return {
    schemaVersion: SCHEMA_VERSION, tool: TOOL_ID, status: 'incomplete',
    seed: null, executionOrder: [],
    summary: { checked: 0, errors: 1, warnings: 0, retries: 0, costMicros: null },
    cases: [], findings: [finding(ruleId, pointer, message)],
  }
}

function depthProblem(value, limits, checkDeadline) {
  const pending = [{ value, depth: 1 }]
  const active = new WeakSet()
  while (pending.length > 0) {
    checkDeadline()
    const { value, depth, leaving } = pending.pop()
    if (leaving) { active.delete(value); continue }
    if (depth > limits.maxDepth) return ['depth-limit-exceeded', '', `JSON nesting exceeds ${limits.maxDepth}.`]
    if (value === null || typeof value !== 'object') continue
    if (active.has(value)) return ['input-invalid', '', 'Input has a cycle.']
    active.add(value)
    pending.push({ value, leaving: true })
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push({ value: child, depth: depth + 1 })
  }
  return null
}

function validAttempt(attempt) {
  return attempt !== null && typeof attempt === 'object' && !Array.isArray(attempt)
    && (typeof attempt.response === 'string') !== (typeof attempt.error === 'string')
    && (attempt.costMicros === undefined || (Number.isSafeInteger(attempt.costMicros) && attempt.costMicros >= 0))
}

function hasVisibleText(value) {
  return typeof value === 'string'
    && value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, '').trim().length > 0
}

function inspectDataset(dataset, limits, checkDeadline) {
  if (dataset === null || typeof dataset !== 'object' || Array.isArray(dataset)) return ['input-invalid', '', 'Dataset must be an object.']
  const nesting = depthProblem(dataset, limits, checkDeadline)
  if (nesting !== null) return nesting
  if (dataset.schemaVersion !== SCHEMA_VERSION || !Number.isInteger(dataset.seed) || dataset.seed < 0 || dataset.seed > 0xffffffff
    || !Array.isArray(dataset.cases) || dataset.policy === null || typeof dataset.policy !== 'object'
    || !Number.isSafeInteger(dataset.policy.maxCostMicros) || dataset.policy.maxCostMicros < 0
    || !Number.isSafeInteger(dataset.policy.maxRetries) || dataset.policy.maxRetries < 0) {
    return ['input-invalid', '', 'Dataset version, seed, policy or cases are invalid.']
  }
  if (dataset.cases.length === 0) return ['input-invalid', '/cases', 'Dataset has no cases to evaluate.']
  if (dataset.cases.length > limits.maxCases) return ['case-limit-exceeded', '/cases', `Case count exceeds ${limits.maxCases}.`]
  let assertionCount = 0
  let attemptCount = 0
  const ids = new Set()
  for (const [index, item] of dataset.cases.entries()) {
    checkDeadline()
    if (item === null || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.id) || ids.has(item.id)
      || !hasVisibleText(item.prompt)
      || !Array.isArray(item.assertions) || item.assertions.length === 0
      || item.mock === null || typeof item.mock !== 'object' || !Array.isArray(item.mock.attempts)
      || item.mock.attempts.length === 0) {
      return ['input-invalid', `/cases/${index}`, 'A case has an invalid ID, prompt, assertion list or mock attempts.']
    }
    ids.add(item.id)
    if (item.prompt.length > limits.maxTextChars) return ['text-limit-exceeded', `/cases/${index}/prompt`, `Text exceeds ${limits.maxTextChars} characters.`]
    assertionCount += item.assertions.length
    attemptCount += item.mock.attempts.length
    if (assertionCount > limits.maxAssertions) return ['assertion-limit-exceeded', `/cases/${index}/assertions`, `Assertion count exceeds ${limits.maxAssertions}.`]
    if (attemptCount > limits.maxAttempts) return ['attempt-limit-exceeded', `/cases/${index}/mock/attempts`, `Attempt count exceeds ${limits.maxAttempts}.`]
    for (const [assertionIndex, assertion] of item.assertions.entries()) {
      checkDeadline()
      if (assertion === null || typeof assertion !== 'object' || Array.isArray(assertion)
        || !['exact', 'contains', 'excludes', 'manual'].includes(assertion.kind)
        || (assertion.kind !== 'manual' && !hasVisibleText(assertion.expected))) {
        return ['input-invalid', `/cases/${index}/assertions/${assertionIndex}`, 'An assertion is invalid.']
      }
      if (typeof assertion.expected === 'string' && assertion.expected.length > limits.maxTextChars) {
        return ['text-limit-exceeded', `/cases/${index}/assertions/${assertionIndex}`, `Text exceeds ${limits.maxTextChars} characters.`]
      }
    }
    for (const [attemptIndex, attempt] of item.mock.attempts.entries()) {
      checkDeadline()
      if (!validAttempt(attempt)) {
        return ['input-invalid', `/cases/${index}/mock/attempts/${attemptIndex}`, 'A mock attempt is invalid.']
      }
      if ((typeof attempt.response === 'string' && attempt.response.length > limits.maxTextChars)
        || (typeof attempt.error === 'string' && attempt.error.length > limits.maxTextChars)) {
        return ['text-limit-exceeded', `/cases/${index}/mock/attempts/${attemptIndex}`, `Text exceeds ${limits.maxTextChars} characters.`]
      }
    }
  }
  return null
}

const digest = (value) => createHash('sha256').update(value).digest('hex')

function executionOrder(cases, seed) {
  const ids = cases.map((item) => item.id).sort(byCodeUnit)
  let state = seed >>> 0
  for (let index = ids.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const selected = state % (index + 1)
    const previous = ids[index]
    ids[index] = ids[selected]
    ids[selected] = previous
  }
  return ids
}

function finding(ruleId, pointer, message, evidence) {
  const rule = RULES[ruleId]
  if (rule === undefined) throw new Error(`Unknown rule: ${ruleId}`)
  return {
    ruleId, severity: rule.severity, message,
    location: { file: 'dataset', pointer },
    ...(evidence === undefined ? {} : { evidence }),
  }
}

function grade(kind, expected, response) {
  if (kind === 'exact') return response === expected
  if (kind === 'contains') return response.includes(expected)
  if (kind === 'excludes') return !response.includes(expected)
  return null
}

function outcome(findings) {
  if (findings.some((item) => RULES[item.ruleId].incomplete)) return 'incomplete'
  return findings.some((item) => item.severity === 'error') ? 'fail' : 'pass'
}

function evaluateCore(dataset, { adapter, limits, checkDeadline }) {
  const order = executionOrder(dataset.cases, dataset.seed)
  const casesById = new Map(dataset.cases.map((item, index) => [item.id, { item, index }]))
  const findings = []
  let adapterAttempts = 0
  const results = order.map((id) => {
    checkDeadline()
    const { item, index } = casesById.get(id)
    const pointer = `/cases/${index}`
    const caseFindings = []
    const add = (ruleId, suffix, message, evidence) => {
      const itemFinding = finding(ruleId, `${pointer}${suffix}`, message, evidence)
      findings.push(itemFinding)
      caseFindings.push(itemFinding)
    }
    let supplied
    try {
      supplied = adapter === undefined ? item.mock : adapter({ id, prompt: item.prompt, seed: dataset.seed })
    } catch {
      supplied = null
    }
    if (supplied === undefined && adapter !== undefined) {
      add('response-missing', '/mock/attempts', 'The local response fixture has no response for this case.')
    } else if (supplied === null || typeof supplied !== 'object' || typeof supplied.then === 'function'
      || !Array.isArray(supplied.attempts) || supplied.attempts.length === 0) {
      add('adapter-invalid', '', 'The local adapter did not supply a synchronous attempt sequence.')
    }
    const attempts = Array.isArray(supplied?.attempts) ? supplied.attempts : []
    adapterAttempts += attempts.length
    if (adapterAttempts > limits.maxAttempts) {
      add('attempt-limit-exceeded', '/mock/attempts', `Attempt count exceeds ${limits.maxAttempts}.`)
      return { id, status: 'incomplete', attempts: attempts.length, retries: null, costMicros: null, checks: [] }
    }
    if (caseFindings.length > 0) {
      return { id, status: 'incomplete', attempts: attempts.length, retries: null, costMicros: null, checks: [] }
    }
    if (attempts.some((attempt) => !validAttempt(attempt))) {
      add('adapter-invalid', '/mock/attempts', 'The local adapter supplied an invalid attempt.')
      return { id, status: 'incomplete', attempts: attempts.length, retries: null, costMicros: null, checks: [] }
    }
    const terminal = attempts.at(-1)
    let costMicros = 0
    for (const attempt of attempts) {
      checkDeadline()
      if ((typeof attempt?.response === 'string' && attempt.response.length > limits.maxTextChars)
        || (typeof attempt?.error === 'string' && attempt.error.length > limits.maxTextChars)) {
        add('text-limit-exceeded', '/mock/attempts', `Text exceeds ${limits.maxTextChars} characters.`)
        return { id, status: 'incomplete', attempts: attempts.length, retries: Math.max(0, attempts.length - 1), costMicros: null, checks: [] }
      }
      if (!Number.isSafeInteger(attempt?.costMicros) || attempt.costMicros < 0) costMicros = null
      else if (costMicros !== null) {
        costMicros += attempt.costMicros
        if (!Number.isSafeInteger(costMicros)) costMicros = null
      }
    }
    if (attempts.length > 0 && costMicros === null) {
      add('cost-unknown', '/mock/attempts', 'Declared attempt cost is missing, so the cost budget cannot be evaluated.')
    }
    const checks = []
    if (typeof terminal?.response !== 'string') {
      if (!caseFindings.some((value) => value.ruleId === 'adapter-invalid' || value.ruleId === 'response-missing')) {
        add('response-missing', '/mock/attempts', 'The terminal attempt has no usable response; earlier attempts cannot stand in for it.')
      }
    } else {
      for (const [assertionIndex, assertion] of item.assertions.entries()) {
        checkDeadline()
        const result = grade(assertion.kind, assertion.expected, terminal.response)
        const status = result === null ? 'unknown' : result ? 'pass' : 'fail'
        const evidence = result === null ? null : {
          expectedSha256: digest(assertion.expected),
          actualSha256: digest(terminal.response),
          expectedLength: assertion.expected.length,
          actualLength: terminal.response.length,
        }
        checks.push({ kind: assertion.kind, status, evidence })
        if (status === 'unknown') add('grade-undetermined', `/assertions/${assertionIndex}`, 'Manual grading has no supplied judgement.')
        if (status === 'fail') add('assertion-failed', `/assertions/${assertionIndex}`, `The ${assertion.kind} assertion failed.`, evidence)
      }
    }
    return {
      id,
      status: outcome(caseFindings),
      attempts: attempts.length,
      retries: Math.max(0, attempts.length - 1),
      costMicros,
      checks,
    }
  })
  checkDeadline()
  const retries = results.some((item) => item.retries === null)
    ? null : results.reduce((sum, item) => sum + item.retries, 0)
  const missingCaseCost = results.some((item) => item.costMicros === null)
  let costMicros = missingCaseCost ? null : results.reduce((sum, item) => sum + item.costMicros, 0)
  if (costMicros !== null && !Number.isSafeInteger(costMicros)) {
    costMicros = null
    findings.push(finding('cost-unknown', '/policy/maxCostMicros', 'Aggregate declared cost exceeds safe integer precision, so the budget cannot be evaluated.'))
  }
  if (retries !== null && retries > dataset.policy.maxRetries) {
    findings.push(finding('retry-budget-exceeded', '/policy/maxRetries', `Observed ${retries} retries, above the declared budget of ${dataset.policy.maxRetries}.`))
  }
  if (costMicros !== null && costMicros > dataset.policy.maxCostMicros) {
    findings.push(finding('cost-budget-exceeded', '/policy/maxCostMicros', `Declared cost of ${costMicros} micros exceeds the budget of ${dataset.policy.maxCostMicros} micros.`))
  }
  findings.sort((a, b) => byCodeUnit(a.location.file, b.location.file)
    || byCodeUnit(a.location.pointer, b.location.pointer) || byCodeUnit(a.ruleId, b.ruleId))
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    status: outcome(findings),
    seed: dataset.seed,
    executionOrder: order,
    summary: { checked: results.length, errors: findings.filter((item) => item.severity === 'error').length, warnings: findings.filter((item) => item.severity === 'warning').length, retries, costMicros },
    cases: results,
    findings,
  }
}

export function evaluateDataset(dataset, { adapter, limits: overrides, now = Date.now } = {}) {
  const limits = validateLimits(overrides)
  if (adapter !== undefined && typeof adapter !== 'function') throw new ConfigError('adapter must be a synchronous function')
  const checkDeadline = deadline(now, limits.timeoutMs)
  return evaluateWithDeadline(dataset, { adapter, limits, checkDeadline })
}

function evaluateWithDeadline(dataset, options) {
  try {
    const problem = inspectDataset(dataset, options.limits, options.checkDeadline)
    if (problem !== null) return incomplete(...problem)
    return evaluateCore(dataset, options)
  } catch (error) {
    if (!(error instanceof DeadlineExceeded)) throw error
    return incomplete('analysis-timeout', '', `Evaluation exceeded the ${options.limits.timeoutMs} ms time budget; no partial grade is published.`)
  }
}

async function readJson(path, limits, checkDeadline) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    checkDeadline()
    if (!(await handle.stat()).isFile()) return { problem: ['input-unreadable', '', 'The named input is not a regular file.'] }
    const buffer = Buffer.alloc(limits.maxBytes + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null)
      checkDeadline()
      if (bytesRead === 0) break
      used += bytesRead
    }
    if (used > limits.maxBytes) return { problem: ['byte-limit-exceeded', '', `Input exceeds ${limits.maxBytes} bytes.`] }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))
      const data = JSON.parse(text)
      if (hasDuplicateObjectKeys(text)) return { problem: ['input-invalid', '', 'Input has duplicate JSON keys.'] }
      checkDeadline()
      return { data }
    } catch (error) {
      if (error instanceof DeadlineExceeded) throw error
      return { problem: ['input-invalid', '', 'Input is not valid UTF-8 JSON.'] }
    }
  } catch (error) {
    if (error instanceof DeadlineExceeded || error instanceof ConfigError) throw error
    return { problem: ['input-unreadable', '', 'The named input could not be read.'] }
  } finally {
    await handle?.close()
  }
}

function inspectFixture(fixture, dataset, limits, checkDeadline) {
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)
    || fixture.schemaVersion !== SCHEMA_VERSION || fixture.responses === null
    || typeof fixture.responses !== 'object' || Array.isArray(fixture.responses)) {
    return ['input-invalid', '', 'Response fixture version or response map is invalid.']
  }
  const nesting = depthProblem(fixture, limits, checkDeadline)
  if (nesting !== null) return nesting
  const known = new Set(dataset.cases.map((item) => item.id))
  let count = 0
  for (const [id, response] of Object.entries(fixture.responses)) {
    checkDeadline()
    if (!known.has(id) || response === null || typeof response !== 'object' || !Array.isArray(response.attempts)
      || response.attempts.length === 0) return ['input-invalid', '/responses', 'Response fixture has an unknown case ID or invalid attempt sequence.']
    count += response.attempts.length
    if (count > limits.maxAttempts) return ['attempt-limit-exceeded', '/responses', `Attempt count exceeds ${limits.maxAttempts}.`]
    for (const attempt of response.attempts) {
      checkDeadline()
      if (!validAttempt(attempt)) {
        return ['input-invalid', '/responses', 'Response fixture has an invalid attempt.']
      }
      if ((typeof attempt.response === 'string' && attempt.response.length > limits.maxTextChars)
        || (typeof attempt.error === 'string' && attempt.error.length > limits.maxTextChars)) {
        return ['text-limit-exceeded', '/responses', `Text exceeds ${limits.maxTextChars} characters.`]
      }
    }
  }
  return null
}

export async function readDataset(path, { adapter, responsesPath, limits: overrides, now = Date.now } = {}) {
  if (typeof path !== 'string' || path.length === 0) throw new ConfigError('dataset path is required')
  if (responsesPath !== undefined && (typeof responsesPath !== 'string' || responsesPath.length === 0)) throw new ConfigError('responses path must be non-empty')
  if (responsesPath !== undefined && adapter !== undefined) throw new ConfigError('choose a local fixture or function adapter, not both')
  const limits = validateLimits(overrides)
  if (adapter !== undefined && typeof adapter !== 'function') throw new ConfigError('adapter must be a synchronous function')
  const checkDeadline = deadline(now, limits.timeoutMs)
  try {
    const input = await readJson(path, limits, checkDeadline)
    if (input.problem) return incomplete(...input.problem)
    const dataset = input.data
    const problem = inspectDataset(dataset, limits, checkDeadline)
    if (problem !== null) return incomplete(...problem)
    if (responsesPath !== undefined) {
      const responseInput = await readJson(responsesPath, limits, checkDeadline)
      if (responseInput.problem) return incomplete(...responseInput.problem)
      const fixtureProblem = inspectFixture(responseInput.data, dataset, limits, checkDeadline)
      if (fixtureProblem !== null) return incomplete(...fixtureProblem)
      adapter = ({ id }) => responseInput.data.responses[id]
    }
    return evaluateWithDeadline(dataset, { adapter, limits, checkDeadline })
  } catch (error) {
    if (error instanceof DeadlineExceeded) return incomplete('analysis-timeout', '', `Evaluation exceeded the ${limits.timeoutMs} ms time budget; no partial grade is published.`)
    if (error instanceof ConfigError) throw error
    return incomplete('input-unreadable', '', 'The named dataset could not be read.')
  }
}

export const renderReport = (report) => `${JSON.stringify(report, null, 2)}\n`
export const exitCodeFor = (report) => (report.status === 'incomplete' ? 2 : report.status === 'fail' ? 1 : 0)
