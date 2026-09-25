use std::cell::RefCell;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::bot::{Bot, Statistics};
use crate::f14_compat::{
    driver::{F14Driver, F14RerankState},
    transport::{self as f14, Profile},
};

struct Driver {
    bot: Bot,
    stats: Statistics,
    limit: u64,
}

thread_local! {
    static DRIVER: RefCell<Option<Driver>> = const { RefCell::new(None) };
    static F14_DRIVER: RefCell<Option<F14Driver>> = const { RefCell::new(None) };
    static RETAINED_F14: RefCell<Option<F14RerankState>> = const { RefCell::new(None) };
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Start {
        config: Option<String>,
        #[serde(rename = "searchSelectionLimit")]
        search_selection_limit: Option<String>,
        #[serde(rename = "searchSeed")]
        search_seed: String,
        state: crate::tbp::Start,
    },
    F14Start {
        profile: Profile,
        request: Value,
    },
    F14InputSpeculateStart {
        profile: Profile,
        request: Value,
    },
    F14Rerank {
        request: Value,
    },
    Work {
        selections: u32,
    },
    Suggest,
    SuggestNow,
    F14Finish,
    F14FinishEarly,
    Stop,
}

#[no_mangle]
pub extern "C" fn cc2_alloc(length: usize) -> *mut u8 {
    if length == 0 {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0_u8; length].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn cc2_invoke(pointer: *const u8, length: usize) -> *mut u8 {
    let input = std::slice::from_raw_parts(pointer, length);
    let value = std::str::from_utf8(input)
        .map_err(|_| "request-utf8")
        .and_then(|text| serde_json::from_str::<Request>(text).map_err(|_| "request-json"))
        .and_then(handle_request);
    encode(match value {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    })
}

#[no_mangle]
pub unsafe extern "C" fn cc2_dealloc(pointer: *mut u8, length: usize) {
    if length != 0 {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )));
    }
}

fn handle_request(request: Request) -> Result<Value, &'static str> {
    match request {
        Request::Start { config, search_selection_limit, search_seed, state } => {
            RETAINED_F14.with(|slot| *slot.borrow_mut() = None);
            let limit = match search_selection_limit {
                Some(value) => {
                    let value = value.parse::<u64>().map_err(|_| "selection-limit")?;
                    if value == 0 || value == u64::MAX { return Err("selection-limit"); }
                    value
                }
                None => u64::MAX,
            };
            let seed = search_seed.parse::<u64>().map_err(|_| "search-seed")?;
            let mut config: crate::BotConfig = match config {
                Some(text) => serde_json::from_str(&text).map_err(|_| "config-json")?,
                None => Default::default(),
            };
            config.search_selection_limit = limit;
            config.search_seed = seed;
            let bot = super::create_bot(state, Arc::new(config))
                .map_err(|_| "s2-amount-only-start-admission")?;
            F14_DRIVER.with(|slot| *slot.borrow_mut() = None);
            DRIVER.with(|slot| *slot.borrow_mut() = Some(Driver { bot, stats: Statistics::default(), limit }));
            Ok(Value::Null)
        }
        Request::F14Start { profile, request } => {
            RETAINED_F14.with(|slot| *slot.borrow_mut() = None);
            let driver = match F14Driver::start(profile, request) {
                Ok(driver) => driver,
                Err(response) => {
                    DRIVER.with(|slot| *slot.borrow_mut() = None);
                    F14_DRIVER.with(|slot| *slot.borrow_mut() = None);
                    return Ok(response);
                }
            };
            DRIVER.with(|slot| *slot.borrow_mut() = None);
            F14_DRIVER.with(|slot| *slot.borrow_mut() = Some(driver));
            Ok(Value::Null)
        }
        Request::F14InputSpeculateStart { profile, request } => {
            RETAINED_F14.with(|slot| *slot.borrow_mut() = None);
            let driver = match F14Driver::start_input_speculation(profile, request) {
                Ok(driver) => driver,
                Err(response) => {
                    DRIVER.with(|slot| *slot.borrow_mut() = None);
                    F14_DRIVER.with(|slot| *slot.borrow_mut() = None);
                    return Ok(response);
                }
            };
            DRIVER.with(|slot| *slot.borrow_mut() = None);
            F14_DRIVER.with(|slot| *slot.borrow_mut() = Some(driver));
            Ok(Value::Null)
        }
        Request::Work { selections } => {
            if selections == 0 || selections > 1024 { return Err("work-selections"); }
            if let Some(progress) = F14_DRIVER.with(|slot| {
                let mut slot = slot.borrow_mut();
                slot.as_mut().map(|driver| driver.work(selections))
            }) {
                return Ok(json!({
                    "nodes": progress.nodes,
                    "selections": progress.selections,
                    "complete": progress.complete,
                }));
            }
            DRIVER.with(|slot| {
                let mut slot = slot.borrow_mut();
                let driver = slot.as_mut().ok_or("no-active-bot")?;
                let target = driver.stats.selections.saturating_add(selections as u64).min(driver.limit);
                while driver.stats.selections < target {
                    let before = driver.stats.selections;
                    let stats = driver.bot.do_work().map_err(|_| "chain-overflow")?;
                    driver.stats.accumulate(stats);
                    if driver.stats.selections == before {
                        break;
                    }
                }
                Ok(json!({ "nodes": driver.stats.nodes, "selections": driver.stats.selections, "complete": driver.stats.selections >= driver.limit }))
            })
        }
        Request::Suggest => DRIVER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let driver = slot.as_mut().ok_or("no-active-bot")?;
            while driver.stats.selections < driver.limit {
                let stats = driver.bot.do_work().map_err(|_| "chain-overflow")?;
                driver.stats.accumulate(stats);
            }
            suggestion(driver, "fixed selection budget complete")
        }),
        Request::SuggestNow => DRIVER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let driver = slot.as_mut().ok_or("no-active-bot")?;
            suggestion(driver, "time budget complete")
        }),
        Request::F14Finish => F14_DRIVER.with(|slot| {
            let driver = slot.borrow_mut().take().ok_or("no-active-bot")?;
            let (response, retained) = driver.finish_with_retained();
            RETAINED_F14.with(|slot| *slot.borrow_mut() = retained);
            Ok(response)
        }),
        Request::F14FinishEarly => F14_DRIVER.with(|slot| {
            let driver = slot.borrow_mut().take().ok_or("no-active-bot")?;
            let (response, retained) = driver.finish_early_with_retained();
            RETAINED_F14.with(|slot| *slot.borrow_mut() = retained);
            Ok(response)
        }),
        Request::F14Rerank { request } => {
            let retained = RETAINED_F14.with(|slot| slot.borrow().clone());
            match retained {
                Some(retained) => Ok(f14::rerank_retained(
                    request,
                    &retained.request,
                    &retained.profile,
                    &retained.outcome,
                    retained.input_speculation,
                )),
                None => Ok(f14::rerank_without_retained(request)),
            }
        }
        Request::Stop => {
            DRIVER.with(|slot| *slot.borrow_mut() = None);
            F14_DRIVER.with(|slot| *slot.borrow_mut() = None);
            RETAINED_F14.with(|slot| *slot.borrow_mut() = None);
            Ok(Value::Null)
        }
    }
}

fn suggestion(driver: &mut Driver, extra: &'static str) -> Result<Value, &'static str> {
    let candidates = driver.bot.suggest();
    let (moves, candidate_values): (Vec<_>, Vec<_>) = candidates.into_iter().unzip();
    let extra = match driver.bot.amount_only_extra_json(
        driver.stats.amount_top_out_omitted,
        moves.is_empty() && driver.stats.amount_top_out_omitted > 0,
    ) {
        Some(json) => format!("{extra} {json}"),
        None => extra.to_owned(),
    };
    Ok(json!({
        "moves": moves,
        "move_info": {
            "nodes": driver.stats.nodes,
            "selections": driver.stats.selections,
            "candidate_values": candidate_values,
            "extra": extra
        }
    }))
}

fn encode(value: Value) -> *mut u8 {
    let payload = serde_json::to_vec(&value)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"response-json"}"#.to_vec());
    let mut output = Vec::with_capacity(payload.len() + 4);
    output.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    output.extend_from_slice(&payload);
    Box::into_raw(output.into_boxed_slice()) as *mut u8
}
