use std::collections::VecDeque;
use std::sync::Arc;

use enum_dispatch::enum_dispatch;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::data::{GameState, Piece, Placement};

mod freestyle;

use self::freestyle::Freestyle;

pub struct Bot {
    options: BotOptions,
    current: GameState,
    queue: VecDeque<Piece>,
    mode: ModeEnum,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BotConfig {
    pub freestyle_weights: freestyle::Weights,
    pub freestyle_exploitation: f64,
    /// Number of root candidates exposed to the S2 canonical reranker.
    pub suggestion_count: usize,
    /// Exact number of tree selections before a deterministic suggestion.
    pub search_selection_limit: u64,
    /// Seed for the single search worker's exploration choices.
    pub search_seed: u64,
    /// Adds source-qualified direct-180 edges to the native proposal frontier.
    ///
    /// This remains disabled for every existing configuration unless a candidate
    /// configuration explicitly enables it.
    #[serde(default)]
    pub enable_direct_180: bool,
    /// Recover an empty root frontier through the hidden spawn buffer.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_spawn_buffer_entry: bool,
}

fn is_false(value: &bool) -> bool { !*value }

impl Default for BotConfig {
    fn default() -> Self {
        static DEFAULT: Lazy<BotConfig> =
            Lazy::new(|| serde_json::from_str(include_str!("default.json")).unwrap());
        DEFAULT.clone()
    }
}

#[derive(Debug)]
pub struct BotOptions {
    pub speculate: bool,
    pub config: Arc<BotConfig>,
}

#[enum_dispatch]
enum ModeEnum {
    Freestyle,
}

#[enum_dispatch(ModeEnum)]
trait Mode {
    fn advance(&mut self, options: &BotOptions, mv: Placement) -> Option<ModeSwitch>;
    fn new_piece(&mut self, options: &BotOptions, piece: Piece);
    fn suggest(&self, options: &BotOptions) -> Vec<(Placement, f32)>;
    fn do_work(&self, options: &BotOptions) -> Statistics;
}

enum ModeSwitch {
    Freestyle,
}

impl Bot {
    pub fn new(options: BotOptions, root: GameState, queue: &[Piece]) -> Self {
        Bot {
            current: root,
            queue: queue.iter().copied().collect(),
            mode: Freestyle::new(&options, root, queue).into(),
            options,
        }
    }

    pub fn advance(&mut self, mv: Placement) {
        puffin::profile_function!();
        self.current.advance(self.queue.pop_front().unwrap(), mv);
        if let Some(to) = self.mode.advance(&self.options, mv) {
            self.switch(to);
        };
    }

    pub fn new_piece(&mut self, piece: Piece) {
        puffin::profile_function!();
        self.queue.push_back(piece);
        self.mode.new_piece(&self.options, piece);
    }

    pub fn suggest(&self) -> Vec<(Placement, f32)> {
        puffin::profile_function!();
        self.mode.suggest(&self.options)
    }

    pub fn do_work(&self) -> Statistics {
        puffin::profile_function!();
        self.mode.do_work(&self.options)
    }

    pub fn search_selection_limit(&self) -> u64 {
        self.options.config.search_selection_limit
    }

    fn switch(&mut self, to: ModeSwitch) {
        puffin::profile_function!();
        match to {
            ModeSwitch::Freestyle => {
                self.mode =
                    Freestyle::new(&self.options, self.current, self.queue.make_contiguous()).into()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::BotConfig;

    #[test]
    fn s2_candidate_default_exposes_a_bounded_root_set() {
        let config = BotConfig::default();
        assert_eq!(config.suggestion_count, 16);
        assert_eq!(config.search_selection_limit, u64::MAX);
        assert_eq!(config.search_seed, 0x5332_4343_3200_0001);
        assert!(!config.enable_direct_180);
    }

    #[test]
    fn direct_180_config_flag_is_backward_compatible_and_opt_in() {
        let mut value = serde_json::to_value(BotConfig::default()).unwrap();
        value.as_object_mut().unwrap().remove("enable_direct_180");
        let omitted: BotConfig = serde_json::from_value(value.clone()).unwrap();
        assert!(!omitted.enable_direct_180);

        value.as_object_mut().unwrap().insert(
            "enable_direct_180".to_owned(),
            serde_json::Value::Bool(true),
        );
        let enabled: BotConfig = serde_json::from_value(value).unwrap();
        assert!(enabled.enable_direct_180);
    }

    #[test]
    fn spawn_buffer_entry_is_opt_in_and_false_preserves_serialized_shape() {
        let original = serde_json::to_value(BotConfig::default()).unwrap();
        assert!(original.get("enable_spawn_buffer_entry").is_none());
        let omitted: BotConfig = serde_json::from_value(original.clone()).unwrap();
        assert!(!omitted.enable_spawn_buffer_entry);
        for enabled in [false, true] {
            let mut value = original.clone();
            value["enable_spawn_buffer_entry"] = enabled.into();
            let config: BotConfig = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(config.enable_spawn_buffer_entry, enabled);
            assert_eq!(serde_json::to_value(config).unwrap(), if enabled { value } else { original.clone() });
        }
    }
}

#[derive(Copy, Clone, Debug)]
pub struct Statistics {
    pub nodes: u64,
    pub selections: u64,
    pub expansions: u64,
}

impl Default for Statistics {
    fn default() -> Self {
        Statistics {
            nodes: 0,
            selections: 0,
            expansions: 0,
        }
    }
}

impl Statistics {
    pub fn accumulate(&mut self, other: Self) {
        self.nodes += other.nodes;
        self.selections += other.selections;
        self.expansions += other.expansions;
    }
}
