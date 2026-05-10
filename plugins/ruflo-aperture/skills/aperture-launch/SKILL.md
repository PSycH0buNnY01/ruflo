---
name: aperture-launch
description: Boot the Aperture WASM shell from a SvelteKit host. Use when the user wants the multi-pane market workspace in the browser.
---

# Aperture launch

Mounts the `aperture-wasm` artifact (built via `wasm-pack build crates/aperture-wasm`)
into the `/aperture` SvelteKit route and wires the `postMessage` relay to
ruflo's `message-bus.ts` so each pane can send and receive `Envelope`s on the
swarm bus.

The skill is a no-op when the artifact is missing; run
`plugins/ruflo-aperture/scripts/build-wasm.sh` first.
