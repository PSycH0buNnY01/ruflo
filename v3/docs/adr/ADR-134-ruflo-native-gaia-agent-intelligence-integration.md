# ADR-134 — Ruflo-Native GAIA Agent: Intelligence Stack Integration

**Status**: Proposed
**Date**: 2026-05-27
**Authors**: claude (post-SOTA-pursuit /loop horizon-tracker)
**Related**: ADR-133 (Real GAIA Capability Benchmark — vanilla harness), ADR-132 (SimulativePlanningRouter, acceptance gate measured −78.2%), ADR-026 (3-tier model routing), ADR-088 (LongMemEval benchmark template)

---

## Context

ADR-133 shipped a working GAIA Level-1 capability benchmark harness. Across 23 iterations of a
5-minute /loop, the harness landed:

- Full tool stack (`web_search` 3-backend fallback, `file_read`, `python_exec`, `web_browse`,
  `image_describe`)
- Multi-turn agent loop with quality improvements (empty-hint, multi-pattern extraction,
  anti-surrender prompt)
- Two-stage judge (exact-match + Sonnet LLM-as-judge with caching)
- CLI entry (`gaia-bench run`) + CI workflow

But the harness is **vanilla**: `gaia-agent.ts` calls Anthropic Messages API directly via raw
`fetch`. It does not exercise ruflo's intelligence stack:

- ADR-132 SimulativePlanningRouter (built, measured −78.2% token reduction, unused in GAIA loop)
- SONA pattern learning across runs
- Pre-task / post-task / route hooks
- 4-step intelligence pipeline (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE)
- agentic-flow swarm coordination

### Current gap to SOTA

Princeton HAL leaderboard: Claude Sonnet 4.5 baseline is 74.6% on full GAIA L1. Iter 23 of the
/loop is running the consolidated measurement (`--limit 53`, Haiku + Sonnet-4-6, 6-concurrent).
Preliminary signals from earlier iterations: Haiku ~15-20%, Sonnet-4-6 ~20-35%. This implies a
~35-55pp gap to close against the HAL Sonnet 4.5 number.

Closing that gap by vanilla harness tuning alone (more retries, better prompts, smarter tool
chains) is months of competitor-style engineering and converges to the same architecture as HAL.
The differentiated ruflo path is integrating ruflo's intelligence stack — which is unproven on
GAIA but architecturally novel vs HAL.

### Realistic probability bands (as of 2026-05-27)

| Path | P(beat HAL 74.6%) | P(reach parity ±5pp) |
|------|-------------------|----------------------|
| Vanilla harness only | ~5% | ~15% |
| With ADR-134 Track A+B | ~15% | ~40% |
| With ADR-134 Track A+B+C | ~20-30% | ~55% |
| With ADR-134 all four tracks | ~25-35% | ~65% |

These are honest estimates. The intelligence stack is novel; novelty cuts both ways.

---

## Decision

Integrate ruflo's intelligence stack into the GAIA agent loop on a per-PR, measurable basis.
Each integration must be empirically validated against the post-ADR-133 vanilla baseline (iter
23's consolidated L1 number).

---

## Integration Tracks (priority order by estimated lift / effort ratio)

### Track A — SimulativePlanningRouter integration

**Estimated effort**: 1 day  
**Estimated lift**: +3-8pp on L1 Sonnet pass rate  
**Risk**: Low (additive, easily reverted)

Wire ADR-132's `maybeSimulatePlan` into `gaia-agent.ts`'s decision step:

- Before each Tier-3 (Sonnet) call, if `estimatedHorizon > 5` OR `predictedMcpCalls >= 2`, run a
  shadow Haiku planning pass first
- Inject the resulting plan as a `[PLAN_CONTEXT]` prefix in Sonnet's system message
- ADR-132's −78.2% token reduction on multi-step tasks should manifest as better answer quality
  (the model structures a plan before committing to tool calls)

**Acceptance gate**: ≥3pp lift on L1 Sonnet pass rate across iter 23 baseline, OR clear evidence
of no harm (enables later tracks to build on it).

**Implementation note**: `SimulativePlanningRouter` is already fully built in
`v3/@claude-flow/cli/src/simulation/`. Wiring is a `gaia-agent.ts` change only.

---

### Track B — Cross-run SONA pattern learning

**Estimated effort**: 1-2 days  
**Estimated lift**: +5-10pp on second-and-subsequent runs  
**Risk**: Medium (requires run-persistent storage; SONA's GAIA-domain effectiveness is unknown)

After each L1 question completes, store the trajectory in SONA via the ReasoningBank:

- **Successful trajectories**: pattern = (question-type signature, tool sequence, answer-extraction
  pattern, model tier used)
- **Failed trajectories**: counter-pattern = (question signature, what went wrong — e.g., tool
  returned empty, model surrendered, extraction regex missed)

Before each new question, retrieve top-k similar prior trajectories and inject as additional
system context (`[PRIOR_EXPERIENCE]` block). Compound benefit grows across runs — this is a
capability that Princeton HAL almost certainly does not have.

**Acceptance gate**: ≥5pp lift on second-and-subsequent runs vs. the same harness's first run
over identical questions.

**Implementation note**: SONA / ReasoningBank APIs live in
`v3/@claude-flow/cli/src/intelligence/`. The trajectory storage schema needs a GAIA-specific
namespace to avoid polluting other workloads.

---

### Track C — Hook-driven agent observability and adaptation

**Estimated effort**: 2-3 days  
**Estimated lift**: +5-15pp  
**Risk**: Medium (hook wiring is additive, but model routing logic introduces new failure modes)

Wire ruflo's hook system into `gaia-agent.ts`:

- **`pre-task` hook** before each question: classifies question type (factual / computational /
  multimodal / research) and emits tool-subset recommendation + model-tier recommendation
- **`route` hook** to pick model (Haiku for factual/easy, Sonnet for computational/research/
  multimodal) — reduces cost and may reduce confusion on simple questions
- **`post-task` hook** records outcome (pass/fail, tools used, turns consumed, judge verdict) to
  AgentDB for Track B to read
- **Per-tool boundary hooks**: `pre-tool` / `post-tool` for instrumentation and anomaly detection
  (e.g., flag when `web_search` returns empty three times in a row)

**Acceptance gate**: ≥5pp lift; observability improvement (structured per-question telemetry in
AgentDB) is a non-negotiable deliverable regardless of pass-rate impact.

---

### Track D — agentic-flow swarm coordination (research-grade)

**Estimated effort**: 3-5 days  
**Estimated lift**: +10-20pp on hard questions; uncertain on easy L1 questions  
**Risk**: High (complexity, cost ~3x, failure modes multiply)

For hard questions (Level-2/3 territory, but also hard L1 outliers — questions requiring multi-hop
reasoning or uncommon domain knowledge), use multi-agent collaboration:

- **Fan-out**: Spawn 2-3 worker agents with distinct strategies (web-first, code-first,
  vision-first)
- **Synthesis**: A coordinator agent votes on or synthesizes the answers from workers
- **Gate**: Only invoke for questions that Track C's pre-task classifier rates as "hard"
  (estimated tool calls ≥4, horizon ≥8, or multimodal)

This adds ~3x cost on hard questions but should raise the ceiling on the subset that currently
causes the most failures.

**Acceptance gate**: ≥10pp lift on the hard-question subset (as classified by Track C), without
regressing pass rate on easy questions.

---

## Consequences

### Positive

- Ruflo's intelligence stack gets exercised and measured on a real, publicly scored benchmark
- Each track is independently shippable and measurable against the same vanilla baseline
- Cross-run pattern memory (Track B) is differentiated from HAL's architecture
- Observability from Track C is valuable independent of GAIA — it instruments the agent loop for
  all future benchmarks
- Sequential shipping de-risks: Track A first, then B if A shows ≥3pp, etc.

### Negative

- Track B requires ≥10 runs to validate compound learning — burn rate on GAIA API calls
- Track C adds hook infrastructure that can introduce latency and failure modes
- Track D adds ~3x cost on hard questions and operational complexity
- Most realistic outcome (all four tracks): parity with HAL (~74%), not exceeding it. P(beat) is
  ~25-35%.
- If any track regresses the baseline: revert, document, do not proceed to next track

---

## Implementation Order

```
Track A (SimulativePlanningRouter) → measure
    ↓ if ≥3pp lift
Track B (SONA cross-run learning) → measure
    ↓ if ≥5pp lift on second run
Track C (hooks + observability) → measure
    ↓ if ≥5pp lift
Track D (agentic-flow swarm) → measure on hard subset only
```

If any track regresses: revert, document the failure mode, skip that track, continue.

---

## Measurement Protocol

Baseline: iter 23's consolidated L1 run (`--limit 53`, Haiku + Sonnet-4-6, all ADR-133
improvements active). This is the single fixed reference point.

For each track's PR:

1. Run `gaia-bench run --level 1 --limit 53 --models claude-sonnet-4-6 --output json`
2. Compare exact-match + LLM-judge composite score vs. baseline
3. Post result as PR comment before merge

---

## References

- [ADR-132](ADR-132-simulative-planning-router.md) — SimulativePlanningRouter (−78.2% token
  reduction, acceptance gate measured and passed)
- [ADR-133](ADR-133-real-gaia-capability-benchmark.md) — Real GAIA Capability Benchmark
  (vanilla harness, all tool integrations, CLI entry, CI workflow)
- ADR-026 — 3-tier model routing (Tier 1 WASM / Tier 2 Haiku / Tier 3 Sonnet-Opus)
- ADR-088 — LongMemEval benchmark template (cross-run memory evaluation precedent)
- Princeton HAL leaderboard — Claude Sonnet 4.5 @ 74.6% on full GAIA L1 (as of 2026-05-27)
- Issue #2156 — Dream Cycle 2026-05-27 capabilities scan (root tracking issue for SOTA pursuit)
- PR #2173 — ADR-133 consolidated harness (iter 23 running at time of ADR-134 filing)
