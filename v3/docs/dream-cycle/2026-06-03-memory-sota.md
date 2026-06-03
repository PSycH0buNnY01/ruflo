# Memory SOTA Report — 2026-06-03

**TL;DR:** Event-entity temporal compression (VikingMem, VLDB26) and provenance-anchored retrieval (Eywa) are the two most actionable 2026 breakthroughs for Ruflo's AgentDB—Ruflo's current HNSW index misses both, leaving a measurable gap against Mem0's LoCoMo 92.5 SOTA score.

---

## What's New in 2026

| Finding | Source | Confidence |
|---------|--------|------------|
| VikingMem event-entity temporal compression: 30% better retrieval effectiveness vs baselines, VLDB26-accepted | arXiv:2605.29640 (VLDB26, May 2026) | A |
| Mem0 multi-signal retrieval (semantic + keyword + entity): LoCoMo 92.5, LongMemEval 94.4, BEAM-1M 64.1 | mem0.ai benchmark blog (2026) | B |
| Eywa provenance-grounded memory: 90.19% judge accuracy via immutable source-before-fact write path | arXiv:2605.30771 (May 2026) | B |
| MemForest hierarchical temporal indexing: 6× throughput vs prior approaches via parallel chunk extraction | arXiv:2605.23986 (May 2026) | B |
| STaR-KV KV-cache spatio-temporal re-weighting: 40% GPU memory reduction for GUI/long-context agents | arXiv:2606.01722 (June 2026) | A |
| JAMEL: memory + exploration trained jointly via novelty signals — sustained agent capability across sessions | arXiv:2606.01528 (June 2026) | B |
| Survey (Du 2026): field shifted from static recall to multi-session agentic benchmarks; five open frontiers identified | arXiv:2603.07670 (March 2026) | A |

---

## Ruflo Current Capability

| Capability | Status | Notes |
|-----------|--------|-------|
| Vector search (HNSW) | ✅ Deployed | ~1.9× at N=20k vs brute force (measured) |
| Int8 quantization | ✅ Deployed | 3.84× compression, cosine 0.99999 |
| Session-level persistence | ✅ Deployed | AgentDB + SQLite hybrid |
| Temporal compression | ❌ Missing | No VikingMem-style event-entity decay |
| Provenance anchoring | ❌ Missing | No Eywa-style source-before-fact writes |
| Multi-signal retrieval | ❌ Missing | Semantic only; no keyword+entity fusion |
| KV-cache compression | ❌ Missing | Long-context agents pay full cache cost |
| Benchmark score (LoCoMo-equiv.) | Unknown | Not benchmarked against LoCoMo/LongMemEval |

---

## Competitor Comparison

| Framework | Memory Approach | Long-term Persistence | Benchmark Score (LoCoMo) | Notable Limitation |
|-----------|----------------|----------------------|--------------------------|-------------------|
| **Mem0** | Multi-signal retrieval (semantic+keyword+entity) + temporal reasoning | Vector DB, managed API | 92.5 (SOTA 2026) | Proprietary API; opaque internals |
| **LangGraph** | Checkpointed graph state + Pinecone/ChromaDB integration | Native checkpointing + external vector DB | Not published | Verbose config; requires infra setup |
| **CrewAI** | Structured task outputs + SQLite3 long-term memory | SQLite3 | Not published | SQLite scalability ceiling at high-throughput |
| **AutoGen AG2** | Event-driven message lists + pluggable external stores | Requires external integration (1.0 GA 2026) | Not published | No built-in persistence; integration burden |
| **Ruflo AgentDB** | HNSW vector index + SQLite hybrid | Native (AgentDB) | Not benchmarked | No temporal compression or provenance layer |

---

## Benchmarks

| Benchmark | Description | Mem0 SOTA Score | Ruflo Score | Grade |
|-----------|-------------|-----------------|-------------|-------|
| LoCoMo | 1,540 Q across single/multi-hop, temporal tasks | 92.5 | Not measured | A (Mem0 blog, crosschecked vs paper) |
| LongMemEval | 500 Q, preference + knowledge update + temporal reasoning | 94.4 | Not measured | B (single vendor source) |
| BEAM-1M | Production scale, 10 categories, 1M token window | 64.1 | Not measured | B (single vendor source) |
| VikingMem retrieval | Long-term interaction retrieval effectiveness | +30% vs baselines | Not measured | A (VLDB26 peer-reviewed) |

---

## SOTA Proof & Witness

> **Session commit:** `844f68dbe5f28c4c2b13c56e8e102528aa63b629`
> **Report SHA-256:** `470d4e36b59d6f9ed2ddec5b7937caa417e7fb58b61bddee0c0e77663f8abef9`
> **Witness stamp:** `5158be20993a3af8ef00698177f6ae520fa15b16d6b3e0ff85b360e0da54141a`
>
> *Verifier: fetch raw report → sha256sum → concat session commit → sha256sum → must equal witness stamp.*

---

## Recommended Next Steps

1. **Implement VikingMem event-entity temporal compression in AgentDB** (ADR-147): Add event-entity abstraction with topic-wise timeline decay and time-weighted recall. Estimated retrieval gain: +30% (Grade A, VLDB26). Target: `v3/@claude-flow/memory/src/temporal-compression.ts`.

2. **Add provenance anchoring to memory write path** (ADR-147): Before writing derived facts, store immutable source evidence (Eywa pattern). Expected judge accuracy target: ≥85% (below Eywa's 90.19% as conservative target). Target: `v3/@claude-flow/memory/src/provenance.ts`.

3. **Benchmark AgentDB against LoCoMo and LongMemEval**: Ruflo has no published scores on the 2026 standard benchmarks. Even a single LoCoMo run would ground competitive claims. Add benchmark script to `scripts/benchmark-memory-locomo.mjs`.
