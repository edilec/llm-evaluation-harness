# LLM Evaluation Harness

Run repeatable, local checks over exported language-model tasks. This is a
reporter for a deliberately narrow question: did the *supplied responses*
satisfy named literal assertions and declared retry/cost budgets? It does not
ask a live model, infer factual truth, or turn a manual judgement into a score.

Zero runtime and development dependencies; Node.js 22+ and the standard
library suffice. The tool reads files and emits a report; it writes no file,
contacts no provider, resolves no host, and sends no telemetry. Do not place
real personal data or credentials in datasets. The report withholds raw prompts
and responses, but local input files still contain them.

## Quick start

```sh
node bin/llm-evaluation-harness.mjs --dataset examples/passing.json
node bin/llm-evaluation-harness.mjs --dataset examples/failing.json --json
node bin/llm-evaluation-harness.mjs --dataset examples/passing.json --responses examples/local-responses.json --json
npm run check
```

The first command exits 0, the second exits 1, and the third uses only the
named local response export. stdout is one JSON report and a final newline;
without `--json` a short human summary goes to stderr. `--help` is on stderr.

## Input contract

The dataset is versioned JSON:

```json
{
  "schemaVersion": "1",
  "seed": 7,
  "policy": { "maxCostMicros": 10, "maxRetries": 1 },
  "cases": [{
    "id": "sample-pass",
    "prompt": "Return green",
    "assertions": [{ "kind": "exact", "expected": "green" }],
    "mock": { "attempts": [{ "response": "green", "costMicros": 2 }] }
  }]
}
```

IDs must be unique ASCII strings beginning with a letter and followed by up
to 63 letters, digits, `_` or `-`. The unsigned 32-bit `seed` drives a
reproducible Fisher–Yates shuffle: first sort IDs by UTF-16 code unit, then
use `state = (1664525 * state + 1013904223) mod 2^32` at each descending
position and swap with `state mod (position + 1)`. The report includes the
execution order; no global random or wall clock value is used for selection.

Assertions are `exact`, `contains`, `excludes` (all case-sensitive literal
string comparisons), or `manual` (always unknown until a separate human
review). Prompts and non-manual expected strings must contain a visible
character after whitespace, controls and default-ignorable characters are
removed; otherwise the evidence is incomplete. This does not alter the
literal comparison of valid strings. The default mock
adapter consumes ordered local attempts in each case. An attempt has either
`response` text or an `error` marker, and may have `costMicros`, a declared
nonnegative integer in micro-units. This is an input estimate, never a bill
or measured provider cost. Costs sum across *all* attempts. The terminal
attempt alone supplies the response to grade. A terminal error or missing
response remains incomplete even if a previous attempt had the right answer.

`--responses FILE` takes a separate versioned export of the form
`{"schemaVersion":"1","responses":{"case-id":{"attempts":[...]}}}`.
It replaces, rather than merges with, in-dataset mocks. A missing case in
that map is missing evidence and exits 2; malformed/unknown IDs are refused.
Library callers can instead pass `evaluateDataset(dataset, {adapter})`, where
`adapter({id,prompt,seed})` synchronously returns `{attempts}`. A promise is
not accepted. The tool ships no provider/API adapter and cannot guarantee
what a caller-supplied function does; only supply a pure local callback.

The policy budgets are aggregate: `maxCostMicros` and `maxRetries` apply to
the entire run. A known overrun fails; missing adapter attempts leave both
aggregate retries and cost unknown (null), not zero. The per-case report
includes attempts, retries,
declared cost or null, and assertion status. Evidence is only SHA-256 and
UTF-16 length of expected and actual strings, never their raw contents.
Those hashes can still reveal low-entropy strings by guessing; do not publish
reports for sensitive datasets without reviewing them.

## Rule table

| Rule ID | Severity | Effect |
| --- | --- | --- |
| `assertion-failed` | error | Known literal comparison failed; fail. |
| `cost-budget-exceeded`, `retry-budget-exceeded` | error | Known aggregate budget overrun; fail. |
| `response-missing`, `adapter-invalid` | error | Terminal response or local adapter evidence unavailable; incomplete. |
| `cost-unknown`, `grade-undetermined` | warning | Cost or manual grade cannot be decided; incomplete. |
| `input-invalid`, `input-unreadable` | error | Named dataset or response export unusable; incomplete. |
| `byte-limit-exceeded`, `case-limit-exceeded`, `assertion-limit-exceeded`, `attempt-limit-exceeded`, `text-limit-exceeded`, `depth-limit-exceeded`, `analysis-timeout` | error | Required work crossed a bound; incomplete. |

Known failures never become passes. If any evidence needed by a check is
unknown, aggregate status is `incomplete` even when another known check also
failed. Findings sort by `(location.file, location.pointer, ruleId)` in code-unit
order; case execution order is separately seeded. Input IDs are validated
before rendering, and raw prompts, responses and error markers never reach
messages or evidence.

## Limits and exit codes

| Flag | Default | Meaning |
| --- | ---: | --- |
| `--max-bytes` | 1048576 | Bytes in each named JSON file, read only to N+1. |
| `--max-cases` | 1000 | Cases in dataset. |
| `--max-assertions` | 10000 | Total assertions. |
| `--max-attempts` | 10000 | Total mock/fixture/callback attempts. |
| `--max-text-chars` | 65536 | UTF-16 code units in each prompt, expected value or attempt text. |
| `--max-depth` | 16 | Object/array nesting depth. |
| `--timeout-ms` | 30000 | Elapsed processing time after configuration. |

The library `limits` object uses camelCase names and refuses unknown keys;
each override is a positive safe integer within a finite hard cap. Every
bound is silent at N and incomplete at N+1. Duplicate JSON object keys in
either named file, including escaped spellings of the same key, are incomplete
evidence rather than last-value-wins input. The clock is injectable with
`now` (default `Date.now`), and its value is never printed. Timeout checks
are cooperative; one filesystem operation, JSON parse or supplied synchronous
callback may overrun before the next check. Actual elapsed time can vary under
load; a completed report is byte-identical for the same input, seed and
adapter results.

| Exit | stdout | Meaning |
| ---: | --- | --- |
| 0 | pass JSON | Complete and policy satisfied. |
| 1 | fail JSON | Complete, known assertion or budget failure. |
| 2 | empty | Invalid option/configuration; diagnostic on stderr. |
| 2 | incomplete JSON | Named input missing/invalid, unknown grade/cost/response, or a bound exceeded. |

## Limits of the claim

Literal string predicates are not semantic correctness, safety, retrieval
quality or a judge model. Hash evidence is not proof of truth. The tool never
retries a model itself: it only reports the sequence supplied in the export.
There is no provider request, network access, account modification, or
destructive action. This package does not run arbitrary code from JSON; only
a library caller that explicitly supplies a function controls that function.

MIT licensed; see [LICENSE](./LICENSE).
