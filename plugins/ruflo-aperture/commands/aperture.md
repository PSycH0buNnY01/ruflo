---
name: aperture
description: Launch the Aperture market workspace. `/aperture` opens the WASM shell; `/aperture <SYMBOL> <VERB>` boots focused on that symbol.
---

# /aperture

Boots the Aperture pane grid. Form: `/aperture [<SYMBOL> <VERB> [<ARG>...] [GO]]`.

Examples:

- `/aperture` — open empty workspace.
- `/aperture AAPL DESC GO` — open with the Quote pane focused on AAPL.
- `/aperture BTC CRYPTO` — open and route to the crypto-aware quote handler.
- `/aperture ASK "what moved NVDA today"` — open and route an ASK to the Oracle pane.

Native target: `cargo run -p aperture-tui` from `aperture/`.
Browser target: `pnpm --filter ruvocal dev` then visit `/aperture` in the SvelteKit host.
