/**
 * GAIA Agent — ADR-133-PR3 / ADR-135 (planning interval)
 *
 * Multi-turn Anthropic Messages API loop that drives Claude through the
 * GAIA benchmark questions using a tool-use agent pattern.
 *
 * Loop algorithm:
 *   1. Build initial message with the question and a system prompt that
 *      instructs Claude to output `FINAL_ANSWER: <value>` when done.
 *   2. Call Anthropic Messages API with the registered tool definitions.
 *   3. On `stop_reason === 'tool_use'`: execute all tool_use blocks in
 *      parallel, append results as a `user` turn, and repeat.
 *      Every PLANNING_INTERVAL turns, inject a planning-checkpoint text
 *      alongside the tool results to force strategy re-evaluation.
 *   4. On `stop_reason === 'end_turn'`: scan content for the final answer
 *      pattern and return the result.
 *   5. On timeout (maxTurns exceeded): return `{ timedOut: true }`.
 *
 * API key resolution order (mirrors resolveHfToken from gaia-loader.ts):
 *   1. `options.apiKey` (caller-supplied)
 *   2. `ANTHROPIC_API_KEY` env var
 *   3. `gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY`
 *
 * Cost discipline: smoke runs use `claude-haiku-4-5` only.  The smoke
 * runner at the bottom of this file enforces that model.
 *
 * Planning interval (iter 30 finding #3):
 *   smolagents CodeAgent uses planning_interval=4 — replans every 4 steps
 *   to prevent tunnel-vision on bad strategies. Adds ~80 tokens per
 *   replan event (~$0.0001 each), negligible cost.
 *
 * Refs: ADR-133, ADR-135, iter 30, #2156
 */

import { execSync } from 'node:child_process';
import {
  GaiaQuestion,
  SMOKE_FIXTURE,
} from './gaia-loader.js';
import {
  createDefaultToolCatalogue,
  GaiaToolCatalogue,
  ToolDefinition,
  ToolUseBlock,
  TextBlock,
  ContentBlock,
} from './gaia-tools/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOKENS_PER_TURN = 2048;
const DEFAULT_PER_TURN_TIMEOUT_MS = 60_000;

/**
 * Every PLANNING_INTERVAL tool_use turns, inject a planning-checkpoint
 * message to force the agent to reassess its strategy.
 *
 * Based on iter 30 research: smolagents CodeAgent uses planning_interval=4.
 * HAL reliability analysis showed agents fail when they exhaust step
 * budgets without recalibrating.
 */
export const PLANNING_INTERVAL = 4;

/**
 * Build the planning-checkpoint text injected every PLANNING_INTERVAL turns.
 * Exported so tests can snapshot the exact wording.
 */
export function buildPlanningCheckpoint(turn: number, maxTurns: number): string {
  return (
    `[PLANNING CHECKPOINT — turn ${turn}/${maxTurns}]\n` +
    `You have used ${turn} turns so far. Before continuing:\n` +
    `1. Briefly summarize what you have learned from the tool calls so far.\n` +
    `2. State explicitly whether your current approach is making progress toward the answer.\n` +
    `3. If NOT making progress, switch strategy: try a different tool, different query, ` +
    `or decompose the question differently.\n` +
    `4. If you are confident in an answer, provide it now in your standard format: ` +
    `FINAL_ANSWER: <your answer>`
  );
}

/** Pattern Claude must output to signal it has a final answer. */
const FINAL_ANSWER_RE = /FINAL_ANSWER:\s*(.+)/i;

// Haiku pricing (input/output per million tokens, as of 2026-05-27).
// Used only for smoke cost estimation — not billed here.
const HAIKU_INPUT_COST_PER_M = 0.25;
const HAIKU_OUTPUT_COST_PER_M = 1.25;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GaiaAgentResult {
  questionId: string;
  finalAnswer: string | null;
  turns: number;
  toolCallsByName: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  wallMs: number;
  /** Number of planning-checkpoint injections during this run. */
  replanCount: number;
  timedOut?: boolean;
  error?: string;
}

export interface GaiaAgentOptions {
  /** Model to use (default: 'claude-haiku-4-5'). */
  model?: string;
  /** Maximum number of agent turns before giving up (default: 8). */
  maxTurns?: number;
  /** Maximum tokens per Anthropic API call (default: 2048). */
  maxTokensPerTurn?: number;
  /** Per-turn HTTP timeout in milliseconds (default: 60 000). */
  perTurnTimeoutMs?: number;
  /**
   * Inject a planning-checkpoint every N tool_use turns (default: PLANNING_INTERVAL = 4).
   * Set to 0 to disable planning checkpoints.
   */
  planningInterval?: number;
  /**
   * Anthropic API key.  Resolved automatically via env var + gcloud fallback
   * if omitted.
   */
  apiKey?: string;
  /**
   * Pre-built tool catalogue.  Defaults to `createDefaultToolCatalogue()`.
   * Exposed so callers can inject mocks for testing.
   */
  catalogue?: GaiaToolCatalogue;
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Anthropic API key.
 *
 * Resolution order:
 *   1. Caller-supplied `apiKey`
 *   2. `ANTHROPIC_API_KEY` env var
 *   3. `gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY`
 *
 * Throws with a clear message if none of the above is available.
 */
export function resolveAnthropicApiKey(apiKey?: string): string {
  if (apiKey && apiKey.trim()) return apiKey.trim();

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();

  try {
    const out = execSync(
      'gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY 2>/dev/null',
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    if (out) return out;
  } catch {
    /* fall through */
  }

  throw new Error(
    'ANTHROPIC_API_KEY not found.  Set the env var or store it in GCP Secret Manager under ' +
    '"ANTHROPIC_API_KEY" (e.g. `echo -n "$KEY" | gcloud secrets versions add ANTHROPIC_API_KEY --data-file=-`).',
  );
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    'You are a precise question-answering agent.  Your task is to answer the user\'s question',
    'using the tools available to you.',
    '',
    'RULES:',
    '1. Use tools when you need information you do not have with certainty.',
    '2. When you are confident in the answer, output it on its own line in this exact format:',
    '   FINAL_ANSWER: <your answer here>',
    '3. Keep answers concise.  For numbers, give just the number.  For names, give just the name.',
    '4. Do not include units unless the question specifically asks for them.',
    '5. If after all tool calls you still cannot determine the answer, output:',
    '   FINAL_ANSWER: I don\'t know',
  ].join('\n');
}

function buildUserMessage(question: string): string {
  return question;
}

// ---------------------------------------------------------------------------
// Anthropic Messages API call (single turn)
// ---------------------------------------------------------------------------

/** Minimal types for the Anthropic Messages API response. */
interface AnthropicResponse {
  id: string;
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
  content: ContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface MessageParam {
  role: 'user' | 'assistant';
  content: ContentBlock[] | string;
}

async function callAnthropicWithTools(
  apiKey: string,
  model: string,
  messages: MessageParam[],
  toolDefs: ToolDefinition[],
  maxTokens: number,
  timeoutMs: number,
): Promise<AnthropicResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: buildSystemPrompt(),
        messages,
        tools: toolDefs,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '<unreadable>');
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 400)}`);
  }

  return (await res.json()) as AnthropicResponse;
}

// ---------------------------------------------------------------------------
// Extract final answer from a response
// ---------------------------------------------------------------------------

function extractFinalAnswer(resp: AnthropicResponse): string | null {
  for (const block of resp.content) {
    if (block.type === 'text') {
      const textBlock = block as TextBlock;
      const match = FINAL_ANSWER_RE.exec(textBlock.text);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Execute all tool_use blocks in a response
// ---------------------------------------------------------------------------

interface ToolResultMessageContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

async function executeToolCalls(
  resp: AnthropicResponse,
  catalogue: GaiaToolCatalogue,
): Promise<ToolResultMessageContent[]> {
  const toolUseBlocks = resp.content.filter(
    (b): b is ToolUseBlock => b.type === 'tool_use',
  );

  const results = await Promise.all(
    toolUseBlocks.map(async (block): Promise<ToolResultMessageContent> => {
      const tool = catalogue.find((t) => t.name === block.name);
      if (!tool) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Unknown tool: "${block.name}". Available tools: ${catalogue.map((t) => t.name).join(', ')}.`,
          is_error: true,
        };
      }
      try {
        const output = await tool.execute(block.input);
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: output,
        };
      } catch (err) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

/**
 * Run a GAIA question through Claude with tool use.
 *
 * @returns GaiaAgentResult with the final answer (or null if timed out),
 * turn count, token totals, and per-tool call counts.
 */
export async function runGaiaAgent(
  question: GaiaQuestion,
  options: GaiaAgentOptions = {},
): Promise<GaiaAgentResult> {
  const {
    model = DEFAULT_MODEL,
    maxTurns = DEFAULT_MAX_TURNS,
    maxTokensPerTurn = DEFAULT_MAX_TOKENS_PER_TURN,
    perTurnTimeoutMs = DEFAULT_PER_TURN_TIMEOUT_MS,
    planningInterval = PLANNING_INTERVAL,
    apiKey: suppliedKey,
    catalogue: suppliedCatalogue,
  } = options;

  const wallStart = Date.now();
  const apiKey = resolveAnthropicApiKey(suppliedKey);
  const catalogue = suppliedCatalogue ?? createDefaultToolCatalogue();
  const toolDefs = catalogue.map((t) => t.definition);

  const toolCallsByName: Record<string, number> = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let replanCount = 0;

  const messages: MessageParam[] = [
    { role: 'user', content: buildUserMessage(question.question) },
  ];

  let turns = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    turns = turn + 1;

    let resp: AnthropicResponse;
    try {
      resp = await callAnthropicWithTools(
        apiKey,
        model,
        messages,
        toolDefs,
        maxTokensPerTurn,
        perTurnTimeoutMs,
      );
    } catch (err) {
      return {
        questionId: question.task_id,
        finalAnswer: null,
        turns,
        toolCallsByName,
        totalInputTokens,
        totalOutputTokens,
        wallMs: Date.now() - wallStart,
        replanCount,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    totalInputTokens += resp.usage.input_tokens;
    totalOutputTokens += resp.usage.output_tokens;

    if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'max_tokens') {
      const finalAnswer = extractFinalAnswer(resp);
      return {
        questionId: question.task_id,
        finalAnswer,
        turns,
        toolCallsByName,
        totalInputTokens,
        totalOutputTokens,
        wallMs: Date.now() - wallStart,
        replanCount,
      };
    }

    if (resp.stop_reason === 'tool_use') {
      // Track tool call counts before executing
      for (const block of resp.content) {
        if (block.type === 'tool_use') {
          const toolBlock = block as ToolUseBlock;
          toolCallsByName[toolBlock.name] = (toolCallsByName[toolBlock.name] ?? 0) + 1;
        }
      }

      // Execute all tool calls in parallel
      const toolResults = await executeToolCalls(resp, catalogue);

      // Append assistant turn (with tool_use blocks)
      messages.push({ role: 'assistant', content: resp.content });

      // Planning checkpoint: every planningInterval turns (starting from turn 1),
      // inject a replan prompt alongside the tool results.
      // Conditions: interval is positive, turn>0 (has history), and (turns % interval === 0).
      const shouldReplan =
        planningInterval > 0 &&
        turns > 0 &&
        turns % planningInterval === 0;

      if (shouldReplan) {
        replanCount++;
        const checkpoint = buildPlanningCheckpoint(turns, maxTurns);
        messages.push({
          role: 'user',
          content: [
            ...toolResults,
            { type: 'text', text: checkpoint } as ContentBlock,
          ],
        });
      } else {
        messages.push({ role: 'user', content: toolResults });
      }

      continue;
    }

    // Unexpected stop_reason — treat as end_turn
    const finalAnswer = extractFinalAnswer(resp);
    return {
      questionId: question.task_id,
      finalAnswer,
      turns,
      toolCallsByName,
      totalInputTokens,
      totalOutputTokens,
      wallMs: Date.now() - wallStart,
      replanCount,
    };
  }

  // Exhausted maxTurns
  return {
    questionId: question.task_id,
    finalAnswer: null,
    turns,
    toolCallsByName,
    totalInputTokens,
    totalOutputTokens,
    wallMs: Date.now() - wallStart,
    replanCount,
    timedOut: true,
  };
}

// ---------------------------------------------------------------------------
// Answer matching
// ---------------------------------------------------------------------------

/**
 * Check whether a model answer matches the expected ground-truth answer.
 *
 * Matching rules (mirrors GAIA evaluation):
 * - Normalise: trim whitespace, lowercase.
 * - Substring match: expected is contained in model answer (handles "Paris" vs "Paris, France").
 * - Direct equality after normalisation.
 * - Numeric: parse as floats and compare with ±1% tolerance.
 */
export function isAnswerCorrect(modelAnswer: string, expected: string): boolean {
  if (!modelAnswer) return false;

  const norm = (s: string) => s.trim().toLowerCase();
  const normModel = norm(modelAnswer);
  const normExpected = norm(expected);

  // Exact match
  if (normModel === normExpected) return true;

  // Substring match (expected contained in model answer or vice versa)
  if (normModel.includes(normExpected)) return true;
  if (normExpected.includes(normModel)) return true;

  // Numeric match with tolerance
  const numModel = parseFloat(normModel.replace(/[^0-9.\-]/g, ''));
  const numExpected = parseFloat(normExpected.replace(/[^0-9.\-]/g, ''));
  if (
    !Number.isNaN(numModel) &&
    !Number.isNaN(numExpected) &&
    numExpected !== 0 &&
    Math.abs((numModel - numExpected) / numExpected) < 0.01
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Smoke runner
// ---------------------------------------------------------------------------

/**
 * Run all 5 SMOKE_FIXTURE questions and report results to stdout.
 *
 * Pass criteria: ≥3/5 correct (60% pass rate).
 *
 * Cost estimate is printed at the end using Haiku pricing.
 *
 * This function is exported so tests can call it directly and capture output;
 * it also runs when this file is executed directly via `node gaia-agent.js --smoke`.
 */
export async function runSmokeTest(opts: {
  verbose?: boolean;
  apiKey?: string;
} = {}): Promise<{ passRate: number; passed: number; total: number }> {
  const { verbose = true, apiKey } = opts;

  if (verbose) {
    console.log('\n=== GAIA Smoke Test (ADR-133-PR3) ===');
    console.log(`Model: ${DEFAULT_MODEL}`);
    console.log(`Questions: ${SMOKE_FIXTURE.length}\n`);
  }

  let passed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const results: Array<{
    question: GaiaQuestion;
    result: GaiaAgentResult;
    correct: boolean;
  }> = [];

  for (const question of SMOKE_FIXTURE) {
    const result = await runGaiaAgent(question, {
      model: DEFAULT_MODEL,
      apiKey,
    });

    const correct =
      result.finalAnswer !== null && isAnswerCorrect(result.finalAnswer, question.final_answer);

    if (correct) passed++;
    totalInputTokens += result.totalInputTokens;
    totalOutputTokens += result.totalOutputTokens;
    results.push({ question, result, correct });

    if (verbose) {
      const status = correct ? 'PASS' : 'FAIL';
      console.log(`[${status}] ${question.task_id}: ${question.question.slice(0, 60)}`);
      console.log(
        `       Expected: "${question.final_answer}" | Got: "${result.finalAnswer ?? 'null'}"`,
      );
      console.log(
        `       Turns: ${result.turns} | Replans: ${result.replanCount} | Tools: ${JSON.stringify(result.toolCallsByName)} | Wall: ${result.wallMs}ms`,
      );
      if (result.error) console.log(`       Error: ${result.error}`);
      console.log();
    }
  }

  const passRate = passed / SMOKE_FIXTURE.length;
  const estimatedCostUsd =
    (totalInputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M +
    (totalOutputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;

  if (verbose) {
    console.log('=== Summary ===');
    console.log(`Pass rate:   ${passed}/${SMOKE_FIXTURE.length} (${(passRate * 100).toFixed(0)}%)`);
    console.log(`Threshold:   3/5 (60%)`);
    console.log(`Status:      ${passed >= 3 ? 'SMOKE PASSED' : 'SMOKE FAILED'}`);
    console.log(`Tokens in:   ${totalInputTokens.toLocaleString()}`);
    console.log(`Tokens out:  ${totalOutputTokens.toLocaleString()}`);
    console.log(`Est. cost:   $${estimatedCostUsd.toFixed(4)} (Haiku pricing)`);
    console.log(
      '\nTool-call breakdown (totals):',
      results.reduce(
        (acc, r) => {
          for (const [k, v] of Object.entries(r.result.toolCallsByName)) {
            acc[k] = (acc[k] ?? 0) + v;
          }
          return acc;
        },
        {} as Record<string, number>,
      ),
    );
    console.log();

    if (passed < 3) {
      console.warn(
        'WARNING: Smoke pass rate below threshold (3/5).  ' +
        'Common causes: web_search returning low-signal DDG results, ' +
        'ANTHROPIC_API_KEY unavailable, or per-turn timeout too tight.',
      );
    }
  }

  return { passRate, passed, total: SMOKE_FIXTURE.length };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

/**
 * Run when invoked as: node gaia-agent.js --smoke
 *
 * Exits with code 0 if ≥3/5 pass, 1 otherwise.
 */
if (process.argv.includes('--smoke')) {
  runSmokeTest({ verbose: true })
    .then(({ passed }) => {
      process.exit(passed >= 3 ? 0 : 1);
    })
    .catch((err) => {
      console.error('Smoke test crashed:', err);
      process.exit(2);
    });
}
