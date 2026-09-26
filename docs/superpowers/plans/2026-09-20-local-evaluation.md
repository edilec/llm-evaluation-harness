# Local Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a seeded, offline task dataset through local attempts and report deterministic assertion and budget outcomes.

**Architecture:** A bounded JSON reader feeds a pure evaluator. The CLI selects embedded mock attempts or a separately exported local response fixture; library callers may supply a synchronous callback. One frozen rule table controls finding severity and incompleteness.

**Tech Stack:** Node.js ESM >=22, `node:test`, `node:assert/strict`, `node:crypto`, no dependencies.

**Spec:** `docs/design.md`

## Global Constraints

- No network/provider integrations, database, browser, file writes or dependencies.
- Local callback behavior is caller-owned; no promise accepted.
- Terminal attempt is authoritative; unknown evidence is incomplete, not pass.
- All untrusted text in output is sanitized or represented by digest/length.
- Deterministic code-unit ordering and injected clock; both sides of every bound tested.

---

### Task 1: Bounded dataset and report contract

**Files:** Create `src/index.mjs`, `test/input.test.mjs`; modify `package.json`.

**Interfaces:** `evaluateDataset(dataset, {adapter, now, limits} = {})` returns a report; `readDataset(path, {maxBytes, now, timeoutMs})` returns parsed JSON or an input-error result; `renderReport(report)` adds one newline; `exitCodeFor(report)` returns 0/1/2.

- [ ] Write a good-case test first: `assert.equal(report.status, 'pass')` for one valid case and `assert.deepEqual(report.findings, [])`.
- [ ] Run `node --test test/input.test.mjs`; verify the missing implementation causes the red result.
- [ ] Implement the smallest schema/limit/report path, including strict UTF-8 and JSON nesting checks; an input error becomes `status: 'incomplete'` with one `input-unreadable` or `input-invalid` finding, while bad CLI configuration gets no report.
- [ ] Add N/N+1 tests for `maxBytes`, `maxCases`, `maxAssertions`, `maxAttempts`, `maxDepth`, `timeoutMs`, watching each new test fail before its guard exists.
- [ ] Run focused tests; commit `feat: add bounded local evaluation input`.

### Task 2: Seeded execution, attempts, assertions and budgets

**Files:** Modify `src/index.mjs`; create `test/evaluation.test.mjs`.

**Interfaces:** A case is `{id,prompt,assertions:[{kind,expected?}],mock:{attempts:[{response?,error?,costMicros?}]}}`; policy is `{maxCostMicros,maxRetries}`. A callback receives `{id,prompt,seed}` and returns `{attempts}` synchronously. The report carries `cases`, `executionOrder`, `summary`, `findings`.

- [ ] Write a case with terminal response `wrong` against `{kind:'exact',expected:'right'}`; assert `status: 'fail'`, CLI-equivalent exit 1, `assertion-failed` and per-case evidence digests, then run red.
- [ ] Implement code-unit ID ordering, seeded 32-bit shuffle, exact/contains/excludes/manual grading and frozen severity vocabulary; run green.
- [ ] Write a terminal error after an earlier good response; assert incomplete, terminal state and retry count, then run red and implement. Similarly test missing cost, manual grade, over-budget cost and retry counts independently.
- [ ] Assert identical seed/input gives byte-identical report and distinct seeded order for a chosen multi-case fixture; mutate a rule severity and the terminal-attempt selection to watch named tests fail.
- [ ] Run focused tests; commit `feat: grade local attempts and budgets`.

### Task 3: CLI, examples and operator documentation

**Files:** Create `bin/llm-evaluation-harness.mjs`, `examples/*.json`, `test/cli.test.mjs`; replace `README.md`, `docs/README.md`; modify `package.json`.

**Interfaces:** `--dataset FILE [--responses FILE] [--json] [limit flags]`; stdout is exactly one JSON report; invalid usage is empty stdout/exit 2; incomplete input is report/exit 2.

- [ ] Write subprocess tests for a clean fixture, failing assertion, unknown option, unreadable file and local response override; run red.
- [ ] Implement CLI wiring, help, limit parsing and no network code; add `lint`, `test`, `check`, and example scripts.
- [ ] Document what/why/quick start/schema/rules/limits/exit shapes/evidence caveats/non-goals; add passing and failing runnable examples.
- [ ] Run all tests and `npm run check`; exercise examples, run a deliberate rule/guard mutation and verify the named test fails, scan for raw controls and attribution text, `git diff --check`; commit `feat: ship offline evaluation CLI`.
