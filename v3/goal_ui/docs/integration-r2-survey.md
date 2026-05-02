# R-2.1 Survey — `@claude-flow/memory` browser compatibility

> Step R-2.1 of `.ruflo-integration-plan.md`. Documents which exports
> from `@claude-flow/memory` v3.0.0-alpha.14 can be consumed in the
> goal_ui browser bundle, which require server-side proxying, and the
> recommended adapter strategy for R-2.2.

## TL;DR

**The package is Node-shaped today.** `sql.js` IS browser-compatible
in principle, but `SqlJsBackend` (the in-pkg sql.js wrapper) hardcodes
`node:fs` for persistence and `node:events` for event emission, so the
shipped `dist/sqljs-backend.js` cannot be bundled by Vite for the
browser without shimming both.

**Browser-safe today:**

| Symbol | File | Notes |
|---|---|---|
| `HnswLite` | `hnsw-lite.ts` | Pure JS — no Node imports. **Direct browser use OK.** |
| `cosineSimilarity` | `hnsw-lite.ts` | Same. |
| All type exports | `types.ts` | Type-only — erased at build time. |
| `safeJsonParse` | `json-security.ts` | Need to verify (no Node imports observed). |

**Node-only (NOT browser-bundleable today):**

| Symbol | Why |
|---|---|
| `SqlJsBackend` | imports `node:fs`, `node:events` |
| `RvfBackend` | imports `node:fs`, `node:fs/promises`, `node:path` |
| `AgentDBAdapter` / `AgentDBBackend` | imports `node:events` |
| `SQLiteBackend` | imports `node:fs`, `better-sqlite3` (native binary) |
| `HybridBackend` | composes the two above |
| `AutoMemoryBridge`, `AgentMemoryScope`, `LearningBridge` | `node:fs`, `node:path` |
| `ControllerRegistry`, `CacheManager`, `DatabaseProvider` | various Node imports |

The pattern is consistent: every backend that needs persistence or
event emission depends on Node primitives. The `IMemoryBackend`
interface itself (in `types.ts`) is platform-agnostic — that's the
contract goal_ui should target.

## Why goal_ui can't `import { AgentDBAdapter }` in the browser

Vite's dependency optimization tries to pre-bundle every dependency.
When it hits `agentdb-adapter.js`'s `import { EventEmitter } from
'node:events'`, the only way Vite can satisfy that is via a polyfill
(e.g. `events`, ~5 KB) that the user explicitly aliases. That's
fragile. Worse, the adapter pulls in `agentdb-backend.js` which pulls
in `agentdb` (an npm pkg with its own native deps), then `sql.js`
(WASM, which we already ship), then `better-sqlite3` (native node-gyp
build — fails in browser entirely).

Trying to dead-code-eliminate this graph is unrealistic. The right
path is to **build a slim browser adapter against the
`IMemoryBackend` interface from `types.ts`**, using:
- `HnswLite` directly (already browser-safe)
- IndexedDB for persistence (we already use this pattern in
  `src/integrations/rvf/client.ts`)
- A simple in-memory event emitter (or no events — IMemoryBackend
  doesn't require them in its public methods)

## Recommended R-2.2 adapter strategy

Create `src/integrations/agentdb/browser-adapter.ts` that:

1. **Implements `IMemoryBackend`** from `@claude-flow/memory/dist/types.js`
   so future Node↔browser interop has a known contract surface.
2. **Uses `HnswLite` from `@claude-flow/memory`** directly for the
   vector index — same code path Node uses, no fork.
3. **Persists to IndexedDB** through the existing `idb` wrapper (we
   already pull this in for `src/integrations/rvf/client.ts`). Schema:
   one ObjectStore per `MemoryType`.
4. **Wraps the existing `RvfClient`** so widgetConfig/userGoal/
   researchConfig writes flow through the new adapter without
   changing repo APIs (`getWidgetConfig`, `saveWidgetConfig`, etc.).
5. **Lazy-loads `HnswLite`** only when a vector op is requested,
   keeping the persistence-only path small (matches the lazy-load
   pattern we already use for ruvector ONNX-WASM in `embed.ts`).

This gets us:
- HNSW recall over saved goals (the R-2.4 deliverable) using the same
  `hnsw-lite.ts` source the Node side uses — single algorithm of record.
- IMemoryBackend contract compliance — future R-* phases can swap
  storage backends without touching repos.
- No Node-fs in the browser bundle. No native `better-sqlite3`.
  No need to polyfill `node:events`.

## Out of scope for R-2

- Cross-device sync (the `auto-memory-bridge`/`AgentMemoryScope` path).
  Requires server-side AgentDB with the user's account auth — addressed
  in a future phase (R-2.5+ or a separate ADR).
- Migration from existing IndexedDB (`ruflo-research-rvf`) data to the
  new IMemoryBackend-shaped store. R-2.3 will design a one-shot
  read-old-write-new migration on first load.
- DiskANN persistent index (per ADR-077). Browser-side, IndexedDB is
  the only persistent store available; DiskANN is a server-only concern.

## Decision

**For R-2.2:** build `src/integrations/agentdb/` as a thin browser
adapter that imports ONLY `HnswLite` + types from `@claude-flow/memory`.
Nothing else from the package is bundleable today, and forcing it
would require either (a) maintaining a fork of `SqlJsBackend` etc. with
the Node imports stubbed, or (b) blocking R-2 on a separate "make
@claude-flow/memory browser-friendly" upstream effort that's larger
than the goal_ui integration itself.

If/when `@claude-flow/memory` ships a `/browser` subpath export
or removes `node:*` imports from the sql.js path, the adapter can
collapse to a thin re-export.

## Loose ends to verify in R-2.2

- Confirm `HnswLite` builds + runs in the browser via a smoke test
  (lazy import + add 100 vectors + search top-10).
- Confirm `IMemoryBackend` from `types.ts` is fully type-only
  (no value imports that pull in Node).
- Pick the IndexedDB schema version — bump from `ruflo-research-rvf`
  v1 to v2 since the ObjectStore shape changes.
