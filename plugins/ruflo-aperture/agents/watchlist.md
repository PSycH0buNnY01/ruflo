---
name: aperture-watchlist
description: Watchlist pane agent — persists Symbol Set across sessions via KeyValueStore.
agentId: aperture:pane.watchlist
---

# Watchlist pane agent

Handles `WATCH`, `UNWATCH`, `LIST` verbs. State persists through the
`KeyValueStore` trait (sled on native, OPFS in the browser). On `FOCUS`
broadcasts, refreshes per-symbol mini-quotes through the data agent.
