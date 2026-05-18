#!/usr/bin/env node
/**
 * ADR-121 Phase 18 — Build a chained witness ledger from the
 * existing per-run witness manifests in bench-witness/.
 *
 * Reads every `*.json` in `bench-witness/` (excluding `ledger.json`
 * itself), sorts them by timestamp ascending, and appends each one
 * to a hash-chained ledger signed by a single ephemeral keypair.
 * Writes the result to `bench-witness/ledger.json`.
 *
 * Re-verifies the full chain end-to-end after building. The exit
 * code is 0 only if every entry's signature verifies AND every
 * chain link matches.
 *
 * Run:
 *   node scripts/build-benchmark-ledger.mjs
 *   node scripts/build-benchmark-ledger.mjs --json
 *
 * This script is idempotent — it always rebuilds from the underlying
 * manifests, so re-running after adding new benchmarks produces a
 * deterministic-up-to-the-ephemeral-key ledger (the chain links are
 * deterministic; only the signer key per run is fresh).
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const embDist = path.join(repoRoot, 'v3/@claude-flow/embeddings/dist');

const { appendToLedger, verifyLedger, generateLedgerKeypair } = await import(path.join(embDist, 'witness-ledger.js'));

const argJson = process.argv.includes('--json');
const witnessDir = path.join(repoRoot, 'bench-witness');
const ledgerPath = path.join(witnessDir, 'ledger.json');

if (!fs.existsSync(witnessDir)) {
  console.error('[FAIL] bench-witness/ directory does not exist');
  process.exit(1);
}

// Collect all manifest files (anything ending .json that isn't ledger.json).
const files = fs.readdirSync(witnessDir)
  .filter(f => f.endsWith('.json') && f !== 'ledger.json')
  .map(f => path.join(witnessDir, f));

if (files.length === 0) {
  console.error('[FAIL] no witness manifests found in bench-witness/');
  process.exit(1);
}

// Load + sort by timestamp ascending (chain in the order the
// benchmarks were originally run).
const manifests = files.map(f => {
  const content = JSON.parse(fs.readFileSync(f, 'utf8'));
  // Each saved file has shape: { summary?, perQuery?, results?, witness: {...} }.
  // The actual witness is in the `witness` key.
  if (!content.witness) {
    console.error(`[FAIL] ${path.basename(f)} has no .witness key`);
    process.exit(1);
  }
  return { file: path.basename(f), witness: content.witness };
}).sort((a, b) => a.witness.timestamp.localeCompare(b.witness.timestamp));

if (!argJson) {
  console.log('=== Building chained benchmark ledger ===\n');
  console.log(`Found ${manifests.length} witness manifests in bench-witness/`);
  for (const m of manifests) {
    console.log(`  - ${m.witness.timestamp}  ${m.witness.benchmark}`);
  }
  console.log();
}

// Build the chain with a single signer.
const kp = generateLedgerKeypair();
let ledger;
for (const m of manifests) {
  // Replay the original witness input into the chain. The chain
  // entries are SIGNED FRESH — they don't inherit the original
  // manifest's signature (a key authority might have rotated).
  // The original contentHash is preserved inside the input.results
  // so the ledger entry attests to the historical numbers.
  const input = {
    benchmark: m.witness.benchmark,
    timestamp: m.witness.timestamp,
    commit: m.witness.commit ?? null,
    model: m.witness.model,
    corpus: m.witness.corpus,
    queries: m.witness.queries,
    results: {
      // Embed the original signed contentHash so the ledger entry
      // explicitly attests "I have observed this prior manifest with
      // this exact content fingerprint".
      originalContentHash: m.witness.contentHash,
      originalSignature: m.witness.signature,
      originalPublicKey: m.witness.publicKey,
      // And the actual scoring/summary data from the file (whichever
      // shape it was saved in).
      results: m.witness.results,
    },
  };
  const result = appendToLedger(ledger, input, kp);
  ledger = result.ledger;
}

const verifyResult = verifyLedger(ledger);

if (!verifyResult.valid) {
  console.error('[FAIL] freshly-built ledger does not self-verify:', verifyResult);
  process.exit(1);
}

// Write the ledger.
fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

if (argJson) {
  console.log(JSON.stringify({ ledger, verifyResult }, null, 2));
} else {
  console.log('### Chained ledger built\n');
  console.log(`Total entries:   ${ledger.entries.length}`);
  console.log(`Signer publicKey: ${ledger.entries[0].publicKey.slice(0, 32)}...`);
  console.log(`Chain head (entry ${ledger.entries.length}):`);
  console.log(`  benchmark:      ${ledger.entries.at(-1).benchmark}`);
  console.log(`  contentHash:    ${ledger.entries.at(-1).contentHash}`);
  console.log(`  prevContentHash: ${ledger.entries.at(-1).prevContentHash ?? '(genesis)'}`);
  console.log();
  console.log('### Chain (sequence: prevHash → contentHash)\n');
  for (const e of ledger.entries) {
    const prev = e.prevContentHash ? e.prevContentHash.slice(0, 12) + '…' : '<genesis>'.padEnd(13);
    const head = e.contentHash.slice(0, 12) + '…';
    console.log(`  [${String(e.sequence).padStart(2)}] ${e.benchmark.padEnd(28)} ${prev}  →  ${head}`);
  }
  console.log();
  console.log(`### Verification\n`);
  console.log(`  verifyLedger(): ${verifyResult.valid ? 'TRUE' : 'FALSE'}`);
  console.log(`  entries checked: ${verifyResult.entryCount}`);
  if (!verifyResult.valid) {
    console.log(`  first failure at: ${verifyResult.firstFailureAt}`);
    console.log(`  reason: ${verifyResult.reason}`);
  }
  console.log();
  console.log(`Ledger written to bench-witness/ledger.json`);
}

process.exit(0);
