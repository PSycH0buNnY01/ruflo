# ruflo-aperture

Thin TS plugin wrapper for the [`aperture`](../../aperture/) Rust+WASM workspace.
Surfaces the four v0.1 pane-agents (Quote, Chart, Watchlist, Oracle) and the
`/aperture` slash command to ruflo.

The actual logic lives in `aperture/`; this directory only exists so the plugin
ships through ruflo's IPFS plugin registry alongside `ruflo-market-data` and
`ruflo-neural-trader`.

## Pane → Agent map

| Pane | Agent ID | Backed by |
|---|---|---|
| Quote | `aperture:pane.quote` | `aperture-data` `DataSource::quote()` |
| Chart | `aperture:pane.chart` | OHLCV via swarm bus → `ruflo-market-data` HNSW patterns |
| Watchlist | `aperture:pane.watchlist` | `KeyValueStore` (sled native / OPFS WASM) |
| Oracle | `aperture:pane.oracle` | ASK forwarded over swarm bus → `ruflo-neural-trader` |
