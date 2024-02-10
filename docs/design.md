# Local evaluation design

This tool evaluates exported tasks, not a live model. It never opens a network
connection or executes a provider command. The default adapter reads a mock
attempt sequence embedded in each case. A separate local JSON response export
may replace those sequences at the CLI. Library callers may provide a
**synchronous**, local function adapter; it receives a case ID, prompt and
seed, and returns the same attempt sequence. A returned promise or malformed
sequence is missing evidence, not a successful answer. The caller controls
what its own function does; the tool ships no provider integration.

The versioned dataset is JSON with `schemaVersion: "1"`, an unsigned 32-bit
integer `seed`, a nonempty `cases` array, and a `policy`. Case IDs are unique
short ASCII identifiers. Each case has a prompt, a nonempty array of named
assertions (`exact`, `contains`, `excludes`, or `manual`), and a `mock` object
with ordered `attempts`. An attempt has either a string `response` or a local
error marker, plus a nonnegative integer `costMicros` when known. The optional
response export has `schemaVersion: "1"` and a map from case ID to those mock
objects. The policy declares `maxCostMicros` and `maxRetries`; these are
evaluation budgets, not estimated provider charges. An assertion's expected
literal is required except for `manual`, which is explicitly undetermined.

The harness sorts IDs by UTF-16 code unit, then uses a documented seeded
32-bit shuffle to choose execution order. The terminal attempt is
authoritative: deterministic exact/contains/excludes assertions grade its
valid response; a terminal error or missing response makes the case incomplete
even when an earlier attempt succeeded. Previous attempts/retries and all
declared costs remain visible.
A known failed assertion or exceeded known budget fails the run. Missing
response, malformed adapter result, manual grade, or missing cost needed for
the budget makes it incomplete (exit 2), never a pass. The report contains
per-case assertion outcomes, attempts/retries, cost totals or null, and
bounded SHA-256/length evidence rather than prompt or response text. A
complete run with no errors passes; completed failures exit 1.

`--dataset` is required; `--responses` names an optional local fixture.
Configuration errors have empty stdout and exit 2. Once an input is named,
unreadable, invalid UTF-8/JSON/schema, or over-limit evidence produces an
incomplete JSON report and exit 2. Limits cover bytes per input, cases,
assertions, attempts, JSON nesting and elapsed processing time. The clock is
injected for tests; checks are cooperative, so a single filesystem operation
or supplied synchronous callback can overshoot before the next check. Every
limit has a test at N and N+1. Findings have frozen named severities and
deterministic order. No report, example or test contains real personal data.

The package ships `src/`, `bin/`, examples with one passing and one failing
dataset, `node:test` cases, zero dependencies, and `lint`, `test`, `check`
scripts. The README documents the JSON fields, rule table, exit shapes,
limits, uncertainty, offline boundary and non-goals. Each behavioral guarantee
gets a test shown to fail when its guard or rule is removed.
