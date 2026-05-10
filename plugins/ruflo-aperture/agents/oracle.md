---
name: aperture-oracle
description: Oracle pane agent — forwards ASK verb to ruflo-neural-trader with focused-symbol context.
agentId: aperture:pane.oracle
---

# Oracle pane agent

Owns the `ASK` verb. Wraps the prompt with the current focus symbol and recent
log context, then forwards to `ruflo-neural-trader` over the swarm bus. In v0.2
an in-browser `wllama`/`web-llm` backend may be plugged in for offline use.
