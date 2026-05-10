//! Browser entry. v0.1 exposes a single `start` entry point that mounts a
//! ratzilla shell into a host element and a `dispatch` function that the
//! SvelteKit host calls when the command bar submits a line. The host is
//! responsible for the postMessage relay to ruflo's `message-bus.ts`.

#[cfg(target_arch = "wasm32")]
mod web {
    use aperture_core::parse;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub fn start(_mount_id: &str) -> Result<(), JsValue> {
        // Minimal Phase A scaffold: confirm the binding is reachable.
        // Phase B mounts a ratzilla shell here.
        Ok(())
    }

    /// Parse a command line and return the AST as JSON. Lets the SvelteKit
    /// host show parse errors before any swarm traffic is generated.
    #[wasm_bindgen]
    pub fn parse_line(line: &str) -> Result<JsValue, JsValue> {
        match parse(line) {
            Ok(cmd) => serde_wasm_bindgen::to_value(&cmd)
                .map_err(|e| JsValue::from_str(&e.to_string())),
            Err(e) => Err(JsValue::from_str(&e.to_string())),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod stub {
    //! Native build of this crate is a no-op so that `cargo check --workspace`
    //! works without the wasm32 target installed. WASM users should build with
    //! `wasm-pack build crates/aperture-wasm`.
    #[allow(dead_code)]
    pub fn start(_mount_id: &str) {}
}
