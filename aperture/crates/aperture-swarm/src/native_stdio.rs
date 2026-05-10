//! Native transport: newline-delimited JSON over stdin/stdout.
//!
//! `unified-coordinator.ts` spawns the binary as a child process and pipes
//! `Envelope` JSON in/out per line. This module exposes async read and write
//! helpers; transport setup (channel wiring, retries, backpressure) is the
//! caller's responsibility.

use crate::envelope::Envelope;
use std::io;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdin, Stdout};

#[derive(thiserror::Error, Debug)]
pub enum TransportError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("eof")]
    Eof,
}

pub struct StdioReader {
    inner: BufReader<Stdin>,
    buf: String,
}

impl Default for StdioReader {
    fn default() -> Self {
        Self::new()
    }
}

impl StdioReader {
    pub fn new() -> Self {
        Self {
            inner: BufReader::new(tokio::io::stdin()),
            buf: String::new(),
        }
    }

    pub async fn next(&mut self) -> Result<Envelope, TransportError> {
        self.buf.clear();
        let n = self.inner.read_line(&mut self.buf).await?;
        if n == 0 {
            return Err(TransportError::Eof);
        }
        let env: Envelope = serde_json::from_str(self.buf.trim_end())?;
        Ok(env)
    }
}

pub struct StdioWriter {
    out: Stdout,
}

impl Default for StdioWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl StdioWriter {
    pub fn new() -> Self {
        Self {
            out: tokio::io::stdout(),
        }
    }

    pub async fn send(&mut self, env: &Envelope) -> Result<(), TransportError> {
        let line = serde_json::to_string(env)?;
        self.out.write_all(line.as_bytes()).await?;
        self.out.write_all(b"\n").await?;
        self.out.flush().await?;
        Ok(())
    }
}
