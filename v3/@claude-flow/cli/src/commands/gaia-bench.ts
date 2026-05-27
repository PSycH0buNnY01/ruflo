/**
 * V3 CLI gaia-bench Command — ADR-133-PR8
 *
 * Runs GAIA benchmark questions through the claude-flow agent loop and
 * reports pass-rate, cost, and per-question results.
 *
 * Contract (matches gaia-benchmark.yml workflow expectations):
 *   node bin/cli.js gaia-bench run \
 *     --level <1|2|3> \
 *     --limit <N> \
 *     --models <csv> \
 *     --output json
 *
 * JSON output shape:
 *   {
 *     level: number,
 *     model: string,
 *     summary: { total, passed, passRate, estCostUsd },
 *     results: [{ task_id, question, model, correct, answer, expected_output, error }]
 *   }
 *
 * Refs: ADR-133, #2165
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';

// ---------------------------------------------------------------------------
// Pricing constants for cost estimation
// ---------------------------------------------------------------------------

const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-haiku-4-5': { inputPerM: 0.25, outputPerM: 1.25 },
  'claude-haiku-3': { inputPerM: 0.25, outputPerM: 1.25 },
  'claude-sonnet-4-5': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-sonnet-4-6': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-opus-4-5': { inputPerM: 15.0, outputPerM: 75.0 },
};

function estimateCost(
  model: string,
  totalInputTokens: number,
  totalOutputTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? { inputPerM: 3.0, outputPerM: 15.0 };
  return (
    (totalInputTokens / 1_000_000) * pricing.inputPerM +
    (totalOutputTokens / 1_000_000) * pricing.outputPerM
  );
}

// ---------------------------------------------------------------------------
// Result types (matches PR7 workflow contract)
// ---------------------------------------------------------------------------

interface QuestionResult {
  task_id: string;
  question: string;
  model: string;
  correct: boolean;
  answer: string | null;
  expected_output: string;
  error?: string;
  turns?: number;
  wallMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface BenchRunOutput {
  level: number;
  model: string;
  summary: {
    total: number;
    passed: number;
    passRate: number;
    estCostUsd: number;
    meanTurns: number;
    meanWallMs: number;
  };
  results: QuestionResult[];
}

// ---------------------------------------------------------------------------
// run subcommand
// ---------------------------------------------------------------------------

const runCommand: Command = {
  name: 'run',
  description: 'Run GAIA benchmark questions against one or more models',
  options: [
    {
      name: 'level',
      short: 'l',
      type: 'number',
      description: 'GAIA difficulty level: 1 (easiest), 2, or 3',
      default: '1',
    },
    {
      name: 'limit',
      short: 'n',
      type: 'number',
      description: 'Maximum number of questions to run (default: all)',
    },
    {
      name: 'models',
      short: 'm',
      type: 'string',
      description: 'Comma-separated list of model IDs to test',
      default: 'claude-haiku-4-5',
    },
    {
      name: 'output',
      short: 'o',
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
    {
      name: 'concurrency',
      short: 'c',
      type: 'number',
      description: 'Number of questions to run in parallel (default: 3)',
      default: '3',
    },
    {
      name: 'smoke-only',
      type: 'boolean',
      description: 'Use the 5-question smoke fixture instead of real HF dataset (no HF token required)',
      default: 'false',
    },
    {
      name: 'max-turns',
      type: 'number',
      description: 'Maximum agent turns per question (default: 8)',
      default: '8',
    },
    {
      name: 'judge-model',
      type: 'string',
      description: 'Model for LLM-as-judge scoring (default: claude-sonnet-4-6)',
      default: 'claude-sonnet-4-6',
    },
  ],
  examples: [
    {
      command: 'claude-flow gaia-bench run --level 1 --limit 10 --models claude-haiku-4-5 --output json',
      description: 'Run 10 Level-1 questions with Haiku, JSON output',
    },
    {
      command: 'claude-flow gaia-bench run --level 1 --limit 10 --models claude-haiku-4-5,claude-sonnet-4-6',
      description: 'Compare Haiku vs Sonnet on 10 Level-1 questions',
    },
    {
      command: 'claude-flow gaia-bench run --smoke-only --output json',
      description: 'Quick smoke test (5 fixture questions, no HF token needed)',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const level = parseInt(String(ctx.flags.level ?? '1'), 10) as 1 | 2 | 3;
    const limit = ctx.flags.limit ? parseInt(String(ctx.flags.limit), 10) : undefined;
    const modelsRaw = String(ctx.flags.models ?? 'claude-haiku-4-5');
    const models = modelsRaw.split(',').map((m) => m.trim()).filter(Boolean);
    const outputFormat = String(ctx.flags.output ?? 'text');
    const concurrency = parseInt(String(ctx.flags.concurrency ?? '3'), 10);
    // Parser converts --smoke-only to camelCase "smokeOnly"
    const smokeOnly = ctx.flags['smokeOnly'] === true || ctx.flags['smokeOnly'] === 'true' ||
      ctx.flags['smoke-only'] === true || ctx.flags['smoke-only'] === 'true';
    // Parser converts --max-turns → maxTurns, --judge-model → judgeModel
    const maxTurns = parseInt(String(ctx.flags['maxTurns'] ?? ctx.flags['max-turns'] ?? '8'), 10);
    const judgeModel = String(ctx.flags['judgeModel'] ?? ctx.flags['judge-model'] ?? 'claude-sonnet-4-6');

    // Dynamic imports to avoid loading at startup.
    // NOTE: gaia-*.ts sources are pre-compiled under dist/src/benchmarks/ only —
    // they are NOT in the src/ include glob so TypeScript cannot resolve them
    // statically.  We resolve the absolute path from import.meta.url at runtime
    // and cast to `any` to bypass the static-analysis check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const benchmarksBase = new URL('../benchmarks/', import.meta.url).href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { loadGaia } = (await import(benchmarksBase + 'gaia-loader.js')) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { runGaiaAgent } = (await import(benchmarksBase + 'gaia-agent.js')) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { judgeAnswer } = (await import(benchmarksBase + 'gaia-judge.js')) as any;

    // Only print to stderr so stdout stays clean for JSON consumers
    const log = (msg: string) => {
      if (outputFormat !== 'json') {
        output.writeln(msg);
      } else {
        process.stderr.write(msg + '\n');
      }
    };

    log('');
    log(output.bold(`GAIA Benchmark — Level ${level}${smokeOnly ? ' [SMOKE]' : ''}`));
    log(output.dim('─'.repeat(60)));
    log(`Models  : ${models.join(', ')}`);
    log(`Limit   : ${limit ?? 'all'}`);
    log(`Concurrency: ${concurrency}`);
    log('');

    // Load questions
    let questions;
    try {
      questions = await loadGaia({ level, limit, smokeOnly });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify({ error: `Failed to load GAIA dataset: ${msg}` }, null, 2) + '\n');
      } else {
        output.writeln(output.error(`Failed to load GAIA dataset: ${msg}`));
      }
      return { success: false };
    }

    log(`Loaded  : ${questions.length} questions`);
    log('');

    const allModelOutputs: BenchRunOutput[] = [];

    for (const model of models) {
      log(output.bold(`Running model: ${model}`));
      log(output.dim('─'.repeat(40)));

      const results: QuestionResult[] = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalTurns = 0;
      let totalWallMs = 0;

      // Process questions in batches of `concurrency`
      for (let i = 0; i < questions.length; i += concurrency) {
        const batch = questions.slice(i, Math.min(i + concurrency, questions.length));

        const batchResults = await Promise.all(
          batch.map(async (q) => {
            const qIdx = i + batch.indexOf(q) + 1;
            log(`  [${qIdx}/${questions.length}] ${q.task_id} — ${q.question.slice(0, 60)}...`);

            let agentResult;
            try {
              agentResult = await runGaiaAgent(q, {
                model,
                maxTurns,
              });
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              log(`    ERROR: ${errorMsg}`);
              return {
                task_id: q.task_id,
                question: q.question,
                model,
                correct: false,
                answer: null,
                expected_output: q.final_answer,
                error: errorMsg,
              } as QuestionResult;
            }

            // Judge the answer
            let judgeResult;
            try {
              judgeResult = await judgeAnswer(
                { id: q.task_id, expected: q.final_answer, questionText: q.question },
                agentResult.finalAnswer,
                { judgeModel },
              );
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              judgeResult = {
                questionId: q.task_id,
                passed: false,
                scoringPath: 'exact-match' as const,
                candidateAnswer: agentResult.finalAnswer ?? '',
                groundTruth: q.final_answer,
                judgeReason: `Judge error: ${errorMsg}`,
              };
            }

            const verdict = judgeResult.passed ? output.success('PASS') : output.error('FAIL');
            log(
              `    ${verdict}  answer="${agentResult.finalAnswer ?? 'null'}"  expected="${q.final_answer}"` +
              `  turns=${agentResult.turns}  ${(agentResult.wallMs / 1000).toFixed(1)}s`,
            );

            return {
              task_id: q.task_id,
              question: q.question,
              model,
              correct: judgeResult.passed,
              answer: agentResult.finalAnswer,
              expected_output: q.final_answer,
              error: agentResult.error,
              turns: agentResult.turns,
              wallMs: agentResult.wallMs,
              inputTokens: agentResult.totalInputTokens,
              outputTokens: agentResult.totalOutputTokens,
            } as QuestionResult;
          }),
        );

        for (const r of batchResults) {
          results.push(r);
          totalInputTokens += r.inputTokens ?? 0;
          totalOutputTokens += r.outputTokens ?? 0;
          totalTurns += r.turns ?? 0;
          totalWallMs += r.wallMs ?? 0;
        }
      }

      const passed = results.filter((r) => r.correct).length;
      const total = results.length;
      const passRate = total > 0 ? passed / total : 0;
      const estCostUsd = estimateCost(model, totalInputTokens, totalOutputTokens);

      const modelOutput: BenchRunOutput = {
        level,
        model,
        summary: {
          total,
          passed,
          passRate,
          estCostUsd,
          meanTurns: total > 0 ? totalTurns / total : 0,
          meanWallMs: total > 0 ? totalWallMs / total : 0,
        },
        results,
      };
      allModelOutputs.push(modelOutput);

      log('');
      log(output.bold(`Results for ${model}:`));
      log(`  Pass rate : ${passed}/${total} (${(passRate * 100).toFixed(1)}%)`);
      log(`  Est. cost : $${estCostUsd.toFixed(4)}`);
      log(`  Mean turns: ${modelOutput.summary.meanTurns.toFixed(1)}`);
      log(`  Mean time : ${(modelOutput.summary.meanWallMs / 1000).toFixed(1)}s per question`);
      log('');
    }

    // Output results
    if (outputFormat === 'json') {
      if (allModelOutputs.length === 1) {
        // Single model: emit flat object (matches workflow contract)
        process.stdout.write(JSON.stringify(allModelOutputs[0], null, 2) + '\n');
      } else {
        // Multiple models: emit array
        process.stdout.write(JSON.stringify(allModelOutputs, null, 2) + '\n');
      }
    } else {
      // Print summary table
      output.writeln(output.bold('Summary'));
      output.writeln(output.dim('─'.repeat(60)));
      for (const m of allModelOutputs) {
        const pct = (m.summary.passRate * 100).toFixed(1);
        output.writeln(
          `${m.model.padEnd(28)} ${m.summary.passed}/${m.summary.total} (${pct}%)` +
          `  cost=$${m.summary.estCostUsd.toFixed(4)}` +
          `  turns=${m.summary.meanTurns.toFixed(1)}`,
        );
      }
    }

    return { success: true };
  },
};

// ---------------------------------------------------------------------------
// Main gaia-bench command
// ---------------------------------------------------------------------------

export const gaiaBenchCommand: Command = {
  name: 'gaia-bench',
  description: 'GAIA benchmark harness — measure agent pass-rate on real GAIA questions',
  subcommands: [runCommand],
  examples: [
    {
      command: 'claude-flow gaia-bench run --level 1 --limit 10 --models claude-haiku-4-5 --output json',
      description: 'Mini Level-1 run with Haiku, JSON output',
    },
    {
      command: 'claude-flow gaia-bench run --smoke-only',
      description: 'Quick smoke test with built-in fixture (no HF token)',
    },
  ],
};

export default gaiaBenchCommand;
