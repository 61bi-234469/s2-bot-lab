//! JSON-lines front end for `cold_clear_2_s2::spike_stress`. One request per stdin line, one
//! response per stdout line.
//!   {"mode":"search", ...position, "spike":20, "settings":[[8,8],[32,12]], "known":14}
//!   {"mode":"garbage-ops", ...queue, "ops":[{"op":"cancel","amount":3,"pieces":5},{"op":"tank","frame":900}]}
//!   {"mode":"insert", "occupancy":[..10], "g":[..10], "holes":[3,3,7]}
//!   {"mode":"children", ...position, "spike":0} -> every child of one lock (for the JS comparison)
//!   {"mode":"batch", "requests":[{...a search request}, ...]} -> {"id", "replies":[{"id", "results"}, ...]}: each
//!     search on its own thread with its own multiplier table, replies in request order, each identical to the
//!     reply "search" gives.
use cold_clear_2_s2::data::{Board, Piece};
use cold_clear_2_s2::native_s2::Chain;
use cold_clear_2_s2::spike_stress::{
    children_of, inject_spike, insert_garbage_row, spike_stress_search, GarbageQueue, Multiplier, Packet, Position, Rng,
};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::Instant;

fn u(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap_or_else(|| panic!("missing {k}"))
}
fn i(v: &Value, k: &str) -> i64 {
    v[k].as_i64().unwrap_or_else(|| panic!("missing {k}"))
}
fn piece(v: &Value) -> Option<Piece> {
    v.as_str().map(|s| serde_json::from_value(json!(s)).unwrap_or_else(|_| panic!("bad piece {s}")))
}
fn cols(v: &Value) -> Board {
    let a = v.as_array().expect("columns");
    let mut b = Board { cols: [0; 10] };
    for x in 0..10 {
        b.cols[x] = a[x].as_u64().expect("column");
    }
    b
}
fn queue(v: &Value) -> GarbageQueue {
    let last = i(v, "lastColumn");
    GarbageQueue {
        packets: v["packets"].as_array().expect("packets").iter()
            .map(|p| Packet { amount: u(p, "amount") as u32, frame: i(p, "frame") }).collect(),
        rng: Rng::new(u(v, "rng")),
        last_column: if last < 0 { None } else { Some(last as u8) },
        has_changed_column: v["hasChangedColumn"].as_bool().expect("hasChangedColumn"),
        sent: u(v, "sent"),
        received: u(v, "received"),
    }
}
fn queue_json(q: &GarbageQueue) -> Value {
    json!({ "packets": q.packets.iter().map(|p| json!({"amount": p.amount, "frame": p.frame})).collect::<Vec<_>>(),
        "rng": q.rng.value, "lastColumn": q.last_column.map_or(-1, i64::from), "hasChangedColumn": q.has_changed_column,
        "sent": q.sent, "received": q.received })
}

fn position_of(v: &Value) -> Position {
    Position {
        board: cols(&v["occupancy"]),
        materialized_g: cols(&v["g"]),
        current: piece(&v["current"]).expect("current"),
        hold: piece(&v["hold"]),
        hold_available: v["holdAvailable"].as_bool().expect("holdAvailable"),
        known: v["known"].as_array().expect("known").iter().map(|p| piece(p).expect("known piece")).collect(),
        chain: Chain { combo: u(v, "combo") as u32, b2b: u(v, "b2b") as u32 },
        garbage: queue(v),
        frame: i(v, "frame"),
        pieces_placed: u(v, "piecesPlaced"),
    }
}

/// The `results` of one "search" request.
fn search_results(v: &Value, mult: &mut Multiplier) -> Vec<Value> {
    let mut position = position_of(v);
    let spike = v["spike"].as_u64().unwrap_or(20) as u32;
    if spike > 0 {
        inject_spike(&mut position, spike);
    }
    let known = v["known_cap"].as_u64().unwrap_or(14) as usize;
    v["settings"].as_array().expect("settings").iter().map(|s| {
        let (w, h) = (s[0].as_u64().expect("width") as usize, s[1].as_u64().expect("horizon") as usize);
        let t0 = Instant::now();
        let o = spike_stress_search(&position, h, w, known, mult);
        json!({ "width": w, "horizon": h, "F": o.reduced_height(), "survived": o.survived,
            "finalHeight": o.final_height, "finalHoles": o.final_holes, "finalPending": o.final_pending,
            "aliveDepth": o.alive_depth, "peak": o.peak, "sent": o.sent, "cancelled": o.cancelled, "attack": o.attack,
            "expanded": o.expanded, "us": t0.elapsed().as_micros() as u64 })
    }).collect()
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout());
    let mut mult = Multiplier::new();
    for line in stdin.lock().lines() {
        let line = line.expect("stdin");
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).expect("json");
        let id = v["id"].clone();
        let response = match v["mode"].as_str().unwrap_or("search") {
            "garbage-ops" => {
                let mut q = queue(&v);
                let results: Vec<Value> = v["ops"].as_array().expect("ops").iter().map(|op| match op["op"].as_str() {
                    Some("cancel") => { let (left, c) = q.cancel(u(op, "amount") as u32, u(op, "pieces")); json!([left, c]) }
                    Some("tank") => json!(q.tank(i(op, "frame"))),
                    _ => panic!("bad op"),
                }).collect();
                json!({ "id": id, "results": results, "queue": queue_json(&q) })
            }
            "insert" => {
                let (mut b, mut g) = (cols(&v["occupancy"]), cols(&v["g"]));
                for h in v["holes"].as_array().expect("holes") {
                    insert_garbage_row(&mut b, &mut g, h.as_u64().expect("hole") as u8);
                }
                json!({ "id": id, "occupancy": b.cols, "g": g.cols })
            }
            "children" => {
                let mut position = position_of(&v);
                let spike = v["spike"].as_u64().unwrap_or(20) as u32;
                if spike > 0 {
                    inject_spike(&mut position, spike);
                }
                let known = v["known_cap"].as_u64().unwrap_or(14) as usize;
                let children: Vec<Value> = children_of(&position, known, &mut mult).iter().map(|c| json!({
                    "hold": c.step.hold, "cells": c.step.cells, "spin": c.step.spin, "lines": c.step.lines,
                    "attack": c.step.attack, "sent": c.step.sent, "cancelled": c.step.cancelled, "tank": c.step.tank,
                    "occupancy": c.board.cols, "g": c.materialized_g.cols, "height": c.metrics.height,
                    "holes": c.metrics.holes, "pending": c.metrics.pending, "b2b": c.b2b, "combo": c.combo,
                    "queue": queue_json(&c.garbage) })).collect();
                json!({ "id": id, "children": children })
            }
            "search" => json!({ "id": id, "results": search_results(&v, &mut mult) }),
            "batch" => {
                let requests = v["requests"].as_array().expect("requests");
                let replies: Vec<Value> = std::thread::scope(|scope| {
                    let handles: Vec<_> = requests.iter().map(|r| scope.spawn(move || {
                        assert_eq!(r["mode"].as_str().unwrap_or("search"), "search", "batch holds search requests only");
                        json!({ "id": r["id"].clone(), "results": search_results(r, &mut Multiplier::new()) })
                    })).collect();
                    handles.into_iter().map(|h| h.join().expect("batch search thread")).collect()
                });
                json!({ "id": id, "replies": replies })
            }
            other => panic!("bad mode {other}"),
        };
        writeln!(out, "{response}").expect("stdout");
        out.flush().expect("flush");
    }
}
