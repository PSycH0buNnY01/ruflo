#!/usr/bin/env node
// benchmark-pretrained-retrieval.mjs — proof that pretrained patterns are
// retrievable, not just stored.
//
// Runs sample queries against the neural store (post-pretrain) and reports
// the top-k matches. Demonstrates that after `pretrain-from-github.mjs`
// runs, an agent can recall relevant past work by intent.
//
// Usage:
//   1. node scripts/pretrain-from-github.mjs           # populate the store
//   2. node scripts/benchmark-pretrained-retrieval.mjs # query + report

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(SCRIPT_DIR, '../../../..');
const RUNS_DIR = join(REPO_ROOT, 'docs', 'benchmarks', 'runs');

// Real ruflo-history-shaped queries. Each one targets a concept that should
// have been seen during pretrain. `expect` is a regex matched against the
// result's `name` field (commit subject or issue title) to score relevance.
// A result is "relevant" if its name matches the expect regex (case-insensitive).
const QUERIES = [
  { q: 'how was the Opus model alias fixed', expect: /opus|2232|model.*alias|4\.8/i },
  { q: 'self-learning wiring task-completed pretrain', expect: /self.?learning|task.?completed|pretrain|2245|074/i },
  { q: 'deterministic codemod engine var-to-const', expect: /codemod|var.?to.?const|143|deterministic/i },
  { q: 'MCP server orphan leak parent-death', expect: /mcp.*orphan|orphan.*mcp|parent.?death|leak/i },
  { q: 'unified learning stats aggregator', expect: /unified|stats|aggregator|075/i },
  { q: 'structured distillation 4-field schema', expect: /distillation|structured|076|4.?field/i },
  { q: 'SQL injection migrate.ts table identifier', expect: /sql.?injection|migrate|table|identifier/i },
  { q: 'recall@k HNSW benchmark harness', expect: /recall|hnsw|benchmark|harness/i },
  { q: 'Q-learning encoder keyword block', expect: /q.?learning|encoder|keyword|2239/i },
  { q: 'security hardening crypto random IDs', expect: /security|hardening|crypto|random/i },
];

const TOP_K = 5;

async function main() {
  const intel = await import(join(CLI_ROOT, 'dist/src/memory/intelligence.js'));
  const neural = await import(join(CLI_ROOT, 'dist/src/mcp-tools/neural-tools.js'));

  // §1 — snapshot the neural store + globalStats so we know what's there.
  const unified = await intel.getUnifiedLearningStats();
  const total = unified.neuralPatterns.patternCount;

  if (total === 0) {
    console.error('No patterns in neural store. Run scripts/pretrain-from-github.mjs first.');
    process.exit(2);
  }

  // §2 — A/B hybrid vs cosine-only (HYBRID=0 forces pre-3.10.18 behaviour).
  // Default runs hybrid (cosine + BM25 + MMR per ADR-078).
  const listTool = neural.neuralTools.find((t) => t.name === 'neural_patterns');
  const mode = process.env.HYBRID === '0' ? 'cosine' : 'hybrid';
  // ADR-080 opt-in cross-encoder rerank — set RERANK=1 to enable.
  const useRerank = process.env.RERANK === '1';

  // top-1-uniqueness — fraction of queries whose top-1 result is NOT the
  // same pattern ID as another query's top-1. Catches the "everyone gets
  // the same generic top-1" failure mode.
  const top1Ids = new Map();

  const tQuery0 = performance.now();
  const results = [];
  for (const { q, expect } of QUERIES) {
    const r = await listTool.handler({ action: 'search', query: q, mode, limit: TOP_K, rerank: useRerank });
    const matches = (r.patterns || r.results || r.matches || []).slice(0, TOP_K);
    if (matches.length > 0) {
      const top1 = matches[0].id;
      top1Ids.set(top1, (top1Ids.get(top1) ?? 0) + 1);
    }
    // ADR-078 relevance: does the top-1/top-3 name match the expect regex?
    const top1Name = matches[0]?.name ?? '';
    const top1Relevant = expect.test(top1Name);
    let top3Relevant = false;
    let firstRelevantRank = -1;
    for (let i = 0; i < Math.min(matches.length, 3); i++) {
      if (expect.test(matches[i]?.name ?? '')) {
        top3Relevant = true;
        if (firstRelevantRank === -1) firstRelevantRank = i + 1;
        break;
      }
    }
    results.push({
      query: q,
      matched: matches.length > 0,
      top1Relevant,
      top3Relevant,
      firstRelevantRank,
      topK: matches.map((m) => ({
        id: m.id,
        name: m.name?.slice(0, 100),
        type: m.type,
        score: m.score ?? m.similarity,
        cosineScore: m.cosineScore,
        bm25Score: m.bm25Score,
        mmrScore: m.mmrScore,
      })),
    });
  }
  const queryMs = performance.now() - tQuery0;

  const matchedQueries = results.filter((r) => r.matched).length;
  const top1Hits = results.filter((r) => r.top1Relevant).length;
  const top3Hits = results.filter((r) => r.top3Relevant).length;
  const ranks = results.filter((r) => r.firstRelevantRank > 0).map((r) => r.firstRelevantRank);
  // MRR over the top-3 window (rank-of-first-relevant). Queries with no
  // relevant result in top-3 contribute 0 to the mean.
  const mrr3 = QUERIES.length > 0
    ? Number((ranks.reduce((s, r) => s + 1 / r, 0) / QUERIES.length).toFixed(4))
    : 0;
  // top-1 collision: number of distinct top-1 IDs over the query count.
  const uniqueTop1 = top1Ids.size;
  const top1Diversity = Number((uniqueTop1 / QUERIES.length).toFixed(4));

  // top-3 redundancy: average fraction of top-3 results that are duplicates
  // of the same pattern within a single query (should be 0 — but if the same
  // ID appears twice in top-3 we surface it).
  let dupCount = 0, top3Slots = 0;
  for (const r of results) {
    const ids = r.topK.slice(0, 3).map((m) => m.id);
    top3Slots += ids.length;
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) dupCount++;
      seen.add(id);
    }
  }
  const top3DupRate = top3Slots > 0 ? Number((dupCount / top3Slots).toFixed(4)) : 0;

  const summary = {
    runAt: new Date().toISOString(),
    benchmark: 'pretrained-retrieval',
    mode,                              // ADR-078: which retrieval path was used
    rerank: useRerank,                 // ADR-080: cross-encoder rerank on/off
    storeSize: total,
    queries: QUERIES.length,
    matchedQueries,
    matchRate: Number((matchedQueries / QUERIES.length).toFixed(4)),
    top1HitRate: Number((top1Hits / QUERIES.length).toFixed(4)),  // ADR-078: relevance, not just any-match
    top3HitRate: Number((top3Hits / QUERIES.length).toFixed(4)),
    mrr3,                              // mean reciprocal rank over top-3
    top1Diversity,                     // 1.0 = every query gets a distinct top-1
    top3DupRate,                       // 0.0 = no duplicate IDs inside any top-3
    avgQueryLatencyMs: Number((queryMs / QUERIES.length).toFixed(2)),
    totalQueryMs: Number(queryMs.toFixed(2)),
    results,
    passed: matchedQueries === QUERIES.length,
  };

  if (process.env.BENCH_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`# Pretrained-retrieval benchmark — proof of learning`);
    console.log(`Mode: ${mode}${mode === 'hybrid' ? ' (cosine + BM25 + MMR, ADR-078)' : ' (cosine-only, pre-3.10.18)'}${useRerank ? ' + cross-encoder rerank (ADR-080)' : ''}`);
    console.log(`Store size: ${total} patterns`);
    console.log(`Queries: ${QUERIES.length}`);
    console.log(`Match rate: ${(summary.matchRate * 100).toFixed(0)}% (${matchedQueries}/${QUERIES.length})`);
    console.log(`Top-1 hit rate (RELEVANCE): ${(summary.top1HitRate * 100).toFixed(0)}% (${top1Hits}/${QUERIES.length})`);
    console.log(`Top-3 hit rate (RELEVANCE): ${(summary.top3HitRate * 100).toFixed(0)}% (${top3Hits}/${QUERIES.length})`);
    console.log(`MRR@3: ${summary.mrr3}`);
    console.log(`Top-1 diversity: ${(summary.top1Diversity * 100).toFixed(0)}% (${uniqueTop1} distinct top-1 IDs across ${QUERIES.length} queries)`);
    console.log(`Top-3 dup rate: ${(summary.top3DupRate * 100).toFixed(0)}%`);
    console.log(`Avg query latency: ${summary.avgQueryLatencyMs} ms`);
    console.log('');
    for (const r of results) {
      console.log(`Q: "${r.query}"`);
      if (r.topK.length === 0) {
        console.log(`   → no matches`);
      } else {
        for (const m of r.topK.slice(0, 3)) {
          console.log(`   → ${m.score?.toFixed?.(3) ?? '—'}  ${m.name}`);
        }
      }
    }
    console.log('');
    console.log(`Overall: ${summary.passed ? '✅ PASSED' : '⚠️  partial'}`);
  }

  if (!process.env.BENCH_NO_WRITE) {
    mkdirSync(RUNS_DIR, { recursive: true });
    const stamp = summary.runAt.replace(/[:.]/g, '-');
    writeFileSync(join(RUNS_DIR, `pretrained-retrieval-${stamp}.json`), JSON.stringify(summary, null, 2));
    writeFileSync(join(RUNS_DIR, 'pretrained-retrieval-latest.json'), JSON.stringify(summary, null, 2));
    if (!process.env.BENCH_JSON) console.log(`\nWrote ${join(RUNS_DIR, `pretrained-retrieval-${stamp}.json`)}`);
  }

  // ONNX runtime keeps a worker thread alive — force exit.
  process.exit(summary.passed ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
