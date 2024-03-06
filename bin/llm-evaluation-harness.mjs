#!/usr/bin/env node

import {
  ConfigError, DEFAULT_LIMITS, TOOL_ID, exitCodeFor, readDataset, renderReport,
} from '../src/index.mjs'

const HELP = `${TOOL_ID}

Evaluate a seeded local task dataset with deterministic rules. The default
adapter reads mock attempts in the dataset. A separate local response export
can replace them; no provider is contacted and no request is sent.

Usage: ${TOOL_ID} --dataset FILE [--responses FILE] [--json] [limits]

Options:
  --dataset FILE       Local versioned JSON dataset (required)
  --responses FILE     Optional local response export; never a URL
  --json                Omit the human summary on stderr
  --max-bytes N         Per-input byte limit (default ${DEFAULT_LIMITS.maxBytes})
  --max-cases N         Case count limit (default ${DEFAULT_LIMITS.maxCases})
  --max-assertions N    Total assertion limit (default ${DEFAULT_LIMITS.maxAssertions})
  --max-attempts N      Total attempt limit (default ${DEFAULT_LIMITS.maxAttempts})
  --max-text-chars N    Per-text UTF-16 code-unit limit (default ${DEFAULT_LIMITS.maxTextChars})
  --max-depth N         JSON/object nesting limit (default ${DEFAULT_LIMITS.maxDepth})
  --timeout-ms N        Processing time budget (default ${DEFAULT_LIMITS.timeoutMs})
  -h, --help            Show this help

Exit: 0 evaluated/pass; 1 evaluated/policy failed; 2 invalid usage (empty
stdout) or incomplete named evidence (JSON report on stdout).
`

const LIMIT_FLAGS = Object.freeze({
  '--max-bytes': 'maxBytes', '--max-cases': 'maxCases',
  '--max-assertions': 'maxAssertions', '--max-attempts': 'maxAttempts',
  '--max-text-chars': 'maxTextChars', '--max-depth': 'maxDepth',
  '--timeout-ms': 'timeoutMs',
})

function parse(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  const parsed = { dataset: null, responses: undefined, json: false, limits: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') { parsed.json = true; continue }
    if (flag !== '--dataset' && flag !== '--responses' && !Object.hasOwn(LIMIT_FLAGS, flag)) {
      throw new ConfigError('Unknown option')
    }
    const raw = argv[++index]
    if (raw === undefined || raw.length === 0 || raw.startsWith('--')) throw new ConfigError(`${flag} requires a value`)
    if (flag === '--dataset') parsed.dataset = raw
    else if (flag === '--responses') parsed.responses = raw
    else {
      if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
        throw new ConfigError(`${flag} requires a positive integer`)
      }
      parsed.limits[LIMIT_FLAGS[flag]] = Number(raw)
    }
  }
  if (parsed.dataset === null) throw new ConfigError('--dataset is required')
  return parsed
}

try {
  const options = parse(process.argv.slice(2))
  if (options.help) {
    process.stderr.write(HELP)
  } else {
    const report = await readDataset(options.dataset, {
      responsesPath: options.responses, limits: options.limits,
    })
    process.stdout.write(renderReport(report))
    if (!options.json) process.stderr.write(`${TOOL_ID}: ${report.status}; ${report.summary.checked} case(s) checked; ${report.summary.errors} error(s), ${report.summary.warnings} warning(s).\n`)
    process.exitCode = exitCodeFor(report)
  }
} catch (error) {
  process.stderr.write(`${TOOL_ID}: ${error instanceof ConfigError ? error.message : 'execution failed'}\n`)
  process.exitCode = 2
}
