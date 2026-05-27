// Auto-generated from src/benchmarks/capability-tasks.json — keep in sync.
// This module exists so the fixture is bundled into dist/ by tsc (JSON files
// are not copied by tsc, and the published CLI ships only dist/).

export const BUILTIN_CAPABILITY_TASKS = {
  "version": "1.1",
  "description": "Text-only agent capability benchmark — verifiable multi-step reasoning tasks scoreable without tool use. Format inspired by GAIA / SWE-bench / GSM8K. The fixture mixes EASY (regression-floor) and HARD (model-gradient) questions so the pass rate has signal across Haiku → Sonnet → Opus. Real GAIA (web browsing, attachments, HF dataset) remains future work.",
  "answerFormat": "Each question requires the model to reply with the answer wrapped in <answer>...</answer> tags. The harness extracts the tag contents and checks against `expected` per `matchMode`. Per-task `maxTokens` overrides the default cap.",
  "tasks": [
    {
      "id": "math-prime",
      "category": "easy:reasoning",
      "prompt": "What is the smallest 3-digit prime number that does not contain the digit 7?",
      "expected": "101",
      "matchMode": "exact",
      "maxTokens": 192
    },
    {
      "id": "logic-syllogism",
      "category": "easy:reasoning",
      "prompt": "All routers in tier 1 cost less than $0.001 per call. The Booster router is in tier 1. The Sonnet router costs $0.003 per call. Is the Sonnet router in tier 1? Answer with just \"yes\" or \"no\".",
      "expected": "no",
      "matchMode": "exact",
      "maxTokens": 160
    },
    {
      "id": "regex-match",
      "category": "easy:code-reasoning",
      "prompt": "Given the regex /^([a-z]+)-(\\d+)$/ and the input string 'pattern-1779526376', what is the value of capture group 2?",
      "expected": "1779526376",
      "matchMode": "exact",
      "maxTokens": 192
    },
    {
      "id": "gsm8k-trip",
      "category": "hard:gsm8k-style",
      "prompt": "A delivery van starts a route with 240 packages. At stop A it drops off 1/4 of its current load and picks up 6 new packages. At stop B it drops off 1/3 of its current load and picks up 4 new packages. At stop C it drops off half of its current load. How many packages does the van have after stop C? Answer with the integer.",
      "expected": "64",
      "matchMode": "exact",
      "maxTokens": 256
    },
    {
      "id": "gsm8k-discount",
      "category": "hard:gsm8k-style",
      "prompt": "A store sells 3 widgets and 2 sprockets for $23. It also sells 2 widgets and 4 sprockets for $26. What is the price of one widget? Answer with the integer dollar amount only.",
      "expected": "5",
      "matchMode": "exact",
      "maxTokens": 256
    },
    {
      "id": "code-trace",
      "category": "hard:code-trace",
      "prompt": "Consider this JavaScript code:\n```\nconst counts = new Map();\nfor (const c of 'abracadabra') {\n  counts.set(c, (counts.get(c) ?? 0) + 1);\n}\nlet maxK = '', maxV = 0;\nfor (const [k, v] of counts) {\n  if (v > maxV || (v === maxV && k < maxK)) { maxK = k; maxV = v; }\n}\nconsole.log(`${maxK}:${maxV}`);\n```\nWhat does it print? Answer with just the printed string.",
      "expected": "a:5",
      "matchMode": "exact",
      "maxTokens": 192
    },
    {
      "id": "hard-graph-shortest",
      "category": "hard:graph-reasoning",
      "prompt": "A directed graph has these weighted edges: A→B(3), A→C(7), B→C(2), B→D(5), C→D(1), C→E(4), D→E(2). What is the cost of the shortest path from A to E? Answer with the integer.",
      "expected": "8",
      "matchMode": "exact",
      "maxTokens": 192
    },
    {
      "id": "hard-probability",
      "category": "hard:probability",
      "prompt": "A bag contains 5 red, 3 blue, and 2 green balls. Two balls are drawn without replacement. What is the probability that both balls are the same color? Express as a fraction in lowest terms in the form a/b (e.g. 3/10).",
      "expected": "14/45",
      "matchMode": "exact",
      "maxTokens": 256
    }
  ]
} as const;
