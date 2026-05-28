/**
 * GAIA DAG Harness — Co-Sight Architecture Port (ADR-139 Addendum)
 *
 * Ports the ZTE-AICloud/Co-Sight DAG orchestration pattern (Apache 2.0,
 * arXiv 2510.21557) into the ruflo GAIA harness.
 *
 * Architecture:
 *   1. PLAN  — Claude Sonnet 4.6 reads the question and emits a DAG of 3-7
 *              steps: {id, description, depends_on: [], suggested_tool}.
 *              Claude-aware prompt: "3-5 steps max, direct answer when clear."
 *   2. EXECUTE — Loop while ready steps exist (deps satisfied).
 *              Run all ready steps in PARALLEL (Promise.all, cap ≤5).
 *              Each step = a Gemini 2.5 Pro actor with the full tool suite.
 *              Actor marks step completed/blocked + writes step_notes.
 *              Blocked steps trigger planner re_plan before next cycle.
 *   3. FINALIZE — Planner reads all step_notes → produces final answer
 *              using T2 extraction cascade from gaia-agent.ts.
 *   4. CAMV   — Async credibility labeling per step (stubbed, iter 65).
 *
 * Role assignment (env-configurable):
 *   PLAN_MODEL  = claude-sonnet-4-6  (default)
 *   ACT_MODEL   = gemini-2.5-pro     (default)
 *   VISION_MODEL = gemini-2.5-pro    (default, same as act)
 *
 * CLI:
 *   gaia-bench run --mode=dag --model claude-sonnet-4-6
 *
 * Cost: planner ~$0.02/Q + actors ~$0.03/Q = ~$0.05/Q (vs single-Sonnet ~$0.075)
 *
 * Refs: ADR-139, github.com/ZTE-AICloud/Co-Sight, arXiv 2510.21557, #2156
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GaiaQuestion } from './gaia-loader.js';
import {
  createDefaultToolCatalogue,
  GaiaToolCatalogue,
  ToolDefinition,
  ToolUseBlock,
  TextBlock,
  ContentBlock,
} from './gaia-tools/index.js';
import { normaliseAnswer } from './gaia-judge.js';
import { resolveAnthropicApiKey } from './gaia-agent.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_PLAN_MODEL = process.env['PLAN_MODEL'] ?? 'claude-sonnet-4-6';
const DEFAULT_ACT_MODEL = process.env['ACT_MODEL'] ?? 'gemini-2.5-pro';

const MAX_PLAN_STEPS = 7;
const MIN_PLAN_STEPS = 1;
const MAX_CONCURRENT_ACTORS = 5;
const MAX_ACTOR_TURNS = 8;
const MAX_REPLAN_CYCLES = 3;
const ACTOR_TIMEOUT_MS = 90_000;
const PLANNER_TIMEOUT_MS = 60_000;

const FINAL_ANSWER_RE = /FINAL_ANSWER:\s*(.+)/i;

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

function resolveGeminiApiKey(supplied?: string): string {
  if (supplied?.trim()) return supplied.trim();
  const env = process.env['GOOGLE_AI_API_KEY'] ?? process.env['GEMINI_API_KEY'];
  if (env?.trim()) return env.trim();
  for (const secret of ['GOOGLE_AI_API_KEY', 'GEMINI_API_KEY']) {
    try {
      const out = execSync(
        `gcloud secrets versions access latest --secret=${secret} 2>/dev/null`,
        { encoding: 'utf-8', timeout: 10_000 },
      ).trim();
      if (out) return out;
    } catch { /* fall through */ }
  }
  throw new Error('GOOGLE_AI_API_KEY / GEMINI_API_KEY not found in env or GCP Secret Manager.');
}

// ---------------------------------------------------------------------------
// Plan DAG types (ported from Co-Sight todolist.py)
// ---------------------------------------------------------------------------

export interface DagStep {
  id: number;
  description: string;
  depends_on: number[];
  suggested_tool?: string;
  status: 'not_started' | 'in_progress' | 'completed' | 'blocked';
  step_notes: string;
}

export interface DagPlan {
  title: string;
  question: string;
  steps: DagStep[];
}

/**
 * Get all steps whose dependencies are fully satisfied (completed).
 * Mirrors Co-Sight's Plan.get_ready_steps().
 */
export function getReadySteps(plan: DagPlan): DagStep[] {
  return plan.steps.filter((step) => {
    if (step.status !== 'not_started') return false;
    return step.depends_on.every((depId) => {
      const dep = plan.steps.find((s) => s.id === depId);
      return dep?.status === 'completed';
    });
  });
}

// ---------------------------------------------------------------------------
// Planner system prompt (Claude-aware, ported from planner_prompt.py)
// ---------------------------------------------------------------------------

function buildPlannerSystemPrompt(): string {
  return [
    '# Role and Objective',
    'You are a planning assistant for a question-answering system. Your task is to create',
    'a small, focused plan as a Directed Acyclic Graph (DAG) to answer the given question.',
    '',
    '# Plan Creation Rules (Claude model — simplified)',
    '1. When the answer is clear and direct, create a SINGLE step: just answer the question.',
    '2. Otherwise, create 3-5 high-level steps (NEVER more than 7).',
    '3. Each step must be a concrete, actionable description.',
    '4. Specify dependencies ONLY when a step genuinely requires output from a prior step.',
    '5. Steps without dependencies run in parallel — prefer parallelism.',
    '',
    '# Output Format (JSON ONLY, no markdown fences)',
    '{',
    '  "title": "brief plan title",',
    '  "steps": [',
    '    { "id": 0, "description": "step description", "depends_on": [], "suggested_tool": "web_search" },',
    '    { "id": 1, "description": "step description", "depends_on": [0], "suggested_tool": "python_exec" }',
    '  ]',
    '}',
    '',
    '# Suggested Tools: web_search, grounded_query, file_read, python_exec',
    '# Rules:',
    '- ids must be sequential integers starting from 0',
    '- depends_on contains only valid step ids from the same plan',
    '- NO markdown, NO explanation — output ONLY the JSON object',
  ].join('\n');
}

function buildReplannerSystemPrompt(): string {
  return [
    '# Role and Objective',
    'You are a planning assistant. Some steps in the current plan are BLOCKED.',
    'Your task is to update the plan to work around the blocked steps.',
    '',
    '# Replan Rules',
    '1. Preserve ALL completed steps — do not modify them.',
    '2. For blocked steps: either try an alternative approach or skip if non-critical.',
    '3. If the plan has enough information to answer already, output FINAL_ANSWER: <answer>',
    '4. Keep the total step count ≤ 7.',
    '',
    '# Output',
    'Either:',
    '  FINAL_ANSWER: <the answer>',
    'Or updated JSON plan (same format as plan creation, include all steps with their current status):',
    '{',
    '  "title": "...",',
    '  "steps": [...]',
    '}',
  ].join('\n');
}

function buildFinalizerSystemPrompt(): string {
  return [
    'You are a precise question-answering agent finalizing a multi-step research task.',
    'You have all the gathered evidence in step notes. Produce the final answer.',
    '',
    'RULES:',
    '1. Synthesize ONLY from the provided step notes — do not invent facts.',
    '2. Keep answers concise: just the value, name, or number unless context demands more.',
    '3. Do NOT include units unless the question asks for them.',
    '4. You MUST end with: FINAL_ANSWER: <your answer>',
    '5. NEVER end without a FINAL_ANSWER line.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Anthropic API call (planner / finalizer)
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface AnthropicResponse {
  stop_reason: string;
  content: ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
}

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: AnthropicMessage[],
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
      body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages }),
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
// Gemini API call (actor)
// ---------------------------------------------------------------------------

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

interface GeminiTool {
  name: string;
  description: string;
  parameters?: object;
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text?: string; functionCall?: { name: string; args: object } }> };
    finishReason: string;
  }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

async function callGemini(
  apiKey: string,
  model: string,
  systemInstruction: string,
  contents: GeminiContent[],
  tools: GeminiTool[],
  maxTokens: number,
  timeoutMs: number,
): Promise<GeminiResponse> {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents,
        tools: tools.length > 0 ? [{ function_declarations: tools }] : undefined,
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '<unreadable>');
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 400)}`);
  }
  return (await res.json()) as GeminiResponse;
}

// ---------------------------------------------------------------------------
// Parse planner JSON output (robust)
// ---------------------------------------------------------------------------

function parsePlanJson(text: string): { steps: Array<{ id: number; description: string; depends_on: number[]; suggested_tool?: string }> } | null {
  // Strip markdown fences if present
  const cleaned = text.replace(/```(?:json)?\n?/g, '').replace(/```\n?/g, '').trim();
  // Find the first '{' ... last '}'
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      title?: string;
      steps?: Array<{ id?: number; description?: string; depends_on?: number[]; suggested_tool?: string }>;
    };
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
    return {
      steps: parsed.steps.map((s, i) => ({
        id: typeof s.id === 'number' ? s.id : i,
        description: String(s.description ?? `Step ${i}`),
        depends_on: Array.isArray(s.depends_on) ? s.depends_on.map(Number) : [],
        suggested_tool: s.suggested_tool,
      })),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PLAN phase
// ---------------------------------------------------------------------------

async function createPlan(
  question: GaiaQuestion,
  anthropicKey: string,
  planModel: string,
): Promise<{ plan: DagPlan; inputTokens: number; outputTokens: number }> {
  const attachmentHint = question.file_path
    ? `\nThis question has an attached file at: ${question.file_path}`
    : '';

  const resp = await callAnthropic(
    anthropicKey,
    planModel,
    buildPlannerSystemPrompt(),
    [{ role: 'user', content: question.question + attachmentHint }],
    1024,
    PLANNER_TIMEOUT_MS,
  );

  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as TextBlock).text)
    .join('\n');

  const parsed = parsePlanJson(text);

  let steps: DagStep[];
  if (parsed && parsed.steps.length >= MIN_PLAN_STEPS) {
    // Cap steps
    const rawSteps = parsed.steps.slice(0, MAX_PLAN_STEPS);
    steps = rawSteps.map((s) => ({
      id: s.id,
      description: s.description,
      depends_on: s.depends_on.filter((d) => d < rawSteps.length && d !== s.id),
      suggested_tool: s.suggested_tool,
      status: 'not_started' as const,
      step_notes: '',
    }));
  } else {
    // Fallback: single-step plan (treat as direct answer task)
    steps = [{
      id: 0,
      description: `Answer the question directly: ${question.question.slice(0, 100)}`,
      depends_on: [],
      status: 'not_started' as const,
      step_notes: '',
    }];
  }

  return {
    plan: { title: question.task_id, question: question.question, steps },
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
  };
}

// ---------------------------------------------------------------------------
// ACTOR phase — Gemini 2.5 Pro executes a single step
// ---------------------------------------------------------------------------

function buildActorSystemPrompt(question: string, planSummary: string, stepDesc: string): string {
  return [
    'You are a precise research agent executing one step of a multi-step plan.',
    '',
    `ORIGINAL QUESTION: ${question}`,
    '',
    `CURRENT PLAN STATE:\n${planSummary}`,
    '',
    `YOUR STEP: ${stepDesc}`,
    '',
    'RULES:',
    '1. Use the available tools to gather information for your step.',
    '2. When you have completed your step, output your findings as:',
    '   STEP_RESULT: <your findings and evidence>',
    '3. If you cannot complete your step (blocked), output:',
    '   STEP_BLOCKED: <reason why blocked>',
    '4. Keep responses focused on completing this specific step.',
    '5. MANDATORY: Always end with either STEP_RESULT or STEP_BLOCKED.',
  ].join('\n');
}

function buildPlanSummary(plan: DagPlan): string {
  return plan.steps.map((s) => {
    const statusIcon = { not_started: '[ ]', in_progress: '[→]', completed: '[✓]', blocked: '[!]' }[s.status];
    const notes = s.step_notes ? ` → ${s.step_notes.slice(0, 200)}` : '';
    return `${statusIcon} Step ${s.id}: ${s.description}${notes}`;
  }).join('\n');
}

/** Convert ruflo tool catalogue to Gemini function declarations. */
function toGeminiFunctionDeclarations(catalogue: GaiaToolCatalogue): GeminiTool[] {
  return catalogue.map((t) => ({
    name: t.definition.name,
    description: t.definition.description,
    parameters: (t.definition as ToolDefinition & { input_schema?: object }).input_schema,
  }));
}

async function executeActorStep(
  question: GaiaQuestion,
  step: DagStep,
  plan: DagPlan,
  geminiKey: string,
  actModel: string,
  catalogue: GaiaToolCatalogue,
): Promise<{ notes: string; status: 'completed' | 'blocked'; inputTokens: number; outputTokens: number }> {
  const systemPrompt = buildActorSystemPrompt(question.question, buildPlanSummary(plan), step.description);
  const tools = toGeminiFunctionDeclarations(catalogue);

  let inputTokens = 0;
  let outputTokens = 0;
  const contents: GeminiContent[] = [
    { role: 'user', parts: [{ text: `Execute your assigned step. Use tools as needed, then output STEP_RESULT or STEP_BLOCKED.` }] },
  ];

  // Include attachment hint on first user message
  if (question.file_path) {
    contents[0].parts[0].text +=
      `\nNote: There is an attached file at "${question.file_path}" — call file_read if needed.`;
  }

  const STEP_RESULT_RE = /STEP_RESULT:\s*([\s\S]+)/i;
  const STEP_BLOCKED_RE = /STEP_BLOCKED:\s*(.+)/i;

  for (let turn = 0; turn < MAX_ACTOR_TURNS; turn++) {
    let resp: GeminiResponse;
    try {
      resp = await callGemini(geminiKey, actModel, systemPrompt, contents, tools, 2048, ACTOR_TIMEOUT_MS);
    } catch (err) {
      return {
        notes: `Actor error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'blocked',
        inputTokens,
        outputTokens,
      };
    }

    inputTokens += resp.usageMetadata?.promptTokenCount ?? 0;
    outputTokens += resp.usageMetadata?.candidatesTokenCount ?? 0;

    const candidate = resp.candidates[0];
    if (!candidate) break;

    const parts = candidate.content?.parts ?? [];
    const textParts = parts.filter((p) => p.text).map((p) => p.text!);
    const funcCalls = parts.filter((p) => p.functionCall);

    // Check for terminal signals in text
    const fullText = textParts.join('\n');
    const resultMatch = STEP_RESULT_RE.exec(fullText);
    if (resultMatch) {
      return { notes: resultMatch[1].trim().slice(0, 2000), status: 'completed', inputTokens, outputTokens };
    }
    const blockedMatch = STEP_BLOCKED_RE.exec(fullText);
    if (blockedMatch) {
      return { notes: blockedMatch[1].trim(), status: 'blocked', inputTokens, outputTokens };
    }

    // No function calls and finish — treat text as the result
    if (funcCalls.length === 0) {
      const answerText = fullText.trim();
      if (answerText) {
        return { notes: answerText.slice(0, 2000), status: 'completed', inputTokens, outputTokens };
      }
      break;
    }

    // Execute tool calls
    const toolResultParts: Array<{ functionResponse: { name: string; response: { content: string } } }> = [];
    // Append model turn
    contents.push({ role: 'model', parts: parts as Array<{ text: string }> });

    await Promise.all(funcCalls.map(async (part) => {
      const fc = part.functionCall!;
      const tool = catalogue.find((t) => t.name === fc.name);
      let result: string;
      if (!tool) {
        result = `Unknown tool: "${fc.name}"`;
      } else {
        try {
          result = await tool.execute(fc.args as Record<string, unknown>);
        } catch (err) {
          result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      // Truncate large outputs (mirrors Co-Sight MAX_TOOL_CONTENT_LENGTH)
      toolResultParts.push({
        functionResponse: { name: fc.name, response: { content: result.slice(0, 10_000) } },
      });
    }));

    contents.push({ role: 'user', parts: toolResultParts as unknown as Array<{ text: string }> });
  }

  return { notes: 'No result after max turns', status: 'blocked', inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// REPLAN phase
// ---------------------------------------------------------------------------

async function replan(
  question: GaiaQuestion,
  plan: DagPlan,
  anthropicKey: string,
  planModel: string,
): Promise<{ earlyAnswer: string | null; updatedSteps: DagStep[] | null; inputTokens: number; outputTokens: number }> {
  const planSummary = buildPlanSummary(plan);
  const prompt = [
    `QUESTION: ${question.question}`,
    '',
    `CURRENT PLAN:\n${planSummary}`,
    '',
    'Some steps are BLOCKED. Update the plan or provide the final answer if enough info is gathered.',
  ].join('\n');

  const resp = await callAnthropic(
    anthropicKey,
    planModel,
    buildReplannerSystemPrompt(),
    [{ role: 'user', content: prompt }],
    1024,
    PLANNER_TIMEOUT_MS,
  );

  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as TextBlock).text)
    .join('\n');

  // Check for early final answer
  const faMatch = FINAL_ANSWER_RE.exec(text);
  if (faMatch) {
    return { earlyAnswer: faMatch[1].trim(), updatedSteps: null, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens };
  }

  // Try to parse updated plan
  const parsed = parsePlanJson(text);
  if (parsed) {
    const updatedSteps: DagStep[] = parsed.steps.slice(0, MAX_PLAN_STEPS).map((s) => {
      // Preserve completed/blocked status for existing steps
      const existing = plan.steps.find((es) => es.id === s.id);
      if (existing && existing.status !== 'not_started') {
        return existing;
      }
      return {
        id: s.id,
        description: s.description,
        depends_on: s.depends_on.filter((d) => d < parsed.steps.length && d !== s.id),
        suggested_tool: s.suggested_tool,
        status: 'not_started' as const,
        step_notes: '',
      };
    });
    return { earlyAnswer: null, updatedSteps, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens };
  }

  return { earlyAnswer: null, updatedSteps: null, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens };
}

// ---------------------------------------------------------------------------
// FINALIZE phase
// ---------------------------------------------------------------------------

async function finalizePlan(
  question: GaiaQuestion,
  plan: DagPlan,
  anthropicKey: string,
  planModel: string,
): Promise<{ finalAnswer: string | null; inputTokens: number; outputTokens: number }> {
  const stepNotes = plan.steps
    .filter((s) => s.step_notes)
    .map((s) => `Step ${s.id} (${s.status}): ${s.description}\nFindings: ${s.step_notes}`)
    .join('\n\n');

  const prompt = [
    `QUESTION: ${question.question}`,
    '',
    stepNotes ? `GATHERED EVIDENCE:\n${stepNotes}` : '(No step findings were gathered.)',
    '',
    'Based on the evidence above, provide the final answer.',
    'End with: FINAL_ANSWER: <your answer>',
  ].join('\n');

  const resp = await callAnthropic(
    anthropicKey,
    planModel,
    buildFinalizerSystemPrompt(),
    [{ role: 'user', content: prompt }],
    1024,
    PLANNER_TIMEOUT_MS,
  );

  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as TextBlock).text)
    .join('\n');

  const match = FINAL_ANSWER_RE.exec(text);
  return {
    finalAnswer: match ? match[1].trim() : null,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DagResult {
  questionId: string;
  finalAnswer: string | null;
  normalisedAnswer: string;
  plan: DagPlan;
  totalSteps: number;
  completedSteps: number;
  blockedSteps: number;
  plannerCycles: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  wallMs: number;
  timedOut?: boolean;
  error?: string;
}

export interface DagOptions {
  planModel?: string;
  actModel?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  catalogue?: GaiaToolCatalogue;
  /** Disable CAMV stub (default: false — stub is always disabled in this iter). */
  enableCamv?: boolean;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function estimateCostUsd(
  planModel: string,
  actModel: string,
  planIn: number, planOut: number,
  actIn: number, actOut: number,
): number {
  const planPrice = planModel.startsWith('claude-sonnet')
    ? { inputPerM: 3.0, outputPerM: 15.0 }
    : { inputPerM: 3.0, outputPerM: 15.0 };
  const actPrice = actModel.startsWith('gemini-2.5-pro')
    ? { inputPerM: 1.25, outputPerM: 10.0 }
    : { inputPerM: 1.25, outputPerM: 10.0 };

  return (planIn / 1_000_000) * planPrice.inputPerM +
    (planOut / 1_000_000) * planPrice.outputPerM +
    (actIn / 1_000_000) * actPrice.inputPerM +
    (actOut / 1_000_000) * actPrice.outputPerM;
}

// ---------------------------------------------------------------------------
// Main entry point: runGaiaDAG
// ---------------------------------------------------------------------------

/**
 * Run a GAIA question through the Co-Sight DAG harness.
 *
 * Steps:
 *   1. Planner (Claude Sonnet) creates a DAG plan.
 *   2. Execute loop: parallel actors (Gemini 2.5 Pro) run ready steps.
 *   3. Blocked steps trigger replan (up to MAX_REPLAN_CYCLES).
 *   4. Finalizer (Claude Sonnet) reads all step notes → final answer.
 */
export async function runGaiaDAG(
  question: GaiaQuestion,
  options: DagOptions = {},
): Promise<DagResult> {
  const wallStart = Date.now();

  const planModel = options.planModel ?? DEFAULT_PLAN_MODEL;
  const actModel = options.actModel ?? DEFAULT_ACT_MODEL;
  const anthropicKey = resolveAnthropicApiKey(options.anthropicApiKey);
  const geminiKey = resolveGeminiApiKey(options.geminiApiKey);
  const catalogue = options.catalogue ?? createDefaultToolCatalogue();

  let plannerInputTokens = 0;
  let plannerOutputTokens = 0;
  let actorInputTokens = 0;
  let actorOutputTokens = 0;

  // PHASE 1: PLAN
  process.stderr.write(`[dag] ${question.task_id} — planning with ${planModel}\n`);
  let planResult: { plan: DagPlan; inputTokens: number; outputTokens: number };
  try {
    planResult = await createPlan(question, anthropicKey, planModel);
  } catch (err) {
    return {
      questionId: question.task_id,
      finalAnswer: null,
      normalisedAnswer: '',
      plan: { title: question.task_id, question: question.question, steps: [] },
      totalSteps: 0,
      completedSteps: 0,
      blockedSteps: 0,
      plannerCycles: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
      wallMs: Date.now() - wallStart,
      error: `Plan creation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const plan = planResult.plan;
  plannerInputTokens += planResult.inputTokens;
  plannerOutputTokens += planResult.outputTokens;

  process.stderr.write(
    `[dag] ${question.task_id} — plan: ${plan.steps.length} steps\n` +
    plan.steps.map((s) => `  [${s.id}] ${s.description} (deps: [${s.depends_on.join(',')}])`).join('\n') + '\n',
  );

  // PHASE 2: EXECUTE + REPLAN loop
  let plannerCycles = 1; // count initial plan creation
  let earlyAnswer: string | null = null;

  for (let cycle = 0; cycle < MAX_REPLAN_CYCLES + 1; cycle++) {
    const readySteps = getReadySteps(plan);
    if (readySteps.length === 0) break;

    process.stderr.write(`[dag] ${question.task_id} — cycle ${cycle}: ${readySteps.length} ready steps\n`);

    // Mark ready steps as in_progress
    for (const step of readySteps) step.status = 'in_progress';

    // Run all ready steps in parallel (cap at MAX_CONCURRENT_ACTORS)
    const batches: DagStep[][] = [];
    for (let i = 0; i < readySteps.length; i += MAX_CONCURRENT_ACTORS) {
      batches.push(readySteps.slice(i, i + MAX_CONCURRENT_ACTORS));
    }

    for (const batch of batches) {
      const results = await Promise.all(
        batch.map((step) => executeActorStep(question, step, plan, geminiKey, actModel, catalogue)),
      );
      for (let i = 0; i < batch.length; i++) {
        const step = batch[i];
        const res = results[i];
        step.step_notes = res.notes;
        step.status = res.status;
        actorInputTokens += res.inputTokens;
        actorOutputTokens += res.outputTokens;
        process.stderr.write(`[dag] ${question.task_id} — step ${step.id} → ${step.status}\n`);
      }
    }

    // Check for blocked steps
    const blockedSteps = plan.steps.filter((s) => s.status === 'blocked');
    if (blockedSteps.length === 0) continue;

    // If any steps remain not_started or there are more cycles, try replan
    const remainingSteps = plan.steps.filter((s) => s.status === 'not_started');
    if (remainingSteps.length === 0 || cycle >= MAX_REPLAN_CYCLES) break;

    process.stderr.write(`[dag] ${question.task_id} — ${blockedSteps.length} blocked, replanning\n`);
    plannerCycles++;

    try {
      const replanResult = await replan(question, plan, anthropicKey, planModel);
      plannerInputTokens += replanResult.inputTokens;
      plannerOutputTokens += replanResult.outputTokens;

      if (replanResult.earlyAnswer) {
        earlyAnswer = replanResult.earlyAnswer;
        break;
      }
      if (replanResult.updatedSteps) {
        plan.steps = replanResult.updatedSteps;
      }
    } catch (err) {
      process.stderr.write(`[dag] replan error: ${err instanceof Error ? err.message : String(err)}\n`);
      break;
    }
  }

  // PHASE 3: FINALIZE
  let finalAnswer: string | null = earlyAnswer;

  if (!finalAnswer) {
    process.stderr.write(`[dag] ${question.task_id} — finalizing\n`);
    try {
      const fin = await finalizePlan(question, plan, anthropicKey, planModel);
      plannerInputTokens += fin.inputTokens;
      plannerOutputTokens += fin.outputTokens;
      finalAnswer = fin.finalAnswer;
    } catch (err) {
      process.stderr.write(`[dag] finalize error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const completedSteps = plan.steps.filter((s) => s.status === 'completed').length;
  const blockedSteps = plan.steps.filter((s) => s.status === 'blocked').length;

  return {
    questionId: question.task_id,
    finalAnswer,
    normalisedAnswer: normaliseAnswer(finalAnswer),
    plan,
    totalSteps: plan.steps.length,
    completedSteps,
    blockedSteps,
    plannerCycles,
    totalInputTokens: plannerInputTokens + actorInputTokens,
    totalOutputTokens: plannerOutputTokens + actorOutputTokens,
    estimatedCostUsd: estimateCostUsd(planModel, actModel, plannerInputTokens, plannerOutputTokens, actorInputTokens, actorOutputTokens),
    wallMs: Date.now() - wallStart,
  };
}

// ---------------------------------------------------------------------------
// 5-Question pilot runner
// ---------------------------------------------------------------------------

export interface DagPilotResult {
  correct: number;
  total: number;
  accuracy: number;
  avgStepsPerQuestion: number;
  perQuestion: Array<{
    taskId: string;
    question: string;
    expected: string;
    got: string | null;
    correct: boolean;
    steps: number;
    completedSteps: number;
    blockedSteps: number;
    plannerCycles: number;
    costUsd: number;
    wallMs: number;
  }>;
  totalCostUsd: number;
  projectedCost53Q: number;
  meanWallMs: number;
}

export async function runDagPilot(
  questions: GaiaQuestion[],
  options: DagOptions = {},
): Promise<DagPilotResult> {
  const perQuestion: DagPilotResult['perQuestion'] = [];
  let correct = 0;

  for (const q of questions) {
    const result = await runGaiaDAG(q, options);
    const isCorrect = result.normalisedAnswer !== '' && result.normalisedAnswer === normaliseAnswer(q.final_answer);
    if (isCorrect) correct++;

    perQuestion.push({
      taskId: q.task_id,
      question: q.question.slice(0, 80),
      expected: q.final_answer ?? '',
      got: result.finalAnswer,
      correct: isCorrect,
      steps: result.totalSteps,
      completedSteps: result.completedSteps,
      blockedSteps: result.blockedSteps,
      plannerCycles: result.plannerCycles,
      costUsd: result.estimatedCostUsd,
      wallMs: result.wallMs,
    });

    process.stderr.write(
      `[dag-pilot] ${q.task_id} → ${result.finalAnswer ?? 'null'} ` +
      `(${isCorrect ? 'CORRECT' : 'WRONG'}, steps=${result.totalSteps}, ` +
      `completed=${result.completedSteps}, $${result.estimatedCostUsd.toFixed(4)})\n`,
    );
  }

  const totalCostUsd = perQuestion.reduce((s, r) => s + r.costUsd, 0);
  const avgCostPerQ = totalCostUsd / Math.max(perQuestion.length, 1);
  const meanWallMs = perQuestion.reduce((s, r) => s + r.wallMs, 0) / Math.max(perQuestion.length, 1);
  const avgSteps = perQuestion.reduce((s, r) => s + r.steps, 0) / Math.max(perQuestion.length, 1);

  return {
    correct,
    total: perQuestion.length,
    accuracy: correct / Math.max(perQuestion.length, 1),
    avgStepsPerQuestion: avgSteps,
    perQuestion,
    totalCostUsd,
    projectedCost53Q: avgCostPerQ * 53,
    meanWallMs,
  };
}
