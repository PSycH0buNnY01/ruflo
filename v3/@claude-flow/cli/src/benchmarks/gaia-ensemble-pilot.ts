/**
 * GAIA Ensemble Pilot — ADR-139 5-question validation
 *
 * Runs 5 diverse GAIA L1 questions through the 2-model ensemble
 * (claude-sonnet-4-6 + gemini-2.5-pro) and reports accuracy, cost, and
 * projections. OpenRouter is skipped until credits are topped up.
 *
 * Usage:
 *   node dist/src/benchmarks/gaia-ensemble-pilot.js
 *   node dist/src/benchmarks/gaia-ensemble-pilot.js --models claude-sonnet-4-6,gemini-2.5-pro,openai/gpt-5
 *
 * Exit codes:
 *   0  pilot passed (accuracy ≥ 3/5 AND projected 53Q cost ≤ $40)
 *   1  pilot failed or cost exceeded
 */

import { runEnsemblePilot } from './gaia-ensemble.js';
import type { GaiaQuestion } from './gaia-loader.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const GAIA_CACHE = path.join(os.homedir(), '.cache', 'ruflo', 'gaia', 'level1-main.json');

const PILOT_QUESTION_IDS = [
  'e1fc63a2-da7a-432f-be78-7c4a95598703',  // marathon pace math
  '8e867cd7-cff9-4e6c-867a-ff5ddc2550be',  // discography lookup
  '2d83110e-a098-4ebb-9987-066c06fa42d0',  // reversed text encoding
  '27d5d136-8563-469e-92bf-fd103c28b57c',  // boolean logic formulas
  'dc28cf18-6431-458b-83ef-64b3ce566c10',  // recipe/cooking lookup
];

async function main(): Promise<void> {
  // Parse --models flag
  const modelsArg = process.argv.find((a) => a.startsWith('--models='))?.split('=')[1];
  const models = modelsArg ? modelsArg.split(',') : ['claude-sonnet-4-6', 'gemini-2.5-pro'];

  console.error(`[pilot] Models: ${models.join(', ')}`);
  console.error(`[pilot] Loading GAIA dataset from: ${GAIA_CACHE}`);

  if (!fs.existsSync(GAIA_CACHE)) {
    console.error('[pilot] ERROR: GAIA cache not found. Run a full benchmark first to populate cache.');
    process.exit(1);
  }

  const allQuestions: GaiaQuestion[] = JSON.parse(fs.readFileSync(GAIA_CACHE, 'utf-8'));
  const pilotQuestions = allQuestions.filter((q) => PILOT_QUESTION_IDS.includes(q.task_id));

  if (pilotQuestions.length !== PILOT_QUESTION_IDS.length) {
    console.error(`[pilot] WARNING: Expected ${PILOT_QUESTION_IDS.length} questions, found ${pilotQuestions.length}`);
  }

  console.error(`[pilot] Running ${pilotQuestions.length} questions through ${models.length}-model ensemble...`);

  const result = await runEnsemblePilot(pilotQuestions, {
    models,
    maxTurns: 10,
    maxTokensPerTurn: 4096,
    perTurnTimeoutMs: 90_000,
  });

  // Write JSON output to stdout
  const output = {
    pilotConfig: { models, questionCount: pilotQuestions.length },
    result: {
      correct: result.correct,
      total: result.total,
      accuracy: result.accuracy,
      totalCostUsd: result.totalCostUsd,
      projectedCost53Q: result.projectedCost53Q,
      projectedCost300Q: result.projectedCost300Q,
      meanWallMs: result.meanWallMs,
    },
    costGate: {
      limit53Q: 40,
      limit300Q: 250,
      passes53Q: result.projectedCost53Q <= 40,
      passes300Q: result.projectedCost300Q <= 250,
    },
    recommendation: buildRecommendation(result.correct, result.total, result.projectedCost53Q, result.projectedCost300Q),
    perQuestion: result.perQuestion,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  // Human-readable summary to stderr
  console.error('\n=== ENSEMBLE PILOT SUMMARY ===');
  console.error(`Accuracy: ${result.correct}/${result.total} (${(result.accuracy * 100).toFixed(1)}%)`);
  console.error(`Total cost: $${result.totalCostUsd.toFixed(4)}`);
  console.error(`Projected 53-Q cost: $${result.projectedCost53Q.toFixed(2)} (gate: $40)`);
  console.error(`Projected 300-Q cost: $${result.projectedCost300Q.toFixed(2)} (gate: $250)`);
  console.error(`Mean wall time: ${(result.meanWallMs / 1000).toFixed(1)}s/Q`);
  console.error('');

  for (const q of result.perQuestion) {
    const status = q.correct ? 'CORRECT' : 'WRONG  ';
    console.error(`  ${status} ${q.taskId.slice(0, 8)} | got="${q.got ?? 'null'}" exp="${q.expected}" [${q.aggregationMethod}]`);
  }

  console.error('\n=== VERDICT ===');
  console.error(output.recommendation);

  const passed = result.correct >= 4 && result.projectedCost53Q <= 40;
  process.exit(passed ? 0 : 1);
}

function buildRecommendation(correct: number, total: number, cost53Q: number, cost300Q: number): string {
  const costOk = cost53Q <= 40;
  if (correct >= 4 && costOk) {
    return `PROCEED: ensemble viable. ${correct}/${total} accuracy (≥4/5) and cost $${cost53Q.toFixed(2)}/53Q (≤$40). Recommend iter 64 full 53-Q validation run.`;
  }
  if (correct >= 4 && !costOk) {
    return `COST ISSUE: accuracy ${correct}/${total} good but projected 53-Q cost $${cost53Q.toFixed(2)} exceeds $40 gate. Reduce model count or use cheaper models.`;
  }
  if (correct < 4 && costOk) {
    return `ACCURACY ISSUE: only ${correct}/${total} correct. Consider: (a) more models, (b) higher maxTurns, (c) OpenRouter credit top-up for GPT-5/DeepSeek. Do NOT proceed to full 53-Q.`;
  }
  return `BLOCKED: accuracy ${correct}/${total} below threshold AND cost $${cost53Q.toFixed(2)} above gate. Reassess architecture.`;
}

main().catch((err) => {
  console.error('[pilot] FATAL:', err);
  process.exit(1);
});
