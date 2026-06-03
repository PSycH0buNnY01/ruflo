# ADR-147: AgentDB Temporal Memory Compression and Provenance Anchoring

**Status:** Proposed  
**Date:** 2026-06-03  
**Authors:** claude (dream-cycle agent, 2026-06-03)  
**Tags:** memory, agentdb, performance, correctness

---

## Context

Dream Cycle nightly research (2026-06-03, SLOT=3, DEEP=memory) surfaced two peer-reviewed 2026 findings that identify concrete gaps in Ruflo's AgentDB:

1. **VikingMem** (arXiv:2605.29640, VLDB26): Event-entity abstraction with topic-wise timeline decay and time-weighted recall achieves +30% retrieval effectiveness over vector-only baselines (Grade A — peer-reviewed VLDB26).

2. **Eywa** (arXiv:2605.30771): Writing immutable source evidence before deriving facts enables 90.19% memory-verification judge accuracy. Current AgentDB writes derived facts directly with no source traceability.

Ruflo AgentDB currently uses HNSW + SQLite hybrid with semantic-only retrieval. It has no temporal compression, no provenance layer, and no published benchmark scores against LoCoMo or LongMemEval (the 2026 standard evaluation suite). Mem0's SOTA on LoCoMo is 92.5 with multi-signal retrieval (semantic + keyword + entity). Ruflo's gap is unquantified but structural.

---

## Decision

Extend AgentDB with two new subsystems:

### 1. Temporal Compression Layer (VikingMem-inspired)

- Introduce **Event** and **Entity** as first-class memory abstractions alongside the existing vector entry.
- Each Entity maintains a topic-wise timeline. Events attach to entities with a timestamp and recency weight.
- Write path: new memory → classify as event or entity update → update timeline → apply time-weighted decay to older events in the same topic.
- Read path: retrieval score = `α · semantic_similarity + (1-α) · recency_weight`, where `α` defaults to 0.7.
- Implement in `v3/@claude-flow/memory/src/temporal-compression.ts`; expose via existing `AgentMemory.store()` API with an optional `{ temporalMode: true }` flag (opt-in, non-breaking).

### 2. Provenance Anchoring (Eywa-inspired)

- On every write, store the raw source evidence record (the input text/tool output that caused the memory) as an immutable `MemorySource` entry linked to the derived `MemoryFact`.
- `MemorySource` is append-only: no update or delete operations.
- Retrieval of a fact optionally returns its linked sources for auditability.
- Implement in `v3/@claude-flow/memory/src/provenance.ts`.
- Add `AgentMemory.verifyFact(factId)` → returns source chain, enabling external judge evaluation.

### 3. Benchmark Harness

- Add `scripts/benchmark-memory-locomo.mjs` to run LoCoMo-style Q&A against a live AgentDB instance.
- Gate: score must be published in `docs/reviews/` before any LoCoMo claim appears in CLAUDE.md.

---

## Consequences

**Positive:**
- Closes the +30% retrieval gap identified by VLDB26 peer review.
- Enables memory auditability (provenance chain) needed for trust in multi-agent deployments.
- Establishes Ruflo's first published LoCoMo score, enabling competitive claims.

**Negative:**
- Write latency increases by an estimated 5–15ms per memory entry due to provenance record insertion.
- Storage overhead: provenance sources add ~20–40% to SQLite size for verbose tool outputs.
- Opt-in flag (`temporalMode`) adds API surface that must be maintained.

**Neutral:**
- Existing `AgentMemory` API is unchanged; both features are additive.
- HNSW index behavior is unmodified; temporal compression operates as a post-retrieval reranking step.

---

## Alternatives Considered

- **Full VikingDB adoption**: Replace AgentDB with VikingDB (VikingMem's backend). Rejected — too large a dependency swap; ADR-006 committed to AgentDB.
- **Mem0 API integration**: Use Mem0 as external memory backend. Rejected — introduces proprietary API dependency; contradicts self-hosted memory goal.
- **No action (parameter tuning only)**: The +30% retrieval gap and lack of provenance are structural, not parameter issues. No ADR — implementation-level would be incorrect.

---

## References

- VikingMem: arXiv:2605.29640 (VLDB26, May 2026)
- Eywa: arXiv:2605.30771 (May 2026)
- Memory for LLM Agents survey: arXiv:2603.07670 (March 2026)
- Mem0 SOTA benchmarks: mem0.ai/blog/state-of-ai-agent-memory-2026
- Prior ADR: ADR-006 (Unified Memory Service), ADR-009 (Hybrid Memory Backend)
- Dream Cycle gist: 2026-06-03 (witness: 5158be20993a3af8ef00698177f6ae520fa15b16d6b3e0ff85b360e0da54141a)
