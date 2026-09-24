use std::convert::Infallible;
#[cfg(target_arch = "wasm32")]
extern crate puffin_noop as puffin;
use std::sync::Arc;

use bot::BotOptions;
use enumset::EnumSet;
use futures::prelude::*;
use tbp::Randomizer;

use crate::bot::Bot;
use crate::data::{AdvanceError, GameState};
#[cfg(not(target_arch = "wasm32"))]
use crate::sync::BotSyncronizer;
use crate::tbp::{BotMessage, FrontendMessage};

mod bot;
mod dag;
mod generated_direct_180_kicks;
mod tbp;
#[macro_use]
pub mod data;
mod map;
pub(crate) mod time {
    #[cfg(not(target_arch = "wasm32"))]
    pub use std::time::Instant;
    #[cfg(target_arch = "wasm32")]
    pub use instant::Instant;
}
pub mod movegen;
// ADR-063 native S2 state/value contract; no transport feature is advertised.
pub mod native_s2;
// F14 amount-only selector port on the legacy TBP path, separate from the ADR-063 native route.
pub mod f14_compat;
pub mod s2_core;
pub mod s2_eval;
pub mod s2_search;
#[cfg(not(target_arch = "wasm32"))]
mod sync;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use bot::BotConfig;
pub use bot::diagnose_s2_conversion_shadow;
#[cfg(not(target_arch = "wasm32"))]
pub use bot::diagnose_s2_root_allocation;
pub use bot::diagnose_s2_root_priority;

#[cfg(not(target_arch = "wasm32"))]
pub async fn run(
    mut incoming: impl Stream<Item = FrontendMessage> + Unpin,
    mut outgoing: impl Sink<BotMessage, Error = Infallible> + Unpin,
    config: Arc<BotConfig>,
) {
    outgoing
        .send(BotMessage::Info {
            name: "Cold Clear 2 S2",
            version: concat!(env!("CARGO_PKG_VERSION"), " ", env!("GIT_HASH")),
            author: "MinusKelvin + s2-analysis-engine contributors",
            features: &[],
        })
        .await
        .unwrap();

    let bot = Arc::new(BotSyncronizer::new());

    spawn_workers(&bot);

    let mut waiting_on_first_piece = None;

    while let Some(msg) = incoming.next().await {
        match msg {
            FrontendMessage::Start(start) => {
                if start.hold.is_none() && start.queue.is_empty() {
                    waiting_on_first_piece = Some(start);
                } else {
                    bot.start(admit_bot(start, config.clone()));
                }
            }
            FrontendMessage::Stop => {
                bot.stop();
                waiting_on_first_piece = None;
            }
            FrontendMessage::Suggest => {
                let (moves, move_info) = bot.suggest();
                outgoing
                    .send(BotMessage::Suggestion { moves, move_info })
                    .await
                    .unwrap();
            }
            FrontendMessage::SuggestNow => {
                let (moves, move_info) = bot.suggest_now();
                outgoing
                    .send(BotMessage::Suggestion { moves, move_info })
                    .await
                    .unwrap();
            }
            FrontendMessage::Play { mv } => {
                match bot.try_advance(mv) {
                    Ok(()) => puffin::GlobalProfiler::lock().new_frame(),
                    Err(AdvanceError::ChainOverflow) => {
                        outgoing
                            .send(BotMessage::ProtocolError { reason: "chain-overflow" })
                            .await
                            .unwrap();
                        bot.stop();
                    }
                    Err(AdvanceError::InvalidIncoming) => {
                        outgoing
                            .send(BotMessage::ProtocolError { reason: "invalid-incoming" })
                            .await
                            .unwrap();
                        bot.stop();
                    }
                }
            }
            FrontendMessage::NewPiece { piece } => {
                if let Some(mut start) = waiting_on_first_piece.take() {
                    if let Randomizer::SevenBag { bag_state } = &mut start.randomizer {
                        if bag_state.is_empty() {
                            *bag_state = EnumSet::all();
                        }
                        bag_state.remove(piece);
                    }
                    start.queue.push(piece);
                    bot.start(admit_bot(start, config.clone()));
                } else {
                    bot.new_piece(piece);
                }
            }
            FrontendMessage::Rules => {
                outgoing.send(BotMessage::Ready).await.unwrap();
            }
            FrontendMessage::Quit => break,
            FrontendMessage::InvalidJson => {
                outgoing.send(BotMessage::ProtocolError { reason: "invalid-json" }).await.unwrap();
            }
            FrontendMessage::Unknown => {}
        }
    }
}

#[derive(Debug)]
pub struct StartAdmissionError;

impl std::fmt::Display for StartAdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("s2-amount-only-start-admission")
    }
}

impl std::error::Error for StartAdmissionError {}

fn admit_bot(start: tbp::Start, config: Arc<BotConfig>) -> Bot {
    match create_bot(start, config) {
        Ok(bot) => bot,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}

fn incoming_amounts(
    start: &tbp::Start,
    enabled: bool,
) -> Result<(u8, u8), StartAdmissionError> {
    if !enabled {
        return Ok((0, 0));
    }
    let value = start.s2_incoming.as_ref().ok_or(StartAdmissionError)?;
    if !value.is_object() {
        return Err(StartAdmissionError);
    }
    let amounts: tbp::S2IncomingAmounts =
        serde_json::from_value(value.clone()).map_err(|_| StartAdmissionError)?;
    if amounts.due_this_lock_rows > amounts.pending_rows
        || amounts.pending_rows > 255
        || amounts.due_this_lock_rows > 255
    {
        return Err(StartAdmissionError);
    }
    Ok((
        amounts.pending_rows as u8,
        amounts.due_this_lock_rows as u8,
    ))
}

pub(crate) fn create_bot(mut start: tbp::Start, config: Arc<BotConfig>) -> Result<Bot, StartAdmissionError> {
    config.validate().map_err(|_| StartAdmissionError)?;
    let (pending_incoming_rows, due_this_lock_rows) =
        incoming_amounts(&start, config.enable_s2_amount_only_incoming)?;
    let reserve = start.hold.unwrap_or_else(|| start.queue.remove(0));

    let speculate = matches!(start.randomizer, Randomizer::SevenBag { .. });
    let bag = match start.randomizer {
        Randomizer::Unknown => EnumSet::all(),
        Randomizer::SevenBag { mut bag_state } => {
            for &p in start.queue.iter().rev() {
                if bag_state == EnumSet::all() {
                    bag_state = EnumSet::empty();
                }
                bag_state.insert(p);
            }
            bag_state
        }
    };

    let state = GameState {
        reserve,
        b2b: if config.enable_s2_b2b_surge {
            start.b2b.unwrap_or(u32::from(start.back_to_back))
        } else {
            start.b2b
                .unwrap_or(u32::from(start.back_to_back))
                .min(u32::from(crate::data::B2B_SAT))
        },
        combo: start.combo.try_into().unwrap_or(255),
        bag,
        board: start.board.into(),
        pending_incoming_rows,
        due_this_lock_rows,
    };

    Ok(Bot::new(BotOptions { speculate, config }, state, &start.queue))
}

#[cfg(test)]
mod start_admission_tests {
    use super::{create_bot, StartAdmissionError};
    use crate::bot::BotConfig;
    use serde_json::json;
    use std::sync::Arc;

    fn start_value(incoming: Option<serde_json::Value>) -> serde_json::Value {
        let mut value = json!({
            "board": vec![vec![Option::<char>::None; 10]; 40],
            "queue": ["T", "I", "O"],
            "hold": null,
            "combo": 0,
            "back_to_back": false,
            "randomizer": { "type": "seven_bag", "bag_state": [] },
        });
        if let Some(incoming) = incoming {
            value["s2_incoming"] = incoming;
        }
        value
    }

    fn start_json(incoming: Option<serde_json::Value>) -> crate::tbp::Start {
        serde_json::from_value(start_value(incoming)).unwrap()
    }
    fn config(flag: bool) -> Arc<BotConfig> {
        let mut config = BotConfig::default();
        config.enable_s2_amount_only_incoming = flag;
        Arc::new(config)
    }
    fn config_with_surge() -> Arc<BotConfig> {
        let mut config = BotConfig::default();
        config.enable_s2_b2b_surge = true;
        Arc::new(config)
    }



    #[test]
    fn flag_off_ignores_well_formed_and_malformed_incoming() {
        for incoming in [
            None,
            Some(json!({"pending_rows": 4, "due_this_lock_rows": 2})),
            Some(json!({"pending_rows": "x"})),
            Some(json!({"pending_rows": 1, "packets": []})),
        ] {
            create_bot(start_json(incoming), config(false)).unwrap();
        }
    }


    #[test]
    fn start_b2b_forwards_exact_value_and_bool_is_missing_only_fallback() {
        let mut missing = start_value(None);
        missing["back_to_back"] = true.into();
        let fallback = create_bot(serde_json::from_value(missing).unwrap(), config(false)).unwrap();
        assert_eq!(fallback.current_b2b(), 1);

        for value in [4_u32, 5, u32::MAX] {
            let mut input = start_value(None);
            input["back_to_back"] = true.into();
            input["b2b"] = serde_json::json!(value);
            let bot = create_bot(serde_json::from_value(input).unwrap(), config_with_surge()).unwrap();
            assert_eq!(bot.current_b2b(), value);
        }
    }
    #[test]
    fn flag_on_rejects_illegal_incoming() {
        for incoming in [
            None,
            Some(json!("nope")),
            Some(json!({"pending_rows": 1})),
            Some(json!({"pending_rows": 1, "due_this_lock_rows": 2})),
            Some(json!({"pending_rows": 1, "due_this_lock_rows": 0, "packets": []})),
            Some(json!({"pending_rows": 256, "due_this_lock_rows": 0})),
        ] {
            let error = match create_bot(start_json(incoming), config(true)) {
                Ok(_) => panic!("illegal Start was admitted"),
                Err(error) => error,
            };
            assert_eq!(error.to_string(), StartAdmissionError.to_string());
        }
        create_bot(
            start_json(Some(json!({"pending_rows": 4, "due_this_lock_rows": 2}))),
            config(true),
        )
        .unwrap();
    }

    #[test]
    fn top_out_reward_without_edge_retention_is_rejected() {
        let mut config = BotConfig::default();
        config.enable_s2_amount_top_out_reward = true;
        assert!(create_bot(start_json(None), Arc::new(config)).is_err());
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn spawn_workers(bot: &Arc<BotSyncronizer>) {
    for _ in 0..1 {
        let bot = bot.clone();
        std::thread::spawn(move || bot.work_loop());
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn run_native(profile: native_s2::transport::Profile) -> std::io::Result<()> { sync::run_native(profile) }

pub mod s2_transport;
pub mod s2_audit;
#[cfg(not(target_arch = "wasm32"))]
pub fn run_integrated(profile: s2_transport::Profile) -> std::io::Result<()> { sync::run_integrated(profile) }

#[cfg(not(target_arch = "wasm32"))]
pub fn run_f14(profile: f14_compat::transport::Profile) -> std::io::Result<()> {
    let mut config: BotConfig = serde_json::from_str(profile.config_bytes()).expect("f14 bot config");
    config.search_seed = profile.seed_u64().expect("validated seed");
    config.search_selection_limit = profile.budget.selections;
    config.enable_s2_amount_only_incoming = false;
    let config = Arc::new(config);
    let bot = Arc::new(BotSyncronizer::new());
    spawn_workers(&bot);
    sync::run_f14(profile, config, bot)
}
#[cfg(not(target_arch = "wasm32"))]
pub fn read_frontend_message(input: &mut impl std::io::BufRead) -> Option<tbp::FrontendMessage> {
    tbp::read_json_line(input).map(|value| serde_json::from_value(value).unwrap_or(tbp::FrontendMessage::InvalidJson))
}
