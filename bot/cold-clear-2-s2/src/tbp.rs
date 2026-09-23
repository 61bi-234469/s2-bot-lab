use enumset::{EnumSet, EnumSetType};
use serde::{Deserialize, Serialize};

use crate::data::{Board, Piece, Placement};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[serde(tag = "type")]
pub enum FrontendMessage {
    Rules,
    InvalidJson,
    Start(Start),
    Play {
        #[serde(rename = "move")]
        mv: Placement,
    },
    NewPiece {
        piece: Piece,
    },
    Suggest,
    SuggestNow,
    Stop,
    Quit,
    #[serde(other)]
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
#[serde(tag = "type")]
pub enum BotMessage {
    Info {
        name: &'static str,
        version: &'static str,
        author: &'static str,
        features: &'static [&'static str],
    },
    Ready,
    ProtocolError { reason: &'static str },
    Suggestion {
        moves: Vec<Placement>,
        move_info: MoveInfo,
    },
}

fn deserialize_optional_b2b<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Number(number) => number
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("b2b must be an unsigned u32")),
        _ => Err(serde::de::Error::custom("b2b must be an unsigned u32")),
    }
}

#[derive(Deserialize)]
pub struct Start {
    pub board: Board,
    pub queue: Vec<Piece>,
    pub hold: Option<Piece>,
    pub combo: u32,
    pub back_to_back: bool,
    /// Canonical one-based B2B chain length. Missing falls back to the bool.
    #[serde(default, deserialize_with = "deserialize_optional_b2b")]
    pub b2b: Option<u32>,
    #[serde(default)]
    pub randomizer: Randomizer,
    /// Opaque JSON until the config flag is true. Flag-off must not convert it.
    #[serde(default)]
    pub s2_incoming: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct S2IncomingAmounts {
    pub pending_rows: u32,
    pub due_this_lock_rows: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[serde(tag = "type")]
pub enum Randomizer {
    SevenBag {
        #[serde(deserialize_with = "collect_enumset")]
        bag_state: EnumSet<Piece>,
    },
    #[serde(other)]
    Unknown,
}

impl Default for Randomizer {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Serialize)]
pub struct MoveInfo {
    pub nodes: u64,
    pub selections: u64,
    pub candidate_values: Vec<f32>,
    pub nps: f64,
    pub extra: String,
}

impl From<Vec<[Option<char>; 10]>> for Board {
    fn from(v: Vec<[Option<char>; 10]>) -> Self {
        let mut cols = [0; 10];
        for x in 0..10 {
            for y in 0..40 {
                if v[y][x].is_some() {
                    cols[x] |= 1 << y;
                }
            }
        }
        Board { cols }
    }
}

fn collect_enumset<'de, D, T>(de: D) -> Result<EnumSet<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: EnumSetType + Deserialize<'de>,
{
    Ok(Vec::<T>::deserialize(de)?.into_iter().collect())
}

/// Bounded, recovering JSONL parser shared by both native process profiles.
pub fn read_json_line(input: &mut impl std::io::BufRead) -> Option<serde_json::Value> {
    read_json_line_bounded(input,262144)
}
pub fn read_json_line_bounded(input: &mut impl std::io::BufRead, max_bytes: usize) -> Option<serde_json::Value> {
    let mut bytes=Vec::new();let mut overflow=false;
    loop {
        let buffer=match input.fill_buf(){Ok(v)=>v,Err(_)=>return None};
        if buffer.is_empty(){if bytes.is_empty()&&!overflow{return None}break}
        let end=buffer.iter().position(|b|*b==b'\n');let used=end.map_or(buffer.len(),|n|n+1);
        if bytes.len()+used>max_bytes {overflow=true;bytes.clear();}
        if !overflow {bytes.extend_from_slice(&buffer[..used]);}
        input.consume(used);if end.is_some(){break}
    }
    Some(if overflow {serde_json::json!({"type":"invalid_json"})} else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_|serde_json::json!({"type":"invalid_json"}))
    })
}

#[cfg(test)]
mod jsonl_tests {
    use super::{read_json_line, Start};

    fn start_value() -> serde_json::Value {
        serde_json::json!({
            "board": vec![vec![Option::<char>::None; 10]; 40],
            "queue": ["T", "I", "O"],
            "hold": null,
            "combo": 0,
            "back_to_back": true,
            "randomizer": { "type": "seven_bag", "bag_state": [] },
        })
    }

    #[test]
    fn b2b_deserialization_accepts_u32_and_rejects_non_integer_values() {
        let missing: Start = serde_json::from_value(start_value()).unwrap();
        assert_eq!(missing.b2b, None);

        for value in [0_u32, 4, u32::MAX] {
            let mut input = start_value();
            input["b2b"] = serde_json::json!(value);
            assert_eq!(serde_json::from_value::<Start>(input).unwrap().b2b, Some(value));
        }

        for value in [
            serde_json::Value::Null,
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!(u64::from(u32::MAX) + 1),
        ] {
            let mut input = start_value();
            input["b2b"] = value;
            assert!(serde_json::from_value::<Start>(input).is_err());
        }
    }
    #[test]
    fn malformed_and_oversize_lines_recover_and_eof_terminates() {
        let mut bytes = b"{broken\n".to_vec();
        bytes.extend(vec![b'x'; 262145]);
        bytes.extend_from_slice(b"\n{\"type\":\"quit\"}\n");
        let mut input = std::io::Cursor::new(bytes);
        for _ in 0..2 {
            assert_eq!(read_json_line(&mut input).unwrap()["type"], "invalid_json");
        }
        assert_eq!(read_json_line(&mut input).unwrap()["type"], "quit");
        assert!(read_json_line(&mut input).is_none());
        let mut tail = std::io::Cursor::new(b"{\"type\":\"quit\"}");
        assert_eq!(read_json_line(&mut tail).unwrap()["type"], "quit");
        assert!(read_json_line(&mut tail).is_none());
    }
}
