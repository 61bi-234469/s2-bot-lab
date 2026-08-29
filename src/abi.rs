//! One request/response surface over the crate, shared by the native build and
//! the `wasm32-unknown-unknown` build.
//!
//! SIM-005 requires that a native test and a WASM test run the same fixtures.
//! That only means something if both legs enter the crate through the same
//! door: two entry points could drift and still both pass. [`dispatch`] is that
//! door, and the `s2_*` exports below are the raw-memory wrapper the WASM leg
//! calls it through.
//!
//! The wire format is JSON in, JSON out. `s2_invoke` returns a pointer to a
//! little-endian `u32` byte length followed by that many response bytes; the
//! caller frees it with `s2_dealloc(pointer, 4 + length)`. Nothing in the
//! signature depends on `wasm-bindgen`, so the WASM artifact needs no
//! generated JavaScript glue and no toolchain beyond `cargo` and a target.

use serde_json::{Value, json};

use crate::{
    cs1,
    fallback_policy::assess_fallback,
    fixture::Fixture,
    simulator::{GarbagePacket, GarbageState, receive_garbage},
    state_key::{current_piece_structural_key, full_state_key, hold_aware_move_generation_key},
};

/// Runs one request. Errors are values, not panics: a runtime that traps on the
/// way out tells us nothing about which side disagreed.
pub fn dispatch(request: &Value) -> Value {
    match execute(request) {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(code) => json!({ "ok": false, "error": code }),
    }
}

fn execute(request: &Value) -> Result<Value, &'static str> {
    match request["op"].as_str().ok_or("missing-op")? {
        "cs1-canonicalize" => {
            let bytes = cs1::canonicalize(&request["value"]).map_err(|error| error.code())?;
            Ok(json!(
                String::from_utf8(bytes).map_err(|_| "canonical-output-not-utf8")?
            ))
        }
        "cs1-hash" => Ok(json!(
            cs1::hash(&request["value"]).map_err(|error| error.code())?
        )),
        "state-key" => {
            let state = &request["state"];
            let key = match request["kind"].as_str().ok_or("missing-state-key-kind")? {
                "full-state" => full_state_key(state),
                "current-piece" => current_piece_structural_key(state),
                "hold-aware" => hold_aware_move_generation_key(state),
                _ => return Err("unknown-state-key-kind"),
            };
            Ok(json!(key.map_err(|error| error.code())?))
        }
        "fixture-validate" => {
            let fixture: Fixture = serde_json::from_value(request["fixture"].clone())
                .map_err(|_| "fixture-invalid-json")?;
            fixture.validate().map_err(|error| error.code())?;
            Ok(json!({
                "id": fixture.id,
                "rulesetId": fixture.ruleset_id,
                "evidenceLayer": fixture.evidence_layer,
                "coverageCells": fixture.coverage_cells,
                "hash": fixture.hash,
            }))
        }
        "fallback-assess" => {
            let assessment = assess_fallback(
                request["operation"]
                    .as_str()
                    .ok_or("missing-fallback-operation")?,
                &request["state"],
                &request["engine"],
                &request["manifest"],
                request["userSelected"] == Value::Bool(true),
            )
            .map_err(|error| error.code())?;
            serde_json::to_value(assessment).map_err(|_| "assessment-not-serializable")
        }
        "garbage-receive" => {
            let state: GarbageState = serde_json::from_value(request["state"].clone())
                .map_err(|_| "garbage-state-invalid")?;
            let packet: GarbagePacket = serde_json::from_value(request["packet"].clone())
                .map_err(|_| "garbage-packet-invalid")?;
            let next = receive_garbage(&state, packet).map_err(|error| error.code())?;
            serde_json::to_value(next).map_err(|_| "garbage-state-not-serializable")
        }
        _ => Err("unknown-op"),
    }
}

fn dispatch_bytes(request: &[u8]) -> Vec<u8> {
    let response = match serde_json::from_slice::<Value>(request) {
        Ok(request) => dispatch(&request),
        Err(_) => json!({ "ok": false, "error": "request-invalid-json" }),
    };
    serde_json::to_vec(&response).expect("dispatch responses are plain JSON values")
}

/// Reserves `length` bytes the caller may write a request into.
#[unsafe(no_mangle)]
pub extern "C" fn s2_alloc(length: usize) -> *mut u8 {
    let mut buffer = vec![0_u8; length].into_boxed_slice();
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Releases a buffer obtained from [`s2_alloc`] or [`s2_invoke`].
///
/// # Safety
///
/// `pointer` must come from one of those two functions and `length` must be the
/// exact byte length that was reserved for it, which for an [`s2_invoke`]
/// result is `4 + payload_length`. Each buffer may be freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn s2_dealloc(pointer: *mut u8, length: usize) {
    if pointer.is_null() {
        return;
    }
    // SAFETY: both allocation paths return a boxed slice of exactly `length`
    // bytes, so reconstructing the same dynamically sized allocation preserves
    // the allocator layout without assuming anything about Vec capacity.
    let slice = std::ptr::slice_from_raw_parts_mut(pointer, length);
    drop(unsafe { Box::from_raw(slice) });
}

/// Runs one request and returns a length-prefixed response buffer.
///
/// # Safety
///
/// `pointer` must be readable for `length` bytes. The returned buffer is owned
/// by the caller and must be released with [`s2_dealloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn s2_invoke(pointer: *const u8, length: usize) -> *mut u8 {
    // SAFETY: the caller guarantees the request range is readable.
    let request = unsafe { std::slice::from_raw_parts(pointer, length) };
    let response = dispatch_bytes(request);

    let mut framed = Vec::with_capacity(4 + response.len());
    framed.extend_from_slice(&(response.len() as u32).to_le_bytes());
    framed.extend_from_slice(&response);
    // Boxing shrinks any spare Vec capacity, making the allocation layout
    // exactly `4 + payload_length` bytes for `s2_dealloc`.
    let mut framed = framed.into_boxed_slice();
    let pointer = framed.as_mut_ptr();
    std::mem::forget(framed);
    pointer
}
