#!/usr/bin/env node
/**
 * Structural smoke test for .github/workflows/gaia-benchmark.yml
 * (ADR-133 PR7 — CI wiring).
 *
 * Verifies the YAML is well-formed and contains every required structural
 * element without making any API calls or network requests.
 *
 * Checks:
 *   1. File is present and parses as valid YAML
 *   2. Required top-level keys exist (name, on, jobs)
 *   3. All three required triggers are present:
 *      - pull_request with labeled/synchronize types
 *      - schedule with a cron expression
 *      - workflow_dispatch with level/limit/models inputs
 *   4. workflow_dispatch inputs have correct defaults
 *   5. The 'gaia-benchmark' job is defined
 *   6. The job has an if-condition guarding against unlabeled PRs
 *   7. The job has the required permissions block
 *   8. Required step names are present (build, validate-secrets, bench, summary, upload, comment, issue, hard-fail)
 *   9. Both ANTHROPIC_API_KEY and HF_TOKEN are referenced
 *  10. The gaia-bench run command is present and uses --level / --limit flags
 *  11. Hard-fail threshold is '0.3' (spec: 30% floor)
 *  12. Regression-issue threshold is '0.6' (spec: 60%)
 *
 * Usage:
 *   node scripts/smoke-gaia-bench-schema.mjs
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more checks failed (details printed to stderr)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(__dirname, '../.github/workflows/gaia-benchmark.yml');

let failures = 0;

function pass(msg) {
  console.log(`  ok  ${msg}`);
}

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  failures++;
}

// ---------------------------------------------------------------------------
// 1. File presence
// ---------------------------------------------------------------------------
console.log('[1/12] File presence');
if (!existsSync(WORKFLOW)) {
  fail(`gaia-benchmark.yml not found at ${WORKFLOW}`);
  console.error('Cannot continue — file missing.');
  process.exit(1);
}
pass('gaia-benchmark.yml exists');

// ---------------------------------------------------------------------------
// 2. Parse YAML (requires python3 — universally available on GitHub runners)
// ---------------------------------------------------------------------------
console.log('[2/12] YAML parse');
let doc;
try {
  const raw = readFileSync(WORKFLOW, 'utf-8');
  // Use python3 to parse — avoids introducing a JS YAML dependency.
  const jsonOut = execFileSync('python3', [
    '-c',
    `import sys, yaml, json; print(json.dumps(yaml.safe_load(sys.stdin.read())))`,
  ], { input: raw, encoding: 'utf-8' });
  doc = JSON.parse(jsonOut);
  pass('YAML parses without errors');
} catch (e) {
  fail(`YAML parse failed: ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Required top-level keys
// ---------------------------------------------------------------------------
console.log('[3/12] Required top-level keys');
// NOTE: python3 yaml.safe_load parses the YAML key `on` as boolean true
// (YAML 1.1 bare-word boolean quirk). We must look it up as true, not "on".
// GitHub Actions accepts `on:` as the trigger key regardless.
const ON_KEY = true; // JSON.stringify converts python True → boolean true in the output
for (const key of ['name', ON_KEY, 'jobs']) {
  const label = key === ON_KEY ? 'on' : key;
  if (doc[key] !== undefined) {
    pass(`top-level key "${label}" present`);
  } else {
    fail(`missing top-level key "${label}"`);
  }
}

// ---------------------------------------------------------------------------
// 4. Triggers
// ---------------------------------------------------------------------------
console.log('[4/12] Required triggers');
const on = doc[ON_KEY] || {};

// pull_request trigger
const pr = on['pull_request'];
if (!pr) {
  fail('missing pull_request trigger');
} else {
  pass('pull_request trigger present');
  const types = pr['types'] || [];
  if (types.includes('labeled')) pass('pull_request includes "labeled" type');
  else fail('pull_request trigger missing "labeled" type');
  if (types.includes('synchronize')) pass('pull_request includes "synchronize" type');
  else fail('pull_request trigger missing "synchronize" type');
}

// schedule trigger
const schedule = on['schedule'];
if (!schedule || !Array.isArray(schedule) || schedule.length === 0) {
  fail('missing or empty schedule trigger');
} else {
  pass('schedule trigger present');
  const cronEntry = schedule[0];
  if (cronEntry && cronEntry['cron']) {
    pass(`cron expression present: "${cronEntry['cron']}"`);
  } else {
    fail('schedule entry missing "cron" key');
  }
}

// workflow_dispatch trigger
const wd = on['workflow_dispatch'];
if (!wd) {
  fail('missing workflow_dispatch trigger');
} else {
  pass('workflow_dispatch trigger present');
}

// ---------------------------------------------------------------------------
// 5. workflow_dispatch inputs + defaults
// ---------------------------------------------------------------------------
console.log('[5/12] workflow_dispatch inputs');
const inputs = (wd && wd['inputs']) || {};
const expectedInputs = {
  level:  '1',
  limit:  '10',
  models: 'claude-haiku-4-5',
};
for (const [name, defaultVal] of Object.entries(expectedInputs)) {
  if (!inputs[name]) {
    fail(`workflow_dispatch input "${name}" missing`);
  } else {
    pass(`workflow_dispatch input "${name}" present`);
    const actualDefault = String(inputs[name]['default'] ?? '');
    if (actualDefault === defaultVal) {
      pass(`  default for "${name}" is "${defaultVal}"`);
    } else {
      fail(`  default for "${name}" is "${actualDefault}" — expected "${defaultVal}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. gaia-benchmark job definition
// ---------------------------------------------------------------------------
console.log('[6/12] Job definition');
const jobs = doc['jobs'] || {};
const job = jobs['gaia-benchmark'];
if (!job) {
  fail('jobs.gaia-benchmark not found');
  process.exit(1);
}
pass('jobs.gaia-benchmark defined');

// ---------------------------------------------------------------------------
// 7. if-condition guards unlabeled PRs
// ---------------------------------------------------------------------------
console.log('[7/12] PR label guard in job if-condition');
const ifCond = String(job['if'] || '');
if (/bench:gaia/.test(ifCond)) {
  pass('if-condition references bench:gaia label');
} else {
  fail('if-condition does not reference bench:gaia — unlabeled PRs would run the expensive job');
}

// ---------------------------------------------------------------------------
// 8. Permissions block
// ---------------------------------------------------------------------------
console.log('[8/12] Permissions');
const perms = job['permissions'] || {};
if (perms['pull-requests'] === 'write') pass('pull-requests: write permission set');
else fail('pull-requests: write permission missing');
if (perms['issues'] === 'write') pass('issues: write permission set');
else fail('issues: write permission missing');

// ---------------------------------------------------------------------------
// 9. Required step names present (heuristic — names must contain these strings)
// ---------------------------------------------------------------------------
console.log('[9/12] Required step names');
const steps = job['steps'] || [];
const stepNames = steps.map(s => (s['name'] || '').toLowerCase());

const requiredStepFragments = [
  ['checkout',        'Checkout'],
  ['build',           'Build CLI'],
  ['secrets',         'Validate required secrets'],
  ['resolve',         'Resolve benchmark parameters'],
  ['gaia',            'Run GAIA benchmark'],
  ['summary',         'Build markdown summary'],
  ['artifact',        'Upload results artifact'],
  ['comment',         'Post PR comment'],
  ['issue',           'tracking issue'],
  ['hard-fail',       'Hard-fail'],
];
for (const [fragment, label] of requiredStepFragments) {
  if (stepNames.some(n => n.includes(fragment))) {
    pass(`step present: "${label}"`);
  } else {
    fail(`step missing: "${label}" (searched for fragment "${fragment}")`);
  }
}

// ---------------------------------------------------------------------------
// 10. Secrets referenced in workflow source
// ---------------------------------------------------------------------------
console.log('[10/12] Secret references');
const raw = readFileSync(WORKFLOW, 'utf-8');
if (/secrets\.ANTHROPIC_API_KEY/.test(raw)) pass('ANTHROPIC_API_KEY referenced');
else fail('ANTHROPIC_API_KEY not referenced — env var will be empty');
if (/secrets\.HF_TOKEN/.test(raw)) pass('HF_TOKEN referenced');
else fail('HF_TOKEN not referenced — dataset download will fail');

// ---------------------------------------------------------------------------
// 11. gaia-bench CLI call shape
// ---------------------------------------------------------------------------
console.log('[11/12] CLI call shape');
if (/gaia-bench\s+run/.test(raw)) pass('gaia-bench run command present');
else fail('gaia-bench run command not found — entrypoint contract undefined');
if (/--level/.test(raw)) pass('--level flag present in gaia-bench call');
else fail('--level flag missing from gaia-bench call');
if (/--limit/.test(raw)) pass('--limit flag present in gaia-bench call');
else fail('--limit flag missing from gaia-bench call');

// ---------------------------------------------------------------------------
// 12. Thresholds
// ---------------------------------------------------------------------------
console.log('[12/12] Pass-rate thresholds');
if (/'0\.3'/.test(raw) || /"0\.3"/.test(raw) || /< '0\.3'/.test(raw) || /< "0\.3"/.test(raw)) {
  pass('hard-fail threshold 0.3 (30%) present');
} else {
  fail('hard-fail threshold 0.3 not found — floor may be wrong');
}
if (/'0\.6'/.test(raw) || /"0\.6"/.test(raw) || /< '0\.6'/.test(raw) || /< "0\.6"/.test(raw)) {
  pass('regression-issue threshold 0.6 (60%) present');
} else {
  fail('regression-issue threshold 0.6 not found — cron alerting may be misconfigured');
}

// ---------------------------------------------------------------------------
// Final result
// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log(`gaia-benchmark.yml schema smoke: all checks passed`);
  process.exit(0);
} else {
  console.error(`gaia-benchmark.yml schema smoke: ${failures} check(s) FAILED`);
  process.exit(1);
}
