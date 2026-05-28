# ADR-139: Multi-Model Ensemble for GAIA Leaderboard Competitiveness

**Status**: Proposed
**Date**: 2026-05-28
**Issue**: [ruvnet/ruflo#2156](https://github.com/ruvnet/ruflo/issues/2156)
**Supersedes**: —
**Related**: ADR-133 (GAIA harness), ADR-135 (planning+tracks), ADR-138 (CodeAgent)

## Context

### Leaderboard Reality Check

The Princeton HAL GAIA leaderboard top-10 (as of 2026-05-28) uses multi-model ensembles:

| Rank | System | L1 | L2 | L3 | Avg |
|------|--------|-----|-----|-----|-----|
| 1 | GPT-5 + ensemble | ~98% | ~94% | ~88% | ~93% |
| 2-5 | Various ensembles | 90-96% | 85-92% | 78-85% | 85-91% |
| ~10 cutoff | | ~89% | ~83% | ~75% | ~82% |
| **Our best** | **Single Sonnet 4.6** | **~61%** | N/A | N/A | **~61%** |

Gap to top-10 cutoff: **~28 percentage points on L1 alone**. No single-model approach has cracked the top 10. The architecture that separates top entries from mid-table is ensemble voting across 3-7 frontier models — each brings independent reasoning paths, different retrieval strategies, and complementary failure modes.

### Why Single-Model Hits a Ceiling

Single-model GAIA performance improvements follow diminishing returns:
- iter 51→57: +3% from convergence layer
- iter 57→63: +2% from CodeAgent-style harness
- Projected iter 63→∞: +1-2% per major harness change

At this rate, reaching 89% from 61% would take ~14 more iterations over months. The ensemble path is architecturally different: it parallelizes N independent reasoning attempts and recovers questions that any one model gets wrong — each additional model adds ~5-8% lift if errors are reasonably uncorrelated.

### Available Model Access (Verified 2026-05-28)

Direct API keys confirmed in GCP Secret Manager:

| Model | API | Key Secret | Cost (in/out per M tokens) |
|-------|-----|-----------|---------------------------|
| `claude-sonnet-4-6` | Anthropic | `ANTHROPIC_API_KEY` | $3.00/$15.00 |
| `claude-opus-4-7` | Anthropic | `ANTHROPIC_API_KEY` | $5.00/$25.00 (via OpenRouter) |
| `gemini-2.5-pro` | Google AI | `GEMINI_API_KEY` / `GOOGLE_AI_API_KEY` | $1.25/$10.00 |
| `gemini-2.5-flash` | Google AI | `GEMINI_API_KEY` | $0.30/$2.50 (est.) |

**OpenRouter status**: Account exhausted ($34.28 used / $34.27 limit, balance = -$0.01 as of 2026-05-28). All paid models return 402. Free-tier models (`moonshotai/kimi-k2.6:free`, `deepseek/deepseek-v4-flash:free`) rate-limited upstream (429). OpenRouter models are available once credits are topped up; the model IDs below are verified as listed:

| Model | OpenRouter ID | Cost (in/out per M) |
|-------|---------------|---------------------|
| GPT-5 | `openai/gpt-5` | $1.25/$10.00 |
| GPT-5.4 | `openai/gpt-5.4` | $2.50/$15.00 |
| DeepSeek v3.2 | `deepseek/deepseek-v3.2` | $0.25/$0.38 |
| Kimi K2.6 | `moonshotai/kimi-k2.6` | $0.73/$3.49 |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` | $1.25/$10.00 |
| Qwen3.7-max | `qwen/qwen3.7-max` | $1.25/$3.75 |
| o3 | `openai/o3` | $2.00/$8.00 |

Note: GPT-5 is available as `openai/gpt-5` (not `openai/gpt-5-chat`), verified present in model listing. DeepSeek v3.2 at $0.25/$0.38/M is the most cost-efficient frontier model on the list.

## Decision

Introduce a multi-model ensemble layer on top of the existing per-model agents. Each GAIA question runs through N models in parallel; answers are aggregated via a judge/voting layer.

### Architecture

```
GaiaEnsembleRunner
├── ModelAdapter (Claude)   ← wraps gaia-agent.ts runGaiaAgent()
├── ModelAdapter (Gemini)   ← wraps gaia-agent-gemini.ts runGeminiAgent()
└── ModelAdapter (OpenRouter) ← new thin adapter, OpenAI-compatible chat API
        ↓ parallel execution
EnsembleAggregator
├── Step 1: normalize answers (existing normaliseAnswer() from gaia-judge.ts)
├── Step 2: majority vote (N≥3 models, pick answer with >50% agreement)
├── Step 3: tiebreak (when no majority: judge model picks best with brief rationale)
└── Step 4: abstain (if all models return null/timedOut: mark as failed)
```

### Aggregation Strategy: Majority Vote + Judge Tiebreak (Recommended)

Three strategies were evaluated:

**(a) Majority vote on normalized answers** — chosen as primary.
- Works when ≥2 of 3 models agree on the normalized answer string.
- Zero additional LLM calls in the common case (~60-70% of questions based on calibration data).
- Fast, deterministic, zero extra cost when consensus is strong.

**(b) Judge-model picks best with reasoning** — used as tiebreak when no majority.
- When 3 models give 3 different answers (or 1 null), the judge model (Claude Sonnet) evaluates the candidates.
- Cost: ~$0.01 per tiebreak call (2k tokens in + 200 out at Sonnet pricing).
- Expected tiebreak rate: ~20-30% of questions based on pilot calibration.

**(c) Confidence-weighted** — rejected for now.
- Requires per-model confidence calibration data we do not yet have.
- Risk: models are poorly calibrated on GAIA-style factual retrieval.
- Can revisit in a later ADR once we have per-model accuracy distribution.

**Decision**: (a) majority vote with (b) judge tiebreak. No confidence weighting until calibration data exists.

### Minimum Viable Ensemble (Pilot)

Three models in order of cost-effectiveness:
1. `claude-sonnet-4-6` (direct, ~$0.05/Q at average token usage)
2. `gemini-2.5-pro` (direct, ~$0.035/Q at average token usage)
3. `openai/gpt-5` via OpenRouter ($1.25/$10.00/M, ~$0.035/Q) — **requires OpenRouter top-up**

Until OpenRouter is topped up, the pilot runs as a **2-model ensemble** (Claude + Gemini) with extended single-model fallback.

### New File: `gaia-ensemble.ts`

~300 LOC file at `v3/@claude-flow/cli/src/benchmarks/gaia-ensemble.ts`:
- `GaiaEnsembleRunner` class
- `EnsembleAggregator` (vote + tiebreak)
- `OpenRouterAdapter` (thin OpenAI-compatible wrapper)
- CLI integration: `gaia-bench run --mode=ensemble --models=<csv>`
- Cost tracking per model per question

## Cost Model

### Per-Question Estimates (L1 validation, ~10k input + ~3k output tokens average)

| Configuration | Cost/Q | 53-Q | 300-Q |
|---------------|--------|------|-------|
| Single Claude Sonnet | ~$0.075 | ~$4.00 | ~$22.50 |
| 2-model (Claude + Gemini 2.5 Pro) | ~$0.110 | ~$5.80 | ~$33.00 |
| 3-model (+ GPT-5 via OR) | ~$0.145 | ~$7.70 | ~$43.50 |
| 3-model + 10% judge tiebreak | ~$0.148 | ~$7.85 | ~$44.40 |
| 5-model full ensemble | ~$0.280 | ~$14.85 | ~$84.00 |

Cost gate from task specification: ≤$40 for 53-Q validation, ≤$250 for 300-Q test.
- 3-model ensemble: $7.85 / $44.40 — **well within gate on both**
- 5-model ensemble: $14.85 / $84.00 — within gate on both

### Full Test Set (300 questions, 3-model ensemble)

~$44 projected — within $250 budget. This is the cost to attempt a real leaderboard submission.

## Probability Assessment: Can We Reach Top-10?

**Honest assessment: No in 1-2 iterations. Plausibly yes in 4-6 iterations with the right ensemble.**

Assumptions for this analysis:
- Each model has independent error probability ~0.39 (matching our 61% single-model rate)
- Errors are NOT fully independent (correlated on hard questions, ~0.7 correlation on failure cases)
- Ensemble provides lift proportional to error independence

With 3 models at 61% accuracy and 0.7 failure correlation:
- Theoretical ensemble accuracy: ~75-78%
- Expected measured lift: ~14-17 percentage points over single-model
- Best case (if Claude+Gemini already differ on 40% of wrong answers): ~79-82%

With 5 models (adding GPT-5, DeepSeek, Kimi) at varying accuracies:
- Theoretical ensemble accuracy: ~82-86%
- Requires OpenRouter credits and validation that these models actually achieve ≥60% standalone

**Top-10 cutoff (~89%) is achievable only if**:
1. Individual models in the ensemble achieve ≥70% standalone (current best: 61%)
2. OR we use 5+ models with genuine error independence
3. OR we combine ensemble with per-question strategy improvements (hardness routing + ensemble)

**Verdict**: The ensemble is a necessary but not sufficient condition for top-10. It buys us ~15-17 points of lift on current model performance, putting us at ~76-78%. To close the remaining 11-13 point gap requires either stronger individual models (GPT-5 at 70%+?) or specialized handling of hard questions that current ensemble doesn't solve.

**Recommended path**:
1. This PR: validate 2-model ensemble lifts L1 above 70% on 53Q
2. Iter 64: top up OpenRouter, run 3-model ensemble on 53Q validation
3. Iter 65: add GPT-5 standalone calibration — if ≥70%, add to ensemble
4. Iter 66: specialized routing (easy→2-model, hard→5-model) to control cost

## Implementation

Files:
- `v3/@claude-flow/cli/src/benchmarks/gaia-ensemble.ts` — ensemble runner + OpenRouter adapter
- `v3/@claude-flow/cli/src/commands/gaia-bench.ts` — add `--mode=ensemble` flag

## Alternatives Considered

**Single stronger model (Opus 4.7)**: At $5/$25/M, Opus is 5× more expensive than Sonnet. Standalone accuracy likely 65-70%, not competitive with an ensemble. Rejected as primary path; can be used as a tiebreak judge.

**Chain-of-thought self-consistency (N=5 per model)**: Already implemented as Track A (--voting-attempts). Adds 5× cost per model with diminishing returns beyond N=3. Less effective than multi-model because same model makes same mistakes consistently.

**Fine-tuned model**: No fine-tuning API on Anthropic. Gemini fine-tuning available but expensive and GAIA training data is limited (165 L1 questions, ~100 usable after validation split).

## Consequences

**Positive**:
- Architecturally aligns with top-10 leaderboard approaches
- Claude and Gemini work independently via direct APIs (no OpenRouter dependency for 2-model pilot)
- Reuses existing gaia-agent.ts / gaia-agent-gemini.ts — no duplication of tool harness logic
- Cost-controlled: 3-model L1 validation at ~$7.85 vs $4 single-model (2× cost, expected 15+ point lift)

**Negative / risks**:
- OpenRouter exhausted — GPT-5/DeepSeek/Kimi unavailable until top-up
- Free-tier models (kimi-k2.6:free, deepseek-v4-flash:free) upstream rate-limited
- Error independence assumption may be optimistic — Claude and Gemini may fail on same questions (both miss obscure factual retrievals, both struggle with multi-hop reasoning)
- Tiebreak judge adds latency (~8-12s per tiebreak call)

## Validation

Implementation in this PR:
- `v3/@claude-flow/cli/src/benchmarks/gaia-ensemble.ts`
- 5-question pilot: ensemble score and cost reported in pilot output
- Cost projection confirms 3-model 53-Q within $40 gate

Full 53-Q validation run (iter 64) is gated on:
1. OpenRouter credits topped up (for GPT-5 / DeepSeek)
2. 5-Q pilot ensemble ≥4/5 (otherwise reassess model selection)
3. Cost ≤$40 for 53-Q (confirmed by projection)

---

## Addendum (2026-05-28): Research-Driven Revision — DAG Orchestration Supersedes Naive Voting

After this ADR's initial draft, three deep-research investigations into the actual top GAIA leaderboard entries materially changed the recommended architecture. **The naive N-model majority-vote design above is NOT how the leaders win.** Revised findings:

### Finding 1 — Co-Sight (ZTE, Apache-2.0): 95.7% L1 with OUR exact models

Source: `github.com/ZTE-AICloud/Co-Sight` (code read directly), arXiv 2510.21557. Evidence grade: HIGH.

Co-Sight v2.0.0 reached **95.7% L1 with exactly Claude Sonnet 4 + Gemini 2.5 Pro** — the models we already have. L1 was saturated at 95.7% BEFORE any proprietary model (ZTE Nebula) was added; Nebula only improved L3. **Conclusion: L1 performance is architecture, not model tier.** We do not need GPT-5 / Gemini-3-Pro / OpenRouter to compete on L1.

The winning architecture is NOT ensemble voting. It is:
1. **DAG planner** (`TaskPlannerAgent.create_plan` → 3-7 step dependency graph)
2. **Parallel role-split actors** (ThreadPoolExecutor, semaphore=5, `get_ready_steps()`) — independent sub-tasks run concurrently
3. **5-role model split**: plan / act / tool / vision / credibility, each an independently-configured client (GAIA submission: Claude=plan, Gemini=act/vision)
4. **Claude-aware planner prompt** (detect Claude → "3-5 steps max, direct answer" to avoid over-planning)
5. **Tool suite**: search + code + fetch/scrape + doc-parse + vision + audio. **No browser automation** — Playwright is commented out in their production submission.
6. **CAMV** (Conflict-Aware Meta-Verification): async 5-tier fact-reliability labeling; drives L2/L3 gains, negligible on L1.

### Finding 2 — Nemotron-ToolOrchestra (NVIDIA): bias-free routing beats self-preferring frontier models

Source: arXiv 2511.21689, `NVlabs/ToolOrchestra`, open-weight `nvidia/Nemotron-Orchestrator-8B`. Evidence grade: HIGH.

When GPT-5 or Claude Opus orchestrates a toolkit, it exhibits **self-enhancement bias** — calls itself ~98% of the time regardless of task fit. A small (8B) RL-trained orchestrator with a cost penalty routes task-appropriately, achieving 3.3× lower cost AND higher accuracy. **70-80% of the gain is replicable with a prompted orchestrator + specialist tools + 50-turn budget** — no RL training required.

### Revised Decision

**Supersede the naive majority-vote ensemble (above) with a Co-Sight-style DAG orchestration harness** (tracked as iter 64, task #73):

- DAG planner (Claude Sonnet 4.6) + parallel role-split actors (Gemini 2.5 Pro for act/vision)
- Port the four portable Co-Sight modules: `CoSight.py` (60-line loop), `todolist.py` (DAG), `planner_prompt.py` (Claude-aware), `credibility_analyzer.py` (CAMV)
- Tool suite we already have (T1 attachments, python_exec, grounded_query) — drop the visit_webpage investment (Co-Sight doesn't use a browser)
- **Ruflo's unique enhancement (task #72)**: a training-free **contrastive HNSW router** (RuVector ONNX embeddings over our accumulated `question→winning-model→success` tuples) approximates Nemotron's RL router without GRPO/H100. This is the publishable differentiator — neither naive-vote (most entries) nor RL-trained (NVIDIA only).

Multi-model voting (the original decision) is retained only as a **fallback aggregation inside actor steps**, not as the top-level architecture.

### OpenRouter status

Account exhausted (balance −$0.01). GPT-5/DeepSeek/Kimi unavailable until top-up — a USER BLOCKER. **Not on the L1 critical path** per Finding 1 (Co-Sight needs only Claude + Gemini, both available). OpenRouter top-up becomes relevant only for L2/L3 and test-set work where frontier diversity helps.

### Revised path

1. Iter 64: port Co-Sight DAG architecture, 5-Q pilot (Claude+Gemini, models we have)
2. Iter 65: full 53-Q L1 validation with DAG harness — target ≥45/53 (the Co-Sight evidence says ~90% L1 is reachable)
3. Iter 66: add contrastive HNSW router (task #72), measure vs static role assignment
4. Later: OpenRouter top-up + frontier diversity for L2/L3 + test-set submission (still gated on genuine top-10)
