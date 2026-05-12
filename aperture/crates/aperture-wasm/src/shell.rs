//! Browser shell. Mounts a minimal multi-pane workspace and exposes `App`
//! to JS.
//!
//! The host (SvelteKit) is responsible for the `postMessage` relay to ruflo's
//! `message-bus.ts`. The shell only:
//!   1. parses command lines via [`aperture_core::parse`],
//!   2. produces an outbound [`Envelope`] for the host to forward,
//!   3. accepts inbound envelopes and turns them into per-pane `View` lines.
//!
//! All routing logic lives in [`crate::shell_routing`] (target-agnostic) so
//! it can be exercised by `cargo test -p aperture-wasm` without the wasm32
//! target installed.

use aperture_core::{parse, Arg, Command, Verb};
use aperture_swarm::envelope::Envelope;
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::local_data::resolve_local;
use crate::shell_routing::{envelope_for, local_render, render_inbound, Pane, ViewLine};

/// Success payload of [`App::execute`].
#[derive(Debug, Serialize)]
struct ExecuteOk {
    ast: Command,
    /// Outbound envelope for the host to forward to the swarm bus, if any.
    /// `None` for purely-local verbs like HELP / CLS.
    outbound: Option<Envelope>,
    /// Per-pane lines to render immediately (e.g. echo, HELP body).
    views: Vec<ViewLine>,
}

/// Host-facing result of [`App::execute`], shaped for `serde_wasm_bindgen`.
///
/// Both variants are plain structs (not maps), so `serde_wasm_bindgen::to_value`
/// emits **plain JS objects** — `{ ok: { ast, outbound, views } }` /
/// `{ err: string }` — which the TS host reads as `ExecuteResult`. (Building
/// the wrapper with `serde_json::json!({"ok": …})` would serialize as a JS
/// `Map`, which stringifies to `{}` and has no readable `.ok` property — see
/// the `untagged` derive below for why a struct is required.)
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum ExecuteResult {
    Ok { ok: ExecuteOk },
    Err { err: String },
}

/// Mount the shell into a host element. Phase A keeps this minimal — the
/// SvelteKit page already lays out the panes; this entry point exists so
/// the host can call `start("aperture-mount")` to confirm the binding loaded.
#[wasm_bindgen]
pub fn start(_mount_id: &str) -> Result<(), JsValue> {
    // Phase B: real DOM mounting (ratzilla) lives here. v0.1 leaves DOM to
    // SvelteKit and this crate stays a pure logic core.
    Ok(())
}

/// Browser-side App. Holds the command-bar state, the focused symbol, and the
/// pane-local state the bare shell owns when no swarm bus is attached
/// (watchlist + inbox — with a real bus those would live in the watchlist /
/// inbox agents).
#[wasm_bindgen]
pub struct App {
    /// Last symbol broadcast via FOCUS, so symbol panes can re-anchor.
    last_symbol: Option<String>,
    /// Monotonic counter for envelope ids until we add a real ULID dep.
    seq: u64,
    /// Local watchlist (WATCH / UNWATCH / LIST).
    watchlist: Vec<String>,
    /// Local inbox — `(from, body)` pairs (INBOX posts / list).
    inbox: Vec<(String, String)>,
}

#[wasm_bindgen]
impl App {
    #[wasm_bindgen(constructor)]
    pub fn new() -> App {
        App {
            last_symbol: None,
            seq: 0,
            watchlist: Vec::new(),
            inbox: Vec::new(),
        }
    }

    /// Parse `line` and produce the host-facing result. Shape:
    /// ```ignore
    /// // success
    /// { ok: { ast, outbound: Envelope|null, views: ViewLine[] } }
    /// // failure
    /// { err: string }
    /// ```
    pub fn execute(&mut self, line: &str) -> JsValue {
        match parse(line) {
            Ok(cmd) => {
                // The host echoes the command line itself (`> …`), so the
                // shell doesn't seed one here — doing both produced a
                // duplicate line in the system pane.
                if let Some(s) = cmd.symbol.clone() {
                    self.last_symbol = Some(s);
                }
                self.seq = self.seq.wrapping_add(1);
                let outbound = envelope_for(&cmd, self.seq, self.last_symbol.as_deref());
                // Stateful verbs (watchlist / inbox) are owned by `App`;
                // everything else falls through to the local renderer + the
                // in-WASM `MemoryDataSource` data path. When a real swarm bus
                // is wired, the same `<VERB>.RESULT` shape also arrives via
                // `handle_inbound` — for v0.1 both paths are local.
                let views = match self.resolve_stateful(&cmd) {
                    Some(v) => v,
                    None => {
                        let mut v: Vec<ViewLine> = Vec::new();
                        if let Some(local) = local_render(&cmd) {
                            v.extend(local);
                        }
                        v.extend(resolve_local(&cmd, self.last_symbol.as_deref()));
                        v
                    }
                };
                let payload = ExecuteResult::Ok {
                    ok: ExecuteOk {
                        ast: cmd,
                        outbound,
                        views,
                    },
                };
                serde_wasm_bindgen::to_value(&payload).unwrap_or(JsValue::NULL)
            }
            Err(e) => {
                let payload = ExecuteResult::Err { err: e.to_string() };
                serde_wasm_bindgen::to_value(&payload).unwrap_or(JsValue::NULL)
            }
        }
    }

    /// Resolve the verbs whose state lives on `App` (watchlist / inbox).
    /// Returns `Some(views)` for those verbs, `None` for everything else.
    fn resolve_stateful(&mut self, cmd: &Command) -> Option<Vec<ViewLine>> {
        match cmd.verb {
            Verb::Watch => {
                let Some(sym) = cmd.symbol.clone().map(|s| s.to_ascii_uppercase()) else {
                    return Some(vec![ViewLine {
                        pane: Pane::Watch,
                        text: "WATCH: usage is `<SYMBOL> WATCH GO`".into(),
                    }]);
                };
                if !self.watchlist.iter().any(|w| w == &sym) {
                    self.watchlist.push(sym.clone());
                }
                Some(self.render_watchlist(Some(&format!("+ {sym}"))))
            }
            Verb::Unwatch => {
                let Some(sym) = cmd.symbol.clone().map(|s| s.to_ascii_uppercase()) else {
                    return Some(vec![ViewLine {
                        pane: Pane::Watch,
                        text: "UNWATCH: usage is `<SYMBOL> UNWATCH GO`".into(),
                    }]);
                };
                let before = self.watchlist.len();
                self.watchlist.retain(|w| w != &sym);
                let note = if self.watchlist.len() < before {
                    format!("- {sym}")
                } else {
                    format!("{sym} not in list")
                };
                Some(self.render_watchlist(Some(&note)))
            }
            Verb::List => Some(self.render_watchlist(None)),
            Verb::Inbox => {
                // Bare INBOX lists; INBOX "<msg>" posts (first quoted arg).
                if let Some(body) = cmd.args.iter().find_map(|a| match a {
                    Arg::Quoted(s) => Some(s.clone()),
                    _ => None,
                }) {
                    self.inbox.push(("you".into(), body));
                }
                Some(self.render_inbox())
            }
            _ => None,
        }
    }

    fn render_watchlist(&self, note: Option<&str>) -> Vec<ViewLine> {
        let mut out = Vec::new();
        if let Some(n) = note {
            out.push(ViewLine {
                pane: Pane::Watch,
                text: format!("WATCH  {n}"),
            });
        }
        if self.watchlist.is_empty() {
            out.push(ViewLine {
                pane: Pane::Watch,
                text: "(empty — `<SYMBOL> WATCH GO` to add)".into(),
            });
        } else {
            out.push(ViewLine {
                pane: Pane::Watch,
                text: self.watchlist.join("  "),
            });
        }
        out
    }

    fn render_inbox(&self) -> Vec<ViewLine> {
        let mut out = vec![ViewLine {
            pane: Pane::Inbox,
            text: format!("INBOX ({})", self.inbox.len()),
        }];
        if self.inbox.is_empty() {
            out.push(ViewLine {
                pane: Pane::Inbox,
                text: "(empty — `INBOX \"message\" GO` to post)".into(),
            });
        } else {
            for (from, body) in self.inbox.iter().take(20) {
                out.push(ViewLine {
                    pane: Pane::Inbox,
                    text: format!("{from}: {body}"),
                });
            }
        }
        out
    }

    /// Accept a JSON-encoded inbound [`Envelope`] from the host and return
    /// per-pane `ViewLine`s. The host got the envelope from
    /// `message-bus.ts` over `window.postMessage`.
    ///
    /// Only `<VERB>.RESULT` envelopes are rendered. A host that relays the
    /// shell's *own* outbound request back over `window.postMessage` (the
    /// standalone SPA does) would otherwise dump the raw request payload into
    /// the system pane — so any envelope whose `payload.verb` isn't a
    /// `*.RESULT` is ignored (the local data path already produced the views).
    pub fn handle_inbound(&mut self, envelope_json: &str) -> JsValue {
        let env: Envelope = match serde_json::from_str(envelope_json) {
            Ok(e) => e,
            Err(e) => {
                let v = vec![ViewLine {
                    pane: crate::shell_routing::Pane::System,
                    text: format!("inbound parse error: {e}"),
                }];
                return serde_wasm_bindgen::to_value(&v).unwrap_or(JsValue::NULL);
            }
        };
        let is_result = env
            .payload
            .get("verb")
            .and_then(|v| v.as_str())
            .map(|v| v.ends_with(".RESULT"))
            .unwrap_or(false);
        let lines = if is_result {
            render_inbound(&env)
        } else {
            Vec::<ViewLine>::new()
        };
        serde_wasm_bindgen::to_value(&lines).unwrap_or(JsValue::NULL)
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

// Silence unused-import warnings on the `keymap_web` / fetch_bridge glue;
// those are exercised through `App` once Phase B wires real DOM events.
#[allow(unused_imports)]
use crate::{fetch_bridge, keymap_web};
