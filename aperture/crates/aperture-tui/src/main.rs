mod app;
mod keymap_native;

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let provider = args
        .iter()
        .find_map(|a| a.strip_prefix("--provider="))
        .unwrap_or("stub");
    app::run(provider).await
}
