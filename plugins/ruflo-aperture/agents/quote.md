---
name: aperture-quote
description: Quote pane agent — resolves DESC verb, emits last/bid/ask for the focused symbol.
agentId: aperture:pane.quote
---

# Quote pane agent

Listens for `Envelope` payloads with `verb ∈ {DESC, FOCUS}` on the swarm bus.
On `DESC`, calls the active `DataSource` and replies with `verb: QUOTE.RESULT`
containing `{symbol, last, change_pct, bid, ask, timestamp}`.

Wire format mirrors `v3/@claude-flow/swarm/src/types.ts:Message`. Implementation
in `aperture/crates/aperture-tui/src/app.rs` (native) and
`aperture/crates/aperture-wasm/` (browser).
