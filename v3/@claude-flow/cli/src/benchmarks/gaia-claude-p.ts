/**
 * GAIA Claude-p Wrapper — iter 54 (#2156)
 *
 * Delegates each GAIA question to `claude -p` (Claude Code headless mode),
 * which gives us WebSearch, WebFetch, Read (multimodal incl. PDF/DOCX/images),
 * and Bash (Python execution) for free — the same tools HAL uses.
 *
 * Why this approach over a native TS CodeAgent:
 *   - HAL gaps vs ruflo were: visit_webpage, file reading (PDF/DOCX/XLSX/images),
 *     Python execution.  Claude Code's built-in tools solve ALL of these.
 *   - No wheel-reinvention: battle-tested tool infra, native multimodal, proper
 *     tool-budget management, Anthropic WebSearch API.
 *   - Baseline: 24/53 (45.3%).  Target: ≥45/53 to surpass HAL's 82.07%.
 *
 * SECURITY NOTE on --dangerously-skip-permissions:
 *   This flag is ONLY used inside the GAIA harness context, which is a sandboxed
 *   benchmark evaluation environment.  GAIA questions have no real-world
 *   side effects — they are read-only research questions.  The flag lets Claude Code
 *   use its tools (WebSearch, WebFetch, Read, Bash) without per-tool permission
 *   prompts, which is required for unattended benchmark execution.  It MUST NOT
 *   be used in production workflows where Claude Code could affect real systems.
 *
 * JSON output format from `claude -p --output-format json`:
 *   {
 *     type: "result",
 *     subtype: "success" | "error_max_budget_usd" | ...,
 *     is_error: boolean,
 *     result: string,          // final assistant message text
 *     total_cost_usd: number,
 *     duration_ms: number,
 *     num_turns: number,
 *     ...
 *   }
 *
 * Refs: ADR-138 (reference, NOT implemented), iter 54, #2156
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { GaiaQuestion } from './gaia-loader.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default model for claude -p GAIA runs. Sonnet for quality parity with HAL. */
export const CLAUDE_P_DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Per-question budget cap (USD). HAL uses Sonnet 4.5 so $0.30 headroom is safe. */
export const CLAUDE_P_PER_QUESTION_BUDGET_USD = 0.30;

/** Subprocess timeout: 5 minutes per question. */
export const CLAUDE_P_TIMEOUT_MS = 5 * 60 * 1000;

/** FINAL_ANSWER extraction pattern — same as gaia-agent.ts. */
const FINAL_ANSWER_RE = /FINAL_ANSWER:\s*(.+?)(?:\n|$)/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudePResult {
  /** The extracted answer, or null if extraction failed. */
  finalAnswer: string | null;
  /** Raw result text from claude -p. */
  rawResult: string;
  /** Whether claude -p exited with an error. */
  isError: boolean;
  /** claude -p's reported error message (if any). */
  errorMessage?: string;
  /** Actual cost reported by claude -p. */
  costUsd: number;
  /** Wall-clock time in ms. */
  wallMs: number;
  /** Number of turns claude -p used. */
  numTurns: number;
  /** claude -p stop reason. */
  stopReason?: string;
}

export interface ClaudePOptions {
  /** Model ID (default: CLAUDE_P_DEFAULT_MODEL). */
  model?: string;
  /** Per-question budget cap in USD (default: CLAUDE_P_PER_QUESTION_BUDGET_USD). */
  budgetUsd?: number;
  /** Timeout in ms (default: CLAUDE_P_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Absolute path to the claude binary (default: resolved from $PATH). */
  claudeBin?: string;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the prompt sent to claude -p for a GAIA question.
 *
 * Includes the question text, optional attachment path, and precise instructions
 * for using available tools and producing FINAL_ANSWER: in the expected format.
 */
export function buildClaudePPrompt(question: GaiaQuestion): string {
  const attachmentBlock = question.file_path
    ? [
        '',
        `Attachment file path: ${path.resolve(question.file_path)}`,
        'You can use the Read tool to view this file directly.',
        'For images, audio, PDF, spreadsheets — use Read (it handles multimodal formats natively).',
      ].join('\n')
    : '';

  return [
    'You are answering a question from the GAIA benchmark.',
    '',
    `Question: ${question.question}`,
    attachmentBlock,
    '',
    'Instructions:',
    '1. Find the answer using your available tools:',
    '   - WebSearch: for current facts, people, events, statistics',
    '   - WebFetch: for full page content when a snippet is insufficient',
    '   - Read: for file attachments (PDF, DOCX, XLSX, images, audio transcripts)',
    '   - Bash: for computation, data processing, Python scripts',
    '2. Be precise. If a number is asked, give just the number.',
    '   If a name is asked, give just the name.',
    '3. Output your final answer on the last line as exactly:',
    '   FINAL_ANSWER: <your-answer>',
    '4. Do NOT use commas in numbers (write 50000 not 50,000) unless explicitly required.',
    '5. Do NOT include units (write "5" not "5 km") unless the question explicitly asks for them.',
    '6. If you genuinely cannot find the answer after exhausting your tools, write:',
    '   FINAL_ANSWER: unknown',
    '',
    'Find the answer and commit it with FINAL_ANSWER: on the last line.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run a single GAIA question via `claude -p` headless mode.
 *
 * Spawns a subprocess, captures JSON output, extracts the final answer.
 */
export async function runGaiaQuestionViaClaudeP(
  question: GaiaQuestion,
  options: ClaudePOptions = {},
): Promise<ClaudePResult> {
  const model = options.model ?? CLAUDE_P_DEFAULT_MODEL;
  const budgetUsd = options.budgetUsd ?? CLAUDE_P_PER_QUESTION_BUDGET_USD;
  const timeoutMs = options.timeoutMs ?? CLAUDE_P_TIMEOUT_MS;
  const claudeBin = options.claudeBin ?? '/Users/cohen/.local/bin/claude';

  const prompt = buildClaudePPrompt(question);

  // Build claude -p arguments.
  // --dangerously-skip-permissions: acceptable here because GAIA is a read-only
  // sandboxed benchmark context with no real-world side effects.  See module-level
  // security note above.
  const args: string[] = [
    '-p',
    prompt,
    '--model', model,
    '--max-budget-usd', String(budgetUsd),
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];

  const startMs = Date.now();

  return new Promise<ClaudePResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(claudeBin, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolve({
          finalAnswer: null,
          rawResult: '',
          isError: true,
          errorMessage: `Timed out after ${timeoutMs}ms`,
          costUsd: 0,
          wallMs: Date.now() - startMs,
          numTurns: 0,
          stopReason: 'timeout',
        });
      }
    }, timeoutMs);

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const wallMs = Date.now() - startMs;

      // Parse JSON output from claude -p
      const parsed = parseClaudePOutput(stdout, stderr, code ?? 1);

      resolve({ ...parsed, wallMs });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        finalAnswer: null,
        rawResult: '',
        isError: true,
        errorMessage: `Failed to spawn claude: ${err.message}`,
        costUsd: 0,
        wallMs: Date.now() - startMs,
        numTurns: 0,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// JSON output parser
// ---------------------------------------------------------------------------

interface ClaudePJsonOutput {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  stop_reason?: string;
  errors?: string[];
}

function parseClaudePOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
): Omit<ClaudePResult, 'wallMs'> {
  const raw = stdout.trim();

  // Attempt JSON parse
  let parsed: ClaudePJsonOutput | null = null;
  try {
    parsed = JSON.parse(raw) as ClaudePJsonOutput;
  } catch {
    // JSON parse failed — treat as error
    return {
      finalAnswer: null,
      rawResult: raw || stderr.trim(),
      isError: true,
      errorMessage: `JSON parse failed (exitCode=${exitCode}): ${(raw || stderr).slice(0, 200)}`,
      costUsd: 0,
      numTurns: 0,
    };
  }

  const isError = parsed.is_error === true || exitCode !== 0;
  const resultText = parsed.result ?? '';
  const costUsd = parsed.total_cost_usd ?? 0;
  const numTurns = parsed.num_turns ?? 0;
  const stopReason = parsed.subtype ?? parsed.stop_reason ?? undefined;

  if (isError) {
    const errMsg = (parsed.errors ?? []).join('; ') || `subtype=${parsed.subtype}`;
    return {
      finalAnswer: null,
      rawResult: resultText,
      isError: true,
      errorMessage: errMsg,
      costUsd,
      numTurns,
      stopReason,
    };
  }

  // Extract FINAL_ANSWER from result text
  const finalAnswer = extractFinalAnswer(resultText);

  return {
    finalAnswer,
    rawResult: resultText,
    isError: false,
    costUsd,
    numTurns,
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// Answer extraction
// ---------------------------------------------------------------------------

/**
 * Extract the FINAL_ANSWER value from claude -p's result text.
 *
 * Primary: regex match on `FINAL_ANSWER: <value>`
 * Fallback: last non-empty line if no FINAL_ANSWER marker found.
 */
export function extractFinalAnswer(text: string): string | null {
  if (!text || !text.trim()) return null;

  // Primary: FINAL_ANSWER: pattern
  const match = FINAL_ANSWER_RE.exec(text);
  if (match && match[1]) {
    return match[1].trim();
  }

  // Fallback: last meaningful line (heuristic)
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine && lastLine.length < 200) {
    return lastLine;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Batch runner (used by gaia-bench.ts --mode=claude-p)
// ---------------------------------------------------------------------------

export interface ClaudePBatchOptions extends ClaudePOptions {
  /** Max parallel questions (default: 2 — claude -p uses significant local resources). */
  concurrency?: number;
  /** Callback for per-question progress logging. */
  onProgress?: (idx: number, total: number, questionId: string, answer: string | null, costUsd: number) => void;
}

/**
 * Run a batch of GAIA questions through the claude -p wrapper.
 *
 * Concurrency is limited (default 2) because each claude -p subprocess
 * is heavyweight — it starts a full Claude Code session with LSP etc.
 */
export async function runGaiaQuestionsBatchViaClaudeP(
  questions: GaiaQuestion[],
  options: ClaudePBatchOptions = {},
): Promise<ClaudePResult[]> {
  const concurrency = options.concurrency ?? 2;
  const results: ClaudePResult[] = new Array(questions.length);

  for (let i = 0; i < questions.length; i += concurrency) {
    const batch = questions.slice(i, Math.min(i + concurrency, questions.length));
    const batchResults = await Promise.all(
      batch.map((q, batchIdx) =>
        runGaiaQuestionViaClaudeP(q, options).then((r) => {
          const globalIdx = i + batchIdx;
          options.onProgress?.(globalIdx + 1, questions.length, q.task_id, r.finalAnswer, r.costUsd);
          return r;
        }),
      ),
    );
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
  }

  return results;
}
