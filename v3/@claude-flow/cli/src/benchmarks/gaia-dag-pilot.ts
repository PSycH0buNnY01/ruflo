/**
 * GAIA DAG 5-Question Pilot Runner — iter 64
 *
 * Runs 5 specific GAIA L1 questions through the Co-Sight DAG harness
 * and compares results against single-Sonnet baseline (from iter 63b).
 *
 * Pilot question mix (selected from iter 63b failures):
 *   1. 5d0080cb — calculation (fish bag volume from academic paper, multi-hop)
 *   2. cffe0e32 — reasoning puzzle (Secret Santa assignment chain)
 *   3. ec09fa32 — riddle (game show, requires careful reasoning)
 *   4. 46719c30 — retrieval (paper authors -> their other publications)
 *   5. b816bfce — retrieval+reasoning (journal name from Norse mythology)
 *
 * Cost cap: $2.00
 *
 * Usage:
 *   node dist/src/benchmarks/gaia-dag-pilot.js
 *
 * Refs: ADR-139, iter 64, #2156
 */

import { loadGaia } from './gaia-loader.js';
import { runDagPilot, DagPilotResult } from './gaia-dag.js';
import { normaliseAnswer } from './gaia-judge.js';

// ---------------------------------------------------------------------------
// Pilot question IDs (5 questions from iter 63b failures)
// ---------------------------------------------------------------------------

const PILOT_TASK_IDS = [
  '5d0080cb-90d7-4712-bc33-848150e917d3', // calculation: fish bag volume
  'cffe0e32-c9a6-4c52-9877-78ceb4aaa9fb', // reasoning: Secret Santa
  'ec09fa32-d03f-4bf8-84b0-1f16922c3ae4', // riddle: game show bees
  '46719c30-f4c3-4cad-be07-d5cb21eee6bb', // retrieval: paper authors + their work
  'b816bfce-3d80-4913-a07d-69b752ce6377', // retrieval: journal from Norse mythology
];

// Baseline: single-Sonnet results from iter 63b
const BASELINE: Record<string, { correct: boolean; answer: string | null }> = {
  '5d0080cb-90d7-4712-bc33-848150e917d3': { correct: false, answer: null },
  'cffe0e32-c9a6-4c52-9877-78ceb4aaa9fb': { correct: false, answer: null },
  'ec09fa32-d03f-4bf8-84b0-1f16922c3ae4': { correct: false, answer: null },
  '46719c30-f4c3-4cad-be07-d5cb21eee6bb': { correct: false, answer: null },
  'b816bfce-3d80-4913-a07d-69b752ce6377': { correct: false, answer: 'cuddly' }, // close but wrong
};

const COST_CAP_USD = 2.00;

async function main(): Promise<void> {
  console.log('\n=== GAIA DAG 5-Question Pilot (iter 64) ===\n');
  console.log('Questions: 5 (from iter 63b failures)');
  console.log(`Planner: ${process.env['PLAN_MODEL'] ?? 'claude-sonnet-4-6'}`);
  console.log(`Actor:   ${process.env['ACT_MODEL'] ?? 'gemini-2.5-pro'}`);
  console.log(`Cost cap: $${COST_CAP_USD}\n`);

  // Load full GAIA L1 dataset and filter to pilot questions
  console.log('Loading GAIA L1 dataset...');
  let allQuestions;
  try {
    allQuestions = await loadGaia({ level: 1 });
  } catch (err) {
    console.error('Failed to load GAIA dataset:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const pilotQuestions = PILOT_TASK_IDS.map((id) => {
    const q = allQuestions.find((q) => q.task_id === id);
    if (!q) {
      console.warn(`WARNING: Question ${id} not found in dataset`);
    }
    return q;
  }).filter(Boolean) as typeof allQuestions;

  if (pilotQuestions.length === 0) {
    console.error('No pilot questions found. Check HF token and dataset availability.');
    process.exit(1);
  }

  console.log(`Loaded ${pilotQuestions.length} pilot questions\n`);
  for (const q of pilotQuestions) {
    console.log(`  ${q.task_id.slice(0, 8)}: ${q.question.slice(0, 70)}...`);
    console.log(`           expected: "${q.final_answer}"`);
    if (q.file_path) console.log(`           file: ${q.file_path}`);
  }
  console.log('');

  // Run DAG pilot
  const result: DagPilotResult = await runDagPilot(pilotQuestions, {});

  // Check cost cap
  if (result.totalCostUsd > COST_CAP_USD) {
    console.warn(`\nWARNING: Cost $${result.totalCostUsd.toFixed(4)} exceeded cap $${COST_CAP_USD}\n`);
  }

  // Report results
  console.log('\n=== DAG Pilot Results ===\n');
  console.log(`Score: ${result.correct}/${result.total} (${(result.accuracy * 100).toFixed(1)}%)`);
  console.log(`Avg steps/question: ${result.avgStepsPerQuestion.toFixed(1)}`);
  console.log(`Total cost: $${result.totalCostUsd.toFixed(4)}`);
  console.log(`Projected 53Q cost: $${result.projectedCost53Q.toFixed(2)}`);
  console.log(`Mean wall time: ${(result.meanWallMs / 1000).toFixed(1)}s\n`);

  console.log('Per-question breakdown:');
  const baselineCorrect = Object.values(BASELINE).filter((b) => b.correct).length;
  let dagBetter = 0;
  let dagWorse = 0;

  for (const q of result.perQuestion) {
    const baseline = BASELINE[q.taskId];
    const baselineResult = baseline?.correct ? 'PASS' : 'FAIL';
    const dagResult = q.correct ? 'PASS' : 'FAIL';
    const change = !baseline?.correct && q.correct ? ' (+RECOVERED)' :
                   baseline?.correct && !q.correct ? ' (-REGRESSED)' : '';
    if (!baseline?.correct && q.correct) dagBetter++;
    if (baseline?.correct && !q.correct) dagWorse++;

    console.log(`  ${dagResult} [was ${baselineResult}]${change} ${q.taskId.slice(0, 8)}: got="${q.got?.slice(0, 40) ?? 'null'}" expected="${q.expected.slice(0, 40)}"`);
    console.log(`         steps=${q.steps} (completed=${q.completedSteps}, blocked=${q.blockedSteps}) plannerCycles=${q.plannerCycles} cost=$${q.costUsd.toFixed(4)} wall=${(q.wallMs / 1000).toFixed(1)}s`);
  }

  console.log(`\nComparison vs single-Sonnet (iter 63b):`);
  console.log(`  Baseline: ${baselineCorrect}/5 (${(baselineCorrect * 20).toFixed(0)}%)`);
  console.log(`  DAG:      ${result.correct}/5 (${(result.accuracy * 100).toFixed(1)}%)`);
  console.log(`  Recovered: ${dagBetter} questions (single-Sonnet failed, DAG solved)`);
  console.log(`  Regressed: ${dagWorse} questions (single-Sonnet passed, DAG failed)`);

  console.log('\n=== Gate Verdict ===');
  const multiStepExecuted = result.perQuestion.some((q) => q.steps > 1);
  const avgSteps = result.avgStepsPerQuestion;

  if (result.correct >= 4 && multiStepExecuted) {
    console.log(`PROCEED to iter 65 full 53Q run.`);
    console.log(`  Reason: DAG ${result.correct}/5, avg ${avgSteps.toFixed(1)} steps/Q, multi-step plans executing.`);
  } else if (result.correct >= 3 && avgSteps >= 2) {
    console.log(`PROCEED with CAUTION to iter 65 — diagnose blocking first.`);
    console.log(`  Reason: DAG ${result.correct}/5, avg ${avgSteps.toFixed(1)} steps/Q.`);
  } else {
    console.log(`DIAGNOSE before iter 65.`);
    console.log(`  Reason: DAG ${result.correct}/5, avg ${avgSteps.toFixed(1)} steps/Q.`);
    if (!multiStepExecuted) {
      console.log(`  Issue: Plans collapsed to single step — check planner prompt.`);
    }
  }

  // Write JSON result
  const jsonOut = {
    run_type: 'dag-5q-pilot',
    iter: 64,
    timestamp: new Date().toISOString(),
    planModel: process.env['PLAN_MODEL'] ?? 'claude-sonnet-4-6',
    actModel: process.env['ACT_MODEL'] ?? 'gemini-2.5-pro',
    summary: {
      total: result.total,
      correct: result.correct,
      accuracy: result.accuracy,
      avgStepsPerQuestion: result.avgStepsPerQuestion,
      totalCostUsd: result.totalCostUsd,
      projectedCost53Q: result.projectedCost53Q,
      meanWallMs: result.meanWallMs,
    },
    baseline: { correct: baselineCorrect, total: 5, source: 'iter-63b' },
    perQuestion: result.perQuestion,
  };

  const outPath = `/Users/cohen/Projects/ruflo/docs/benchmarks/runs/gaia-l1-iter64-dag-5q-pilot.json`;
  const fs = await import('node:fs');
  fs.writeFileSync(outPath, JSON.stringify(jsonOut, null, 2));
  console.log(`\nResults written to: ${outPath}\n`);
}

main().catch((err) => {
  console.error('Pilot failed:', err);
  process.exit(1);
});
