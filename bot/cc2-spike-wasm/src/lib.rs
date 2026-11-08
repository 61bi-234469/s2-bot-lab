//! The spike-stress search of `cold_clear_2_s2::spike_stress` as an import-free WASM module, for rule RG in the
//! browser.
//!
//! The ABI has the shape of the champion WASM's (`cc2_alloc` / `cc2_invoke` / `cc2_dealloc`), under its own names:
//! `spike_alloc(length)`, `spike_invoke(pointer, length)` -> a pointer to a little-endian u32 length followed by that
//! many bytes of JSON, and `spike_dealloc(pointer, length)` (length + 4 for a response). A response is
//! `{"ok": true, "value": ...}` or `{"ok": false, "error": "..."}`.
//!
//! Requests are the spike-stress JSON lines of `cold_clear_2_s2::spike_stress`, modes "search" and "batch" only.
//! The value is the native reply without the per-setting `us` (this module has no clock; the caller times it):
//!   {"mode":"search", ...} -> {"id", "results"}: one Multiplier table kept across calls, as the CLI keeps one;
//!   {"mode":"batch", "requests":[...]} -> {"id", "replies":[{"id", "results"}, ...]}: the requests in order, each
//!     with its own table (the CLI runs them on threads; one WASM instance runs them one after another).
//! The hole RNG is an input: callers acting for the bot must pass a public value, never the referee's own.
use cold_clear_2_s2::data::{Board, Piece};
use cold_clear_2_s2::native_s2::Chain;
use cold_clear_2_s2::spike_stress::{inject_spike, spike_stress_search, GarbageQueue, Multiplier, Packet, Position, Rng};
use serde_json::{json, Value};
use std::cell::RefCell;

type R<T> = Result<T, String>;

fn u(v: &Value, k: &str) -> R<u64> {
    v[k].as_u64().ok_or_else(|| format!("missing {k}"))
}
fn i(v: &Value, k: &str) -> R<i64> {
    v[k].as_i64().ok_or_else(|| format!("missing {k}"))
}
fn piece(v: &Value) -> R<Option<Piece>> {
    match v.as_str() {
        None => Ok(None),
        Some(s) => serde_json::from_value(json!(s)).map(Some).map_err(|_| format!("bad piece {s}")),
    }
}
fn cols(v: &Value) -> R<Board> {
    let a = v.as_array().filter(|a| a.len() == 10).ok_or("columns")?;
    let mut b = Board { cols: [0; 10] };
    for x in 0..10 {
        b.cols[x] = a[x].as_u64().ok_or("column")?;
    }
    Ok(b)
}
fn queue(v: &Value) -> R<GarbageQueue> {
    let last = i(v, "lastColumn")?;
    let packets = v["packets"].as_array().ok_or("packets")?.iter()
        .map(|p| Ok(Packet { amount: u(p, "amount")? as u32, frame: i(p, "frame")? }))
        .collect::<R<Vec<_>>>()?;
    Ok(GarbageQueue {
        packets,
        rng: Rng::new(u(v, "rng")?),
        last_column: if last < 0 { None } else { Some(last as u8) },
        has_changed_column: v["hasChangedColumn"].as_bool().ok_or("hasChangedColumn")?,
        sent: u(v, "sent")?,
        received: u(v, "received")?,
    })
}
fn position_of(v: &Value) -> R<Position> {
    Ok(Position {
        board: cols(&v["occupancy"])?,
        materialized_g: cols(&v["g"])?,
        current: piece(&v["current"])?.ok_or("current")?,
        hold: piece(&v["hold"])?,
        hold_available: v["holdAvailable"].as_bool().ok_or("holdAvailable")?,
        known: v["known"].as_array().ok_or("known")?.iter()
            .map(|p| piece(p)?.ok_or_else(|| "known piece".to_string())).collect::<R<Vec<_>>>()?,
        chain: Chain { combo: u(v, "combo")? as u32, b2b: u(v, "b2b")? as u32 },
        garbage: queue(v)?,
        frame: i(v, "frame")?,
        pieces_placed: u(v, "piecesPlaced")?,
    })
}

/// The `results` of one "search" request: the CLI's `search_results` without `us`.
fn search_results(v: &Value, mult: &mut Multiplier) -> R<Vec<Value>> {
    let mut position = position_of(v)?;
    let spike = v["spike"].as_u64().unwrap_or(20) as u32;
    if spike > 0 {
        inject_spike(&mut position, spike);
    }
    let known = v["known_cap"].as_u64().unwrap_or(14) as usize;
    v["settings"].as_array().ok_or("settings")?.iter().map(|s| {
        let w = s[0].as_u64().ok_or("width")? as usize;
        let h = s[1].as_u64().ok_or("horizon")? as usize;
        let o = spike_stress_search(&position, h, w, known, mult);
        Ok(json!({ "width": w, "horizon": h, "F": o.reduced_height(), "survived": o.survived,
            "finalHeight": o.final_height, "finalHoles": o.final_holes, "finalPending": o.final_pending,
            "aliveDepth": o.alive_depth, "peak": o.peak, "sent": o.sent, "cancelled": o.cancelled, "attack": o.attack,
            "expanded": o.expanded }))
    }).collect()
}

thread_local! {
    static MULT: RefCell<Option<Multiplier>> = const { RefCell::new(None) };
}

fn handle(v: &Value) -> R<Value> {
    let id = v["id"].clone();
    match v["mode"].as_str().unwrap_or("search") {
        "search" => MULT.with(|m| {
            let mut m = m.borrow_mut();
            let mult = m.get_or_insert_with(Multiplier::new);
            Ok(json!({ "id": id, "results": search_results(v, mult)? }))
        }),
        "batch" => {
            let replies = v["requests"].as_array().ok_or("requests")?.iter().map(|r| {
                if r["mode"].as_str().unwrap_or("search") != "search" {
                    return Err("batch holds search requests only".to_string());
                }
                Ok(json!({ "id": r["id"].clone(), "results": search_results(r, &mut Multiplier::new())? }))
            }).collect::<R<Vec<_>>>()?;
            Ok(json!({ "id": id, "replies": replies }))
        }
        other => Err(format!("bad mode {other}")),
    }
}

/// The value of one request line (the native path of the unit test; the WASM ABI wraps it).
pub fn invoke_json(text: &str) -> Value {
    let value = serde_json::from_str::<Value>(text).map_err(|_| "request-json".to_string()).and_then(|v| handle(&v));
    match value {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[no_mangle]
pub extern "C" fn spike_alloc(length: usize) -> *mut u8 {
    if length == 0 {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0_u8; length].into_boxed_slice()) as *mut u8
}

/// # Safety
/// `pointer` must come from `spike_alloc(length)` and hold `length` initialised bytes.
#[no_mangle]
pub unsafe extern "C" fn spike_invoke(pointer: *const u8, length: usize) -> *mut u8 {
    let input = std::slice::from_raw_parts(pointer, length);
    let value = match std::str::from_utf8(input) {
        Ok(text) => invoke_json(text),
        Err(_) => json!({ "ok": false, "error": "request-utf8" }),
    };
    let payload = serde_json::to_vec(&value).unwrap_or_else(|_| br#"{"ok":false,"error":"response-json"}"#.to_vec());
    let mut output = Vec::with_capacity(payload.len() + 4);
    output.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    output.extend_from_slice(&payload);
    Box::into_raw(output.into_boxed_slice()) as *mut u8
}

/// # Safety
/// `pointer` and `length` must be an allocation of this module (`spike_alloc`, or a response with length + 4).
#[no_mangle]
pub unsafe extern "C" fn spike_dealloc(pointer: *mut u8, length: usize) {
    if length != 0 {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length)));
    }
}

#[cfg(test)]
mod tests {
    use super::invoke_json;

    #[test]
    fn bad_requests_answer_errors_instead_of_trapping() {
        assert_eq!(invoke_json("{")["error"], "request-json");
        assert_eq!(invoke_json(r#"{"mode":"children"}"#)["error"], "bad mode children");
        assert_eq!(invoke_json(r#"{"mode":"search","id":1}"#)["ok"], false);
    }
}
