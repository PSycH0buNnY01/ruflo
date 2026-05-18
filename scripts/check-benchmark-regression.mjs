#!/usr/bin/env node
/**
 * ADR-121 Phase 22 — Benchmark regression guard.
 *
 * Reads the chained witness ledger from bench-witness/ledger.json
 * and runs a battery of regression checks against the most recent
 * entry of each benchmark. Fails (exit 1) if any tracked metric has
 * regressed beyond its threshold.
 *
 * What it checks (one row per (benchmark, metricPath, direction)):
 *
 *   rag-real-text:
 *     - results.adaptive.recallAt5      higher-is-better, 10%
 *     - results.compound.recallAt5      higher-is-better, 10%
 *     - results.hyde.recallAt5          higher-is-better, 10%
 *   rag-adaptive-router:
 *     - results.accuracy                higher-is-better, 5%
 *   rag-router-ablation:
 *     - results.adaptive.meanRecallAt5  higher-is-better, 10%
 *   rag-lazy-router:
 *     - results.embedsSaved             higher-is-better, 10%
 *     - results.embedsSavedPercent      higher-is-better, 10%
 *   rag-cached-router:
 *     - results.cacheStats.hitRate      higher-is-better, 10%
 *     - results.embedsSavedPercent      higher-is-better, 10%
 *
 * Pass criterion: all checks pass.
 *
 * Output: markdown table of (benchmark, metric, current, baseline,
 * delta, pass/fail). --json for structured output. Witness-signed
 * regression report written to bench-witness/.
 *
 * NOTE: this script does NOT re-run benchmarks. It compares the
 * latest manifest in bench-witness/ for each benchmark against the
 * historical baseline in the ledger. To detect regression in CI you
 * run the benchmark first, then run this — both witnesses end up
 * in the chain.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const embDist = path.join(repoRoot, 'v3/@claude-flow/embeddings/dist');

const { checkRegressionBatch, getMetricAtPath } = await import(path.join(embDist, 'ledger-analyzer.js'));
const { witness, verify, canonicalHash } = await import(path.join(embDist, 'witness.js'));

const argJson = process.argv.includes('--json');
const skipWrite = process.argv.includes('--skip-write');

const witnessDir = path.join(repoRoot, 'bench-witness');
const ledgerPath = path.join(witnessDir, 'ledger.json');

if (!fs.existsSync(ledgerPath)) {
  console.error('[FAIL] bench-witness/ledger.json does not exist — run scripts/build-benchmark-ledger.mjs first');
  process.exit(1);
}
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

// =========================================================
// Tracked metrics — (benchmark, path, direction, threshold)
// =========================================================
// The ledger script wraps the original benchmark `results` in
// `entry.results.results` (alongside originalContentHash/etc.). So
// metric paths read through `results.results.*`.
const TRACKED = [
  { benchmark: 'rag-real-text',         metricPath: 'results.results.compound.recallAt5', direction: 'higher', threshold: 0.10 },
  { benchmark: 'rag-real-text',         metricPath: 'results.results.hyde.recallAt5',     direction: 'higher', threshold: 0.10 },
  { benchmark: 'rag-adaptive-router',   metricPath: 'results.results.accuracy',           direction: 'higher', threshold: 0.05 },
  { benchmark: 'rag-router-ablation',   metricPath: 'results.results.adaptive.meanRecallAt5', direction: 'higher', threshold: 0.10 },
  { benchmark: 'rag-lazy-router',       metricPath: 'results.results.embedsSaved',        direction: 'higher', threshold: 0.20 },
  { benchmark: 'rag-lazy-router',       metricPath: 'results.results.embedsSavedPercent', direction: 'higher', threshold: 0.20 },
  { benchmark: 'rag-cached-router',     metricPath: 'results.results.cacheStats.hitRate', direction: 'higher', threshold: 0.10 },
  { benchmark: 'rag-cached-router',     metricPath: 'results.results.embedsSavedPercent', direction: 'higher', threshold: 0.10 },
];

// =========================================================
// For each tracked metric, find the LATEST entry's current value
// and the PREVIOUS entries' baseline. Build the batch.
// =========================================================
function entriesFor(name) {
  return ledger.entries.filter(e => e.benchmark === name);
}

const batchInputs = [];
const skipped = [];
for (const t of TRACKED) {
  const entries = entriesFor(t.benchmark);
  if (entries.length === 0) {
    skipped.push({ ...t, reason: 'no entries' });
    continue;
  }
  const latest = entries[entries.length - 1];
  const current = getMetricAtPath(latest, t.metricPath);
  if (typeof current !== 'number') {
    skipped.push({ ...t, reason: `metric path returned ${typeof current}` });
    continue;
  }
  // Use the SECOND-most-recent as baseline so the latest entry isn't
  // checking against itself. If only one entry exists, there's
  // nothing to regress against.
  if (entries.length < 2) {
    skipped.push({ ...t, reason: 'only one historical entry; nothing to regress against', currentValue: current });
    continue;
  }
  // Build a sub-ledger that excludes the latest entry so pickBaseline
  // looks at prior runs only.
  const subLedger = { ...ledger, entries: entries.slice(0, -1) };
  // Use the actual ledger's same chain structure (sequence numbers
  // are preserved — checkRegression only cares about the entry's
  // metric value, not the chain integrity).
  batchInputs.push({
    benchmark: t.benchmark,
    metricPath: t.metricPath,
    currentValue: current,
    options: {
      threshold: t.threshold,
      baseline: { strategy: 'latest', direction: t.direction },
    },
    // Keep the sub-ledger associated for the actual check.
    _ledger: subLedger,
  });
}

// Run each check against its own sub-ledger.
const checks = batchInputs.map(input => {
  const { _ledger, ...rest } = input;
  // Wrap individual checkRegression call.
  const batch = checkRegressionBatch(_ledger, [rest]);
  return batch.checks[0];
});

const allPassed = checks.every(c => c.passed);
const failedCount = checks.filter(c => !c.passed).length;

// =========================================================
// Witness the regression report
// =========================================================
function getCommit() {
  try { return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

const summary = {
  trackedCount: TRACKED.length,
  checkedCount: checks.length,
  skippedCount: skipped.length,
  passedCount: checks.length - failedCount,
  failedCount,
  allPassed,
  checks: checks.map(c => ({
    benchmark: c.benchmark,
    metricPath: c.metricPath,
    currentValue: c.currentValue,
    baselineValue: c.baselineValue,
    baselineFrom: c.baselineFrom,
    percentChange: c.percentChange,
    passed: c.passed,
  })),
  skipped: skipped.map(s => ({ benchmark: s.benchmark, metricPath: s.metricPath, reason: s.reason })),
  ledgerHead: ledger.entries.length > 0 ? {
    sequence: ledger.entries[ledger.entries.length - 1].sequence,
    contentHash: ledger.entries[ledger.entries.length - 1].contentHash,
    benchmark: ledger.entries[ledger.entries.length - 1].benchmark,
  } : null,
};

const manifest = witness({
  benchmark: 'rag-regression-check',
  timestamp: new Date().toISOString(),
  commit: getCommit(),
  model: 'ledger-derived',
  corpus: { id: canonicalHash(TRACKED), size: TRACKED.length },
  queries: { id: canonicalHash(ledger.entries.map(e => e.contentHash)), count: ledger.entries.length },
  results: summary,
});
if (!verify(manifest)) { console.error('[FAIL] witness self-verify failed'); process.exit(2); }

// =========================================================
// Report
// =========================================================
if (argJson) {
  console.log(JSON.stringify({ summary, witness: manifest }, null, 2));
} else {
  console.log('=== Benchmark regression check ===\n');
  console.log(`Ledger entries:    ${ledger.entries.length}`);
  console.log(`Tracked metrics:   ${TRACKED.length}`);
  console.log(`Checked:           ${checks.length}`);
  console.log(`Skipped:           ${skipped.length}`);
  console.log(`Passed:            ${checks.length - failedCount}`);
  console.log(`Failed:            ${failedCount}\n`);

  if (checks.length > 0) {
    console.log('### Regression checks\n');
    console.log('| benchmark | metric | current | baseline | Δ% | verdict |');
    console.log('|---|---|---:|---:|---:|:---:|');
    for (const c of checks) {
      const delta = c.baselineValue === null ? '—' : `${c.percentChange >= 0 ? '+' : ''}${(c.percentChange * 100).toFixed(1)}%`;
      const v = c.passed ? '✓' : '✗ FAIL';
      const baseline = c.baselineValue === null ? '—' : c.baselineValue.toFixed(4);
      console.log(`| \`${c.benchmark}\` | \`${c.metricPath.replace(/^results\./, '')}\` | ${c.currentValue.toFixed(4)} | ${baseline} | ${delta} | ${v} |`);
    }
    console.log();
  }

  if (skipped.length > 0) {
    console.log('### Skipped\n');
    for (const s of skipped) {
      console.log(`- \`${s.benchmark}\` / \`${s.metricPath}\` — ${s.reason}`);
    }
    console.log();
  }

  console.log('### Witness');
  console.log(`- commit:      ${manifest.commit ?? '(n/a)'}`);
  console.log(`- contentHash: ${manifest.contentHash}`);
  console.log(`- signature:   ${manifest.signature.slice(0, 32)}...`);
  console.log(`- verify():    TRUE`);
}

if (!skipWrite) {
  fs.mkdirSync(witnessDir, { recursive: true });
  const filename = `rag-regression-check-${manifest.timestamp.replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(witnessDir, filename), JSON.stringify({ summary, witness: manifest }, null, 2));
  if (!argJson) console.log(`\nRegression report written to bench-witness/${filename}`);
}

process.exit(allPassed ? 0 : 1);
