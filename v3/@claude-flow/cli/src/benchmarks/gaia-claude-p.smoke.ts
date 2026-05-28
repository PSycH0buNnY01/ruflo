/**
 * Smoke tests for gaia-claude-p.ts — iter 54 (#2156)
 *
 * Three minimal cases to verify the claude -p wrapper end-to-end:
 *   1. Simple arithmetic: "what is 2+2" → expect "4"
 *   2. Current fact: population of Tokyo → expect a large number
 *   3. (Optional) Attachment path test — only runs when HF cache has a file
 *
 * Cost cap: ~$0.25 × 3 = $0.75 worst case at Sonnet rates, but using Haiku
 * for smoke to keep it under $0.30 total.
 *
 * Run:
 *   npx ts-node src/benchmarks/gaia-claude-p.smoke.ts
 *   # or after build:
 *   node dist/src/benchmarks/gaia-claude-p.smoke.js
 *
 * Refs: iter 54, #2156
 */

import {
  runGaiaQuestionViaClaudeP,
  extractFinalAnswer,
  buildClaudePPrompt,
  CLAUDE_P_DEFAULT_MODEL,
} from './gaia-claude-p.js';
import type { GaiaQuestion } from './gaia-loader.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Unit tests (no claude -p invocation)
// ---------------------------------------------------------------------------

function testExtractFinalAnswer(): void {
  console.log('\n-- Unit: extractFinalAnswer --');

  assert(
    extractFinalAnswer('FINAL_ANSWER: 4') === '4',
    'extracts plain number',
  );
  assert(
    extractFinalAnswer('Some reasoning...\nFINAL_ANSWER: Paris') === 'Paris',
    'extracts after reasoning text',
  );
  assert(
    extractFinalAnswer('final_answer: 42') === '42',
    'case-insensitive extraction',
  );
  assert(
    extractFinalAnswer('') === null,
    'returns null for empty string',
  );
  assert(
    extractFinalAnswer('No answer marker here') !== null,
    'fallback to last line when no marker',
  );
}

function testBuildClaudePPrompt(): void {
  console.log('\n-- Unit: buildClaudePPrompt --');

  const q: GaiaQuestion = {
    task_id: 'test-001',
    level: 1,
    question: 'What is 2+2?',
    final_answer: '4',
    file_name: null,
    file_path: null,
  };

  const prompt = buildClaudePPrompt(q);
  assert(prompt.includes('What is 2+2?'), 'prompt contains question text');
  assert(prompt.includes('FINAL_ANSWER:'), 'prompt instructs FINAL_ANSWER format');
  assert(!prompt.includes('Attachment'), 'no attachment section for null file_path');

  const qWithFile: GaiaQuestion = { ...q, file_path: '/tmp/test.pdf' };
  const promptWithFile = buildClaudePPrompt(qWithFile);
  assert(promptWithFile.includes('/tmp/test.pdf'), 'attachment path included when present');
  assert(promptWithFile.includes('Read tool'), 'mentions Read tool for attachments');
}

// ---------------------------------------------------------------------------
// Integration tests (invoke claude -p)
// ---------------------------------------------------------------------------

async function testArithmetic(): Promise<void> {
  console.log('\n-- Integration: arithmetic (2+2) --');

  const q: GaiaQuestion = {
    task_id: 'smoke-arithmetic',
    level: 1,
    question: 'What is 2 + 2? Provide only the numeric answer.',
    final_answer: '4',
    file_name: null,
    file_path: null,
  };

  console.log('  Spawning claude -p ...');
  const result = await runGaiaQuestionViaClaudeP(q, {
    model: 'claude-haiku-4-5',
    budgetUsd: 0.25,
    timeoutMs: 120_000,
  });

  console.log(`  raw result: ${result.rawResult.slice(0, 100)}`);
  console.log(`  finalAnswer: ${result.finalAnswer}`);
  console.log(`  costUsd: $${result.costUsd.toFixed(4)}`);
  console.log(`  numTurns: ${result.numTurns}`);
  console.log(`  isError: ${result.isError}`);

  assert(!result.isError, 'no error', result.errorMessage);
  assert(result.finalAnswer !== null, 'finalAnswer is not null');
  assert(result.finalAnswer === '4', `answer is "4"`, `got: "${result.finalAnswer}"`);
  assert(result.costUsd > 0, 'cost is positive');
  assert(result.wallMs > 0, 'wallMs is positive');
}

async function testCurrentFact(): Promise<void> {
  console.log('\n-- Integration: current fact (Tokyo population) --');

  const q: GaiaQuestion = {
    task_id: 'smoke-tokyo-pop',
    level: 1,
    question: 'What is the approximate population of Tokyo (the city proper)? Give only a number in millions, rounded to the nearest million.',
    final_answer: '14',
    file_name: null,
    file_path: null,
  };

  console.log('  Spawning claude -p ...');
  const result = await runGaiaQuestionViaClaudeP(q, {
    model: 'claude-haiku-4-5',
    budgetUsd: 0.25,
    timeoutMs: 120_000,
  });

  console.log(`  raw result excerpt: ${result.rawResult.slice(0, 150)}`);
  console.log(`  finalAnswer: ${result.finalAnswer}`);
  console.log(`  costUsd: $${result.costUsd.toFixed(4)}`);

  assert(!result.isError, 'no error', result.errorMessage);
  assert(result.finalAnswer !== null, 'finalAnswer is not null');
  // Tokyo metro area is ~37M, city proper is ~13-14M — any multi-digit number is reasonable
  const numAnswer = result.finalAnswer ? parseFloat(result.finalAnswer.replace(/[^0-9.]/g, '')) : NaN;
  assert(
    !isNaN(numAnswer) && numAnswer > 0,
    'answer is a non-empty number',
    `got: "${result.finalAnswer}"`,
  );
}

async function testAnswerFormat(): Promise<void> {
  console.log('\n-- Integration: answer format discipline --');

  const q: GaiaQuestion = {
    task_id: 'smoke-format',
    level: 1,
    question: 'What is the capital of France? Give only the city name, nothing else.',
    final_answer: 'Paris',
    file_name: null,
    file_path: null,
  };

  console.log('  Spawning claude -p ...');
  const result = await runGaiaQuestionViaClaudeP(q, {
    model: 'claude-haiku-4-5',
    budgetUsd: 0.25,
    timeoutMs: 120_000,
  });

  console.log(`  raw result excerpt: ${result.rawResult.slice(0, 150)}`);
  console.log(`  finalAnswer: ${result.finalAnswer}`);
  console.log(`  costUsd: $${result.costUsd.toFixed(4)}`);

  assert(!result.isError, 'no error', result.errorMessage);
  assert(result.finalAnswer !== null, 'finalAnswer is not null');
  assert(
    result.finalAnswer !== null && result.finalAnswer.toLowerCase().includes('paris'),
    'answer contains "paris"',
    `got: "${result.finalAnswer}"`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== gaia-claude-p smoke tests ===');
  console.log(`Model: claude-haiku-4-5 (smoke uses Haiku to minimize cost)`);
  console.log(`Default production model: ${CLAUDE_P_DEFAULT_MODEL}`);

  // Unit tests (no API calls)
  testExtractFinalAnswer();
  testBuildClaudePPrompt();

  // Integration tests (invoke claude -p)
  await testArithmetic();
  await testCurrentFact();
  await testAnswerFormat();

  // Summary
  const total = passed + failed;
  console.log(`\n=== Results: ${passed}/${total} passed ===`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke test runner error:', err);
  process.exit(1);
});
