#!/usr/bin/env node
/**
 * ADR-121 Phase 24 — Multi-signer attestation benchmark + witness.
 *
 * Demonstrates the M-of-N threshold verification pattern:
 *   - Primary signer:    benchmark-runner (the CI job that ran the
 *                        benchmark and captured the results)
 *   - Secondary signer:  third-party-verifier (attests "I observed
 *                        the primary signature was valid at this time
 *                        and re-verified the result independently")
 *   - Tertiary signer:   release-auditor (attests "this benchmark is
 *                        cleared for the published release")
 *
 * In a real adversarial-benchmarking deployment these three roles
 * are different humans / orgs / keys; here they're three ephemeral
 * keypairs to demonstrate the cryptographic shape.
 *
 * Pass criterion: the produced entry verifies at 3-of-3 threshold
 * AND backward-compatibly at 1-of-N (single-signer behavior).
 * Witness chained into the ledger.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const embDist = path.join(repoRoot, 'v3/@claude-flow/embeddings/dist');

const {
  appendToLedger,
  coSign,
  verifyEntry,
  verifyCosignatureAgainst,
  generateLedgerKeypair,
} = await import(path.join(embDist, 'witness-ledger.js'));
const { canonicalHash, witness, verify } = await import(path.join(embDist, 'witness.js'));

const argJson = process.argv.includes('--json');
const skipWrite = process.argv.includes('--skip-write');

const witnessDir = path.join(repoRoot, 'bench-witness');
const ledgerPath = path.join(witnessDir, 'ledger.json');
const ledger = fs.existsSync(ledgerPath)
  ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  : { version: 1, entries: [] };

function getCommit() {
  try { return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

if (!argJson) {
  console.log('=== Multi-signer attestation benchmark + witness ===\n');
  console.log('Demonstrates 3-of-3 M-of-N threshold verification.');
  console.log(`Existing ledger: ${ledger.entries.length} entries\n`);
}

// =========================================================
// Step 1 — primary signer creates the entry
// =========================================================
const primary = generateLedgerKeypair();
const benchmarkResults = {
  // Synthetic benchmark output — in production this is whatever the
  // actual benchmark produced. The point of this script is the
  // ATTESTATION shape, not the underlying benchmark.
  metric: 'multisig-attestation-demo',
  threshold: 3,
  signers: ['benchmark-runner', 'third-party-verifier', 'release-auditor'],
};

const primaryEntry = appendToLedger(
  ledger,
  {
    benchmark: 'rag-multisig-attestation',
    timestamp: new Date().toISOString(),
    commit: getCommit(),
    model: 'attestation-pattern',
    corpus: { id: canonicalHash(benchmarkResults), size: 1 },
    queries: { id: canonicalHash(benchmarkResults), count: 1 },
    results: benchmarkResults,
  },
  primary,
).entry;

if (!argJson) console.log(`[1] primary signer (benchmark-runner) signed entry sequence=${primaryEntry.sequence}`);

// =========================================================
// Step 2 — third-party verifier co-signs
// =========================================================
const verifier = generateLedgerKeypair();
const cosigned1 = coSign(primaryEntry, verifier, { signerLabel: 'third-party-verifier' });
if (!argJson) console.log(`[2] third-party-verifier co-signed; entry now has ${cosigned1.cosignatures?.length} cosignatures`);

// =========================================================
// Step 3 — release auditor co-signs
// =========================================================
const auditor = generateLedgerKeypair();
const cosigned2 = coSign(cosigned1, auditor, { signerLabel: 'release-auditor' });
if (!argJson) console.log(`[3] release-auditor co-signed; entry now has ${cosigned2.cosignatures?.length} cosignatures\n`);

// =========================================================
// Step 4 — verify at multiple thresholds
// =========================================================
const verifyAtThreshold = (n) => verifyEntry(cosigned2, { minSignatures: n });

const passes = {
  '1-of-3 (default backward-compat)': verifyAtThreshold(1),
  '2-of-3': verifyAtThreshold(2),
  '3-of-3 (full M-of-N)':            verifyAtThreshold(3),
  '4-of-3 (impossible — should fail)': verifyAtThreshold(4),
};

// Also exercise the standalone verifier per cosignature.
const perCosignature = (cosigned2.cosignatures ?? []).map(cs => ({
  label: cs.signerLabel,
  publicKey: cs.publicKey.slice(0, 24) + '...',
  verifies: verifyCosignatureAgainst(cosigned2.contentHash, cs),
}));

const summary = {
  primarySignerLabel: 'benchmark-runner',
  cosignerCount: cosigned2.cosignatures?.length ?? 0,
  totalSigners: 1 + (cosigned2.cosignatures?.length ?? 0),
  thresholdResults: passes,
  perCosignature,
  contentHashUnchanged: cosigned2.contentHash === primaryEntry.contentHash,
  primarySignatureUnchanged: cosigned2.signature === primaryEntry.signature,
};

// =========================================================
// Witness this attestation (one signer — the primary)
// =========================================================
const manifest = witness({
  benchmark: 'rag-multisig-attestation',
  timestamp: new Date().toISOString(),
  commit: getCommit(),
  model: 'attestation-pattern',
  corpus: { id: canonicalHash(benchmarkResults), size: 1 },
  queries: { id: canonicalHash(benchmarkResults), count: 1 },
  results: summary,
});
if (!verify(manifest)) { console.error('[FAIL] witness self-verify failed'); process.exit(2); }

// =========================================================
// Report
// =========================================================
if (argJson) {
  console.log(JSON.stringify({ summary, cosigned: cosigned2, witness: manifest }, null, 2));
} else {
  console.log('### Threshold verification results\n');
  console.log('| threshold | result |');
  console.log('|---|:---:|');
  for (const [k, v] of Object.entries(passes)) {
    console.log(`| ${k} | ${v ? '✓' : '✗'} |`);
  }
  console.log();
  console.log('### Per-cosignature verification (signers visible)\n');
  console.log('| label | publicKey (truncated) | verifies |');
  console.log('|---|---|:---:|');
  for (const c of perCosignature) {
    console.log(`| ${c.label} | \`${c.publicKey}\` | ${c.verifies ? '✓' : '✗'} |`);
  }
  console.log();
  console.log('### Chain integrity invariants\n');
  console.log(`- contentHash unchanged by co-signing:      ${summary.contentHashUnchanged ? '✓' : '✗ — BROKEN'}`);
  console.log(`- primary signature unchanged by co-signing: ${summary.primarySignatureUnchanged ? '✓' : '✗ — BROKEN'}`);
  console.log();
  console.log('### Witness');
  console.log(`- commit:      ${manifest.commit ?? '(n/a)'}`);
  console.log(`- contentHash: ${manifest.contentHash}`);
  console.log(`- signature:   ${manifest.signature.slice(0, 32)}...`);
  console.log(`- verify():    TRUE`);
}

if (!skipWrite) {
  fs.mkdirSync(witnessDir, { recursive: true });
  const filename = `rag-multisig-attestation-${manifest.timestamp.replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(witnessDir, filename), JSON.stringify({ summary, cosignedEntry: cosigned2, witness: manifest }, null, 2));
  if (!argJson) console.log(`\nWitness manifest written to bench-witness/${filename}`);
}

// =========================================================
// Pass criterion
// =========================================================
let ok = true;
if (!passes['3-of-3 (full M-of-N)']) { console.error('[FAIL] 3-of-3 threshold did not verify'); ok = false; }
if (!passes['1-of-3 (default backward-compat)']) { console.error('[FAIL] backward-compat 1-of-N broke'); ok = false; }
if (passes['4-of-3 (impossible — should fail)']) { console.error('[FAIL] impossible threshold should have failed'); ok = false; }
if (!summary.contentHashUnchanged) { console.error('[FAIL] coSign changed contentHash'); ok = false; }
if (!summary.primarySignatureUnchanged) { console.error('[FAIL] coSign changed primary signature'); ok = false; }
if (!perCosignature.every(c => c.verifies)) { console.error('[FAIL] not every co-signature verifies'); ok = false; }

process.exit(ok ? 0 : 1);
