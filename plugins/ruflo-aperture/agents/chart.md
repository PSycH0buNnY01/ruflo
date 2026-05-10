---
name: aperture-chart
description: Chart pane agent — renders ASCII (TUI) or canvas (WASM) OHLCV; consults ruflo-market-data HNSW pattern search.
agentId: aperture:pane.chart
---

# Chart pane agent

Consumes `verb ∈ {CHART, FOCUS}`. Requests OHLCV from the data agent and pattern
hits from `plugins/ruflo-market-data` over the swarm bus (no FFI). Rendering is
backend-neutral: `View` lines from `aperture-render` are translated to ratatui
or DOM nodes by the host.
