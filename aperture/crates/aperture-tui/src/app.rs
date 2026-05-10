//! Native shell. v0.1 wires four panes (Quote, Chart, Watchlist, Oracle) to
//! a single `DataSource` directly. Phase B replaces the direct calls with
//! `aperture-swarm` `Envelope` traffic.

use std::io;
use std::time::Duration;

use anyhow::Result;
use aperture_core::{parse, Verb};
use aperture_data::{DataSource, StubDataSource};
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Terminal;

use crate::keymap_native::handle_key;

pub async fn run(provider: &str) -> Result<()> {
    let source: Box<dyn DataSource> = match provider {
        "stub" => Box::new(StubDataSource),
        other => anyhow::bail!("unknown provider: {other} (only `stub` available in v0.1)"),
    };

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut state = AppState::new();

    let result = main_loop(&mut terminal, &mut state, source.as_ref()).await;

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    result
}

pub struct AppState {
    pub input: String,
    pub log: Vec<String>,
    pub focus_symbol: Option<String>,
    pub watchlist: Vec<String>,
    pub quote_lines: Vec<String>,
    pub chart_lines: Vec<String>,
    pub oracle_lines: Vec<String>,
    pub should_quit: bool,
}

impl AppState {
    fn new() -> Self {
        Self {
            input: String::new(),
            log: vec!["Aperture v0.1 — type `HELP GO`".into()],
            focus_symbol: None,
            watchlist: Vec::new(),
            quote_lines: vec!["(no symbol)".into()],
            chart_lines: vec!["(no symbol)".into()],
            oracle_lines: vec!["(idle)".into()],
            should_quit: false,
        }
    }
}

async fn main_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    state: &mut AppState,
    source: &dyn DataSource,
) -> Result<()> {
    while !state.should_quit {
        terminal.draw(|f| draw(f, state))?;

        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    handle_key(state, key.code).await;
                    if let KeyCode::Enter = key.code {
                        let line = std::mem::take(&mut state.input);
                        execute_line(state, source, &line).await;
                    }
                }
            }
        }
    }
    Ok(())
}

async fn execute_line(state: &mut AppState, source: &dyn DataSource, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    state.log.push(format!("> {trimmed}"));

    match parse(trimmed) {
        Err(e) => state.log.push(format!("error: {e}")),
        Ok(cmd) => match cmd.verb {
            Verb::Help => {
                state.log.push(
                    "verbs: HELP CLS EXIT LIST  DESC CHART WATCH UNWATCH ASK CRYPTO".into(),
                );
                state.log.push("form: `SYMBOL VERB ARG* GO`".into());
            }
            Verb::Cls => state.log.clear(),
            Verb::Exit => state.should_quit = true,
            Verb::List => {
                state.log.push(if state.watchlist.is_empty() {
                    "watchlist empty".into()
                } else {
                    format!("watchlist: {}", state.watchlist.join(", "))
                });
            }
            Verb::Watch => {
                if let Some(s) = cmd.symbol.clone() {
                    if !state.watchlist.contains(&s) {
                        state.watchlist.push(s.clone());
                    }
                    state.log.push(format!("watching {s}"));
                }
            }
            Verb::Unwatch => {
                if let Some(s) = cmd.symbol.clone() {
                    state.watchlist.retain(|x| x != &s);
                    state.log.push(format!("unwatched {s}"));
                }
            }
            Verb::Desc | Verb::Chart | Verb::Crypto => {
                let Some(sym) = cmd.symbol.clone() else {
                    state.log.push("error: verb requires a symbol".into());
                    return;
                };
                state.focus_symbol = Some(sym.clone());
                match source.quote(&sym).await {
                    Ok(q) => {
                        state.quote_lines = vec![
                            format!("{}  last {:.2}  ({:+.2}%)", q.symbol, q.last, q.change_pct),
                            format!(
                                "bid {}  ask {}",
                                q.bid.map(|x| format!("{:.2}", x)).unwrap_or_else(|| "-".into()),
                                q.ask.map(|x| format!("{:.2}", x)).unwrap_or_else(|| "-".into())
                            ),
                        ];
                    }
                    Err(e) => state.quote_lines = vec![format!("quote error: {e}")],
                }
                if matches!(cmd.verb, Verb::Chart) {
                    let range = cmd.args.first().map(|a| a.as_str()).unwrap_or("1M");
                    match source.ohlcv(&sym, range).await {
                        Ok(candles) => {
                            state.chart_lines = render_ascii_chart(&candles);
                        }
                        Err(e) => state.chart_lines = vec![format!("ohlcv error: {e}")],
                    }
                }
            }
            Verb::Ask => {
                let prompt = cmd
                    .args
                    .first()
                    .map(|a| a.as_str().to_string())
                    .unwrap_or_default();
                state.oracle_lines = vec![
                    format!("Q: {prompt}"),
                    "A: (oracle pane will route to ruflo-neural-trader in Phase C)".into(),
                ];
            }
        },
    }
}

fn render_ascii_chart(candles: &[aperture_data::Candle]) -> Vec<String> {
    if candles.is_empty() {
        return vec!["(no data)".into()];
    }
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for c in candles {
        lo = lo.min(c.l);
        hi = hi.max(c.h);
    }
    let rows = 8usize;
    let cols = candles.len().min(60);
    let mut grid = vec![vec![' '; cols]; rows];
    for (x, c) in candles.iter().take(cols).enumerate() {
        let scale = |v: f64| -> usize {
            if hi == lo {
                rows / 2
            } else {
                let n = (v - lo) / (hi - lo);
                ((1.0 - n) * (rows as f64 - 1.0)).round() as usize
            }
        };
        let high_y = scale(c.h);
        let low_y = scale(c.l);
        let close_y = scale(c.c);
        for y in high_y..=low_y {
            grid[y][x] = '|';
        }
        if close_y < rows {
            grid[close_y][x] = '*';
        }
    }
    let mut out: Vec<String> = grid.into_iter().map(|r| r.into_iter().collect()).collect();
    out.push(format!("range hi {:.2}  lo {:.2}", hi, lo));
    out
}

fn draw(f: &mut ratatui::Frame, state: &AppState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(8),
            Constraint::Length(3),
        ])
        .split(f.area());

    let header = Paragraph::new(format!(
        " Aperture · focus: {} · panes: 4 ",
        state.focus_symbol.as_deref().unwrap_or("-")
    ))
    .style(Style::default().add_modifier(Modifier::REVERSED));
    f.render_widget(header, chunks[0]);

    let body = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(chunks[1]);
    let left = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(body[0]);
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(body[1]);

    pane(f, left[0], "Quote", &state.quote_lines);
    pane(f, left[1], "Chart", &state.chart_lines);
    pane(f, right[0], "Watchlist", &watchlist_lines(state));
    pane(f, right[1], "Oracle", &state.oracle_lines);

    let cmd = Paragraph::new(format!("> {}", state.input))
        .block(Block::default().borders(Borders::ALL).title("Command"));
    f.render_widget(cmd, chunks[2]);
}

fn watchlist_lines(state: &AppState) -> Vec<String> {
    if state.watchlist.is_empty() {
        vec!["(empty)".into(), "use `AAPL WATCH GO`".into()]
    } else {
        state.watchlist.clone()
    }
}

fn pane(f: &mut ratatui::Frame, area: Rect, title: &str, lines: &[String]) {
    let body: Vec<Line> = lines.iter().map(|s| Line::from(s.clone())).collect();
    let p = Paragraph::new(body).block(Block::default().borders(Borders::ALL).title(title));
    f.render_widget(p, area);
}
