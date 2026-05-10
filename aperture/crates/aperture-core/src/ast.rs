use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Verb {
    Help,
    Cls,
    Exit,
    List,
    Desc,
    Chart,
    Watch,
    Unwatch,
    Ask,
    Crypto,
}

impl Verb {
    pub fn from_token(s: &str) -> Option<Self> {
        match s.to_ascii_uppercase().as_str() {
            "HELP" | "?" => Some(Verb::Help),
            "CLS" | "CLEAR" => Some(Verb::Cls),
            "EXIT" | "QUIT" => Some(Verb::Exit),
            "LIST" | "LS" => Some(Verb::List),
            "DESC" | "DES" => Some(Verb::Desc),
            "CHART" | "GP" | "GIP" => Some(Verb::Chart),
            "WATCH" => Some(Verb::Watch),
            "UNWATCH" => Some(Verb::Unwatch),
            "ASK" => Some(Verb::Ask),
            "CRYPTO" => Some(Verb::Crypto),
            _ => None,
        }
    }

    pub fn requires_symbol(self) -> bool {
        matches!(
            self,
            Verb::Desc | Verb::Chart | Verb::Watch | Verb::Unwatch | Verb::Crypto
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Arg {
    /// A bareword token, e.g. `6M`.
    Word(String),
    /// A double-quoted string body (without the surrounding quotes).
    Quoted(String),
}

impl Arg {
    pub fn as_str(&self) -> &str {
        match self {
            Arg::Word(s) | Arg::Quoted(s) => s,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Command {
    /// `None` for bare verbs (HELP, CLS, EXIT, LIST, ASK).
    pub symbol: Option<String>,
    pub verb: Verb,
    pub args: Vec<Arg>,
    /// Whether the user terminated the input with the `GO` sentinel.
    #[serde(default)]
    pub go: bool,
}
