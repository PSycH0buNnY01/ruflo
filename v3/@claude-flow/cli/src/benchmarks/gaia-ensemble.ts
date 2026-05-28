/**
 * GAIA Ensemble Runner — ADR-139
 *
 * Runs a GAIA question through N models in parallel, aggregates answers via
 * majority vote, with a judge-model tiebreak when no consensus is reached.
 *
 * Architecture:
 *   1. Each model runs independently using the full tool harness.
 *   2. Answers are normalised (via normaliseAnswer from gaia-judge.ts).
 *   3. Majority vote: if ≥2 models agree on normalised answer → that wins.
 *   4. Tiebreak: when all answers differ (or N=2 with disagreement), the judge
 *      model picks the best answer with a brief rationale.
 *   5. Abstain: if all models return null/timedOut → failed question.
 *
 * Supported models:
 *   - Claude (claude-sonnet-4-6, etc.) via Anthropic API (gaia-agent.ts)
 *   - Gemini (gemini-2.5-pro, etc.) via Google AI API (gaia-agent-gemini.js compiled)
 *   - OpenRouter (gpt-5, deepseek-v3.2, kimi-k2, etc.) via OpenAI-compatible API
 *     NOTE: OpenRouter requires funded account — returns 402 when credits exhausted.
 *
 * CLI integration:
 *   gaia-bench run --mode=ensemble --models=claude-sonnet-4-6,gemini-2.5-pro,openai/gpt-5
 *
 * Cost model (per question, typical L1 ~10k input + ~3k output tokens):
 *   claude-sonnet-4-6:  ~$0.075
 *   gemini-2.5-pro:     ~$0.043
 *   openai/gpt-5 (OR):  ~$0.043
 *   3-model total:      ~$0.161  (53-Q: ~$8.54, 300-Q: ~$48.30)
 *
 * Refs: ADR-139, ADR-133, ADR-135, #2156
 */

import { execSync } from 'node:child_process';
import { GaiaQuestion } from './gaia-loader.js';
import { GaiaAgentResult, GaiaAgentOptions, runGaiaAgent, resolveAnthropicApiKey } from './gaia-agent.js';
import { normaliseAnswer } from './gaia-judge.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_JUDGE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_TIEBREAK_MAX_TOKENS = 300;
const FINAL_ANSWER_RE = /FINAL_ANSWER:\s*(.+)/i;

/** Prefix for OpenRouter model IDs — any model containing "/" is treated as OR. */
const OPENROUTER_MODEL_MARKER = '/';
/** Prefix for Gemini model IDs. */
const GEMINI_MODEL_PREFIX = 'gemini-';

// ---------------------------------------------------------------------------
// Pricing constants (USD per million tokens)
// ---------------------------------------------------------------------------

const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-haiku-4-5': { inputPerM: 0.25, outputPerM: 1.25 },
  'claude-sonnet-4-5': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-sonnet-4-6': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-opus-4-7': { inputPerM: 5.0, outputPerM: 25.0 },
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10.0 },
  'gemini-2.5-flash': { inputPerM: 0.30, outputPerM: 2.50 },
  // OpenRouter models — verified available 2026-05-28
  'openai/gpt-5': { inputPerM: 1.25, outputPerM: 10.0 },
  'openai/gpt-5.4': { inputPerM: 2.50, outputPerM: 15.0 },
  'openai/o3': { inputPerM: 2.00, outputPerM: 8.0 },
  'deepseek/deepseek-v3.2': { inputPerM: 0.252, outputPerM: 0.378 },
  'moonshotai/kimi-k2': { inputPerM: 0.57, outputPerM: 2.30 },
  'moonshotai/kimi-k2.6': { inputPerM: 0.73, outputPerM: 3.49 },
  'qwen/qwen3.7-max': { inputPerM: 1.25, outputPerM: 3.75 },
};

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? { inputPerM: 3.0, outputPerM: 15.0 };
  return (inputTokens / 1_000_000) * pricing.inputPerM +
         (outputTokens / 1_000_000) * pricing.outputPerM;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ModelRunResult {
  model: string;
  finalAnswer: string | null;
  normalisedAnswer: string;
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  wallMs: number;
  estimatedCostUsd: number;
  timedOut?: boolean;
  error?: string;
}

export type AggregationMethod = 'majority' | 'judge-tiebreak' | 'abstain';

export interface EnsembleResult {
  questionId: string;
  finalAnswer: string | null;
  aggregationMethod: AggregationMethod;
  /** Rationale from the judge tiebreak (only set when method is 'judge-tiebreak'). */
  judgeRationale?: string;
  models: ModelRunResult[];
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  wallMs: number;
}

export interface EnsembleOptions {
  /** Models to use (provider inferred from model ID). */
  models?: string[];
  /** Judge model for tiebreak (default: claude-sonnet-4-6). */
  judgeModel?: string;
  /** Anthropic API key (resolved from env/gcloud if not supplied). */
  anthropicApiKey?: string;
  /** Google AI API key (resolved from env/gcloud if not supplied). */
  geminiApiKey?: string;
  /** OpenRouter API key (resolved from env/gcloud if not supplied). */
  openrouterApiKey?: string;
  /** Per-model max turns (default: 8). */
  maxTurns?: number;
  /** Per-model max tokens per turn (default: 2048). */
  maxTokensPerTurn?: number;
  /** Per-turn timeout in ms (default: 60 000). */
  perTurnTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

function resolveGeminiApiKey(supplied?: string): string {
  if (supplied?.trim()) return supplied.trim();
  const env = process.env['GOOGLE_AI_API_KEY'] || process.env['GEMINI_API_KEY'];
  if (env?.trim()) return env.trim();
  try {
    const out = execSync(
      'gcloud secrets versions access latest --secret=GOOGLE_AI_API_KEY 2>/dev/null',
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    if (out) return out;
  } catch { /* fall through */ }
  try {
    const out = execSync(
      'gcloud secrets versions access latest --secret=GEMINI_API_KEY 2>/dev/null',
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    if (out) return out;
  } catch { /* fall through */ }
  throw new Error('GOOGLE_AI_API_KEY not found in env or GCP Secret Manager.');
}

function resolveOpenRouterApiKey(supplied?: string): string | null {
  if (supplied?.trim()) return supplied.trim();
  const env = process.env['OPENROUTER_API_KEY'];
  if (env?.trim()) return env.trim();
  try {
    const out = execSync(
      'gcloud secrets versions access latest --secret=OPENROUTER_API_KEY 2>/dev/null',
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    if (out) return out;
  } catch { /* fall through */ }
  return null;
}

// ---------------------------------------------------------------------------
// Model dispatch helpers
// ---------------------------------------------------------------------------

function isGeminiModel(modelId: string): boolean {
  return modelId.startsWith(GEMINI_MODEL_PREFIX);
}

function isOpenRouterModel(modelId: string): boolean {
  return modelId.includes(OPENROUTER_MODEL_MARKER);
}

/** Run a single Gemini model via REST API (mirrors gaia-agent-gemini compiled logic). */
async function runGeminiModel(
  question: GaiaQuestion,
  model: string,
  apiKey: string,
  maxTurns: number,
  maxTokensPerTurn: number,
  perTurnTimeoutMs: number,
): Promise<ModelRunResult> {
  const wallStart = Date.now();
  // Lazy import the compiled Gemini agent (TypeScript source lives in dist only).
  // The module exists at runtime but has no .ts source in src/ — use a type-asserted
  // dynamic import path that resolves at runtime via the compiled output.
  type GeminiAgentFn = (q: GaiaQuestion, opts: Record<string, unknown>) => Promise<{
    questionId: string;
    finalAnswer: string | null;
    turns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalThinkingTokens: number;
    wallMs: number;
    estimatedCostUsd: number;
    timedOut?: boolean;
    error?: string;
  }>;
  // The compiled Gemini agent has no .ts source in src/ — load via dynamic import.
  // new Function trick bypasses the static import() type-check for a dist-only module.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<Record<string, unknown>>;
  const geminiMod = await dynamicImport('./gaia-agent-gemini.js');
  const runGeminiAgent = geminiMod['runGeminiAgent'] as GeminiAgentFn;

  const raw = await runGeminiAgent(question, {
    model,
    maxTurns,
    maxTokensPerTurn,
    perTurnTimeoutMs,
    apiKey,
  });

  return {
    model,
    finalAnswer: raw.finalAnswer,
    normalisedAnswer: normaliseAnswer(raw.finalAnswer),
    turns: raw.turns,
    totalInputTokens: raw.totalInputTokens,
    totalOutputTokens: raw.totalOutputTokens + (raw.totalThinkingTokens ?? 0),
    wallMs: raw.wallMs,
    estimatedCostUsd: raw.estimatedCostUsd,
    timedOut: raw.timedOut,
    error: raw.error,
  };
}

/** Run a model via OpenRouter's OpenAI-compatible chat API. */
async function runOpenRouterModel(
  question: GaiaQuestion,
  model: string,
  apiKey: string,
  maxTurns: number,
  maxTokensPerTurn: number,
  perTurnTimeoutMs: number,
): Promise<ModelRunResult> {
  const wallStart = Date.now();

  const systemPrompt = [
    'You are a precise question-answering agent.',
    'RULES:',
    '1. Answer using your best knowledge and reasoning.',
    '2. When you have a final answer, output it on this EXACT format: FINAL_ANSWER: <answer>',
    '3. Keep answers concise. For numbers, just the number. For names, just the name.',
    '4. Do not include units unless specifically asked.',
    '5. MANDATORY: Always end with a FINAL_ANSWER line.',
  ].join('\n');

  type Message = { role: 'system' | 'user' | 'assistant'; content: string };
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question.question },
  ];

  let finalAnswer: string | null = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;
  let error: string | undefined;

  // OpenRouter does not support tool use in this thin adapter — runs non-agentic.
  // For GAIA L1 (mostly factual/reasoning), direct completion is sufficient.
  for (let turn = 0; turn < Math.min(maxTurns, 3); turn++) {
    turns = turn + 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perTurnTimeoutMs);

    let resp: Response;
    try {
      resp = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/ruvnet/ruflo',
          'X-Title': 'Ruflo GAIA Benchmark',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokensPerTurn,
          temperature: 0,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '<unreadable>');
      error = `OpenRouter API error ${resp.status}: ${errText.slice(0, 300)}`;
      break;
    }

    const data = await resp.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    totalInputTokens += data.usage?.prompt_tokens ?? 0;
    totalOutputTokens += data.usage?.completion_tokens ?? 0;

    const content = data.choices[0]?.message.content ?? '';
    const match = FINAL_ANSWER_RE.exec(content);
    if (match?.[1]) {
      finalAnswer = match[1].trim();
      break;
    }

    // No answer yet — append assistant reply and ask to commit
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: 'Please commit to a final answer: FINAL_ANSWER: <your answer>' });
  }

  const wallMs = Date.now() - wallStart;
  return {
    model,
    finalAnswer,
    normalisedAnswer: normaliseAnswer(finalAnswer),
    turns,
    totalInputTokens,
    totalOutputTokens,
    wallMs,
    estimatedCostUsd: estimateCostUsd(model, totalInputTokens, totalOutputTokens),
    error,
  };
}

/** Run a Claude model via Anthropic API (full agentic harness). */
async function runClaudeModel(
  question: GaiaQuestion,
  model: string,
  apiKey: string,
  opts: GaiaAgentOptions,
): Promise<ModelRunResult> {
  const raw: GaiaAgentResult = await runGaiaAgent(question, { ...opts, model, apiKey });
  return {
    model,
    finalAnswer: raw.finalAnswer,
    normalisedAnswer: normaliseAnswer(raw.finalAnswer),
    turns: raw.turns,
    totalInputTokens: raw.totalInputTokens,
    totalOutputTokens: raw.totalOutputTokens,
    wallMs: raw.wallMs,
    estimatedCostUsd: estimateCostUsd(model, raw.totalInputTokens, raw.totalOutputTokens),
    timedOut: raw.timedOut,
    error: raw.error,
  };
}

// ---------------------------------------------------------------------------
// Tiebreak judge
// ---------------------------------------------------------------------------

async function judgePickBest(
  question: GaiaQuestion,
  candidates: Array<{ model: string; answer: string }>,
  judgeModel: string,
  apiKey: string,
): Promise<{ answer: string; rationale: string; inputTokens: number; outputTokens: number }> {
  const candidateLines = candidates
    .map((c, i) => `  Option ${i + 1} (${c.model}): "${c.answer}"`)
    .join('\n');

  const prompt = [
    `Question: ${question.question}`,
    '',
    'The following models gave different answers. Pick the most likely correct answer.',
    'Consider factual accuracy, question phrasing, and common GAIA evaluation rules',
    '(exact match, no trailing units unless asked).',
    '',
    'Candidates:',
    candidateLines,
    '',
    'Respond in this EXACT format:',
    'BEST_ANSWER: <the answer text, exactly as it would appear>',
    'RATIONALE: <brief 1-sentence justification>',
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let resp: Response;
  try {
    resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: judgeModel,
        max_tokens: DEFAULT_TIEBREAK_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '<unreadable>');
    throw new Error(`Judge API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const answerMatch = /BEST_ANSWER:\s*(.+)/i.exec(text);
  const rationaleMatch = /RATIONALE:\s*(.+)/i.exec(text);

  return {
    answer: answerMatch?.[1]?.trim() ?? candidates[0].answer,
    rationale: rationaleMatch?.[1]?.trim() ?? '',
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregateByMajority(results: ModelRunResult[]): {
  answer: string | null;
  method: AggregationMethod;
} {
  const answered = results.filter((r) => r.normalisedAnswer !== '');
  if (answered.length === 0) return { answer: null, method: 'abstain' };

  // Count occurrences of each normalised answer
  const counts: Map<string, number> = new Map();
  for (const r of answered) {
    counts.set(r.normalisedAnswer, (counts.get(r.normalisedAnswer) ?? 0) + 1);
  }

  // Check for majority (> 50% of total models)
  const threshold = results.length / 2;
  for (const [norm, count] of counts) {
    if (count > threshold) {
      // Find the original (un-normalised) answer from any matching result
      const match = answered.find((r) => r.normalisedAnswer === norm);
      return { answer: match!.finalAnswer, method: 'majority' };
    }
  }

  // No majority — needs tiebreak
  return { answer: null, method: 'judge-tiebreak' };
}

// ---------------------------------------------------------------------------
// Public: run a single question through the ensemble
// ---------------------------------------------------------------------------

export async function runEnsembleQuestion(
  question: GaiaQuestion,
  options: EnsembleOptions = {},
): Promise<EnsembleResult> {
  const {
    models = ['claude-sonnet-4-6', 'gemini-2.5-pro'],
    judgeModel = DEFAULT_JUDGE_MODEL,
    anthropicApiKey: suppliedAnthropicKey,
    geminiApiKey: suppliedGeminiKey,
    openrouterApiKey: suppliedOrKey,
    maxTurns = 8,
    maxTokensPerTurn = 2048,
    perTurnTimeoutMs = 60_000,
  } = options;

  const wallStart = Date.now();

  // Resolve API keys once
  const anthropicKey = resolveAnthropicApiKey(suppliedAnthropicKey);
  const geminiKey = isGeminiModelNeeded(models) ? resolveGeminiApiKey(suppliedGeminiKey) : '';
  const orKey = isORModelNeeded(models) ? (resolveOpenRouterApiKey(suppliedOrKey) ?? '') : '';

  // Run all models in parallel
  const modelPromises = models.map((modelId) => {
    if (isOpenRouterModel(modelId)) {
      if (!orKey) {
        return Promise.resolve<ModelRunResult>({
          model: modelId,
          finalAnswer: null,
          normalisedAnswer: '',
          turns: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          wallMs: 0,
          estimatedCostUsd: 0,
          error: 'OPENROUTER_API_KEY not available or account exhausted',
        });
      }
      return runOpenRouterModel(question, modelId, orKey, maxTurns, maxTokensPerTurn, perTurnTimeoutMs);
    }
    if (isGeminiModel(modelId)) {
      return runGeminiModel(question, modelId, geminiKey, maxTurns, maxTokensPerTurn, perTurnTimeoutMs);
    }
    // Default: Claude via Anthropic API
    return runClaudeModel(question, modelId, anthropicKey, {
      maxTurns,
      maxTokensPerTurn,
      perTurnTimeoutMs,
    });
  });

  const modelResults = await Promise.all(modelPromises);

  // Aggregate
  const { answer: majorityAnswer, method } = aggregateByMajority(modelResults);

  let finalAnswer = majorityAnswer;
  let aggregationMethod: AggregationMethod = method;
  let judgeRationale: string | undefined;
  let judgeInputTokens = 0;
  let judgeOutputTokens = 0;

  if (method === 'judge-tiebreak') {
    const candidates = modelResults
      .filter((r) => r.normalisedAnswer !== '')
      .map((r) => ({ model: r.model, answer: r.finalAnswer ?? '' }));

    if (candidates.length > 0) {
      try {
        const judgeResult = await judgePickBest(question, candidates, judgeModel, anthropicKey);
        finalAnswer = judgeResult.answer;
        judgeRationale = judgeResult.rationale;
        judgeInputTokens = judgeResult.inputTokens;
        judgeOutputTokens = judgeResult.outputTokens;
      } catch (e) {
        // Judge failed — fall back to first non-null answer
        finalAnswer = candidates[0].answer;
        judgeRationale = `Judge failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      aggregationMethod = 'abstain';
    }
  }

  const totalInputTokens = modelResults.reduce((s, r) => s + r.totalInputTokens, 0) + judgeInputTokens;
  const totalOutputTokens = modelResults.reduce((s, r) => s + r.totalOutputTokens, 0) + judgeOutputTokens;
  const modelCost = modelResults.reduce((s, r) => s + r.estimatedCostUsd, 0);
  const judgeCost = estimateCostUsd(judgeModel, judgeInputTokens, judgeOutputTokens);

  return {
    questionId: question.task_id,
    finalAnswer,
    aggregationMethod,
    judgeRationale,
    models: modelResults,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd: modelCost + judgeCost,
    wallMs: Date.now() - wallStart,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isGeminiModelNeeded(models: string[]): boolean {
  return models.some(isGeminiModel);
}

function isORModelNeeded(models: string[]): boolean {
  return models.some(isOpenRouterModel);
}

// ---------------------------------------------------------------------------
// 5-question pilot runner
// ---------------------------------------------------------------------------

export interface EnsemblePilotResult {
  correct: number;
  total: number;
  accuracy: number;
  perQuestion: Array<{
    taskId: string;
    question: string;
    expected: string;
    got: string | null;
    correct: boolean;
    aggregationMethod: AggregationMethod;
    judgeRationale?: string;
    costUsd: number;
    wallMs: number;
    perModel: Array<{ model: string; answer: string | null; costUsd: number }>;
  }>;
  totalCostUsd: number;
  projectedCost53Q: number;
  projectedCost300Q: number;
  meanWallMs: number;
}

export async function runEnsemblePilot(
  questions: GaiaQuestion[],
  options: EnsembleOptions = {},
): Promise<EnsemblePilotResult> {
  const perQuestion: EnsemblePilotResult['perQuestion'] = [];
  let correct = 0;

  for (const q of questions) {
    const result = await runEnsembleQuestion(q, options);
    const norm = normaliseAnswer(result.finalAnswer);
    const expectedNorm = normaliseAnswer(q.final_answer);
    const isCorrect = norm !== '' && norm === expectedNorm;
    if (isCorrect) correct++;

    perQuestion.push({
      taskId: q.task_id,
      question: q.question.slice(0, 80),
      expected: q.final_answer ?? '',
      got: result.finalAnswer,
      correct: isCorrect,
      aggregationMethod: result.aggregationMethod,
      judgeRationale: result.judgeRationale,
      costUsd: result.estimatedCostUsd,
      wallMs: result.wallMs,
      perModel: result.models.map((m) => ({
        model: m.model,
        answer: m.finalAnswer,
        costUsd: m.estimatedCostUsd,
      })),
    });

    // Progress log to stderr to avoid polluting stdout JSON
    process.stderr.write(
      `[ensemble] ${q.task_id} → ${result.finalAnswer ?? 'null'} ` +
      `(${result.aggregationMethod}, ${isCorrect ? 'CORRECT' : 'WRONG'}, $${result.estimatedCostUsd.toFixed(4)})\n`,
    );
  }

  const totalCostUsd = perQuestion.reduce((s, r) => s + r.costUsd, 0);
  const avgCostPerQ = totalCostUsd / Math.max(perQuestion.length, 1);
  const meanWallMs = perQuestion.reduce((s, r) => s + r.wallMs, 0) / Math.max(perQuestion.length, 1);

  return {
    correct,
    total: perQuestion.length,
    accuracy: correct / Math.max(perQuestion.length, 1),
    perQuestion,
    totalCostUsd,
    projectedCost53Q: avgCostPerQ * 53,
    projectedCost300Q: avgCostPerQ * 300,
    meanWallMs,
  };
}
