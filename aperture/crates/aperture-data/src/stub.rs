//! Deterministic in-process provider for tests and offline demos.

use crate::{Candle, DataError, DataSource, Quote};
use async_trait::async_trait;

pub struct StubDataSource;

#[async_trait]
impl DataSource for StubDataSource {
    fn name(&self) -> &'static str {
        "stub"
    }

    async fn quote(&self, symbol: &str) -> Result<Quote, DataError> {
        let s = symbol.to_ascii_uppercase();
        let last = price_for(&s);
        Ok(Quote {
            symbol: s,
            last,
            change_pct: 0.42,
            bid: Some(last - 0.05),
            ask: Some(last + 0.05),
            timestamp: "2026-05-10T15:04:05.000Z".into(),
        })
    }

    async fn ohlcv(&self, symbol: &str, _range: &str) -> Result<Vec<Candle>, DataError> {
        let base = price_for(&symbol.to_ascii_uppercase());
        let mut out = Vec::with_capacity(30);
        for i in 0..30 {
            let drift = (i as f64) * 0.1;
            out.push(Candle {
                t: 1_700_000_000 + (i as i64) * 86_400,
                o: base + drift,
                h: base + drift + 1.0,
                l: base + drift - 1.0,
                c: base + drift + 0.5,
                v: 1_000_000.0,
            });
        }
        Ok(out)
    }
}

fn price_for(symbol: &str) -> f64 {
    let mut acc: u64 = 0;
    for b in symbol.bytes() {
        acc = acc.wrapping_mul(31).wrapping_add(b as u64);
    }
    100.0 + ((acc % 4_000) as f64) / 10.0
}
