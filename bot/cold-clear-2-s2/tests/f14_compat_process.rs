use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

fn profile() -> Value {
    json!({
        "profileId": "f14-amount-only-compat-a/1",
        "configHash": "sha256:12665e92fa86934d82b5fd909b1248954e267d4e5c8fcafb0c23024938d1a769",
        "seed": "1395802947",
        "workerConcurrency": 1,
        "budget": { "mode": "selection", "selections": 8, "maxMillis": 30000 }
    })
}

fn empty_board() -> Vec<Vec<Option<char>>> {
    vec![vec![None; 10]; 40]
}

fn spawn_stdout_reader(stdout: std::process::ChildStdout) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    rx
}

fn recv_json(rx: &mpsc::Receiver<String>, timeout: Duration) -> Value {
    let line = rx.recv_timeout(timeout).expect("jsonl timeout");
    serde_json::from_str(line.trim()).expect("json")
}

fn wait_child(child: &mut std::process::Child, timeout: Duration) {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("child wait timed out");
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => panic!("child wait: {error}"),
        }
    }
}

#[test]
fn f14_compat_process_selects_without_native_feature() {
    let exe = env!("CARGO_BIN_EXE_cold-clear-2-s2");
    let mut child = Command::new(exe)
        .arg("--f14-compat-profile")
        .arg(profile().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn f14 binary");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = spawn_stdout_reader(child.stdout.take().expect("stdout"));
    let timeout = Duration::from_secs(30);
    let info = recv_json(&stdout, timeout);
    assert_eq!(info["type"], "info");
    assert_eq!(info["name"], "Cold Clear 2 S2");
    let features = info["features"].as_array().unwrap();
    assert!(features
        .iter()
        .any(|value| value == "s2-f14-amount-only-compat/1"));
    assert!(!features
        .iter()
        .any(|value| value == "s2-native-integrated/1"));
    assert!(info.get("nativeConfig").is_none());
    writeln!(stdin, "{}", json!({"type":"rules"})).unwrap();
    let ready = recv_json(&stdout, timeout);
    assert_eq!(ready["type"], "ready");
    writeln!(
        stdin,
        "{}",
        json!({"type":"f14_cancel","requestId":"f14-process-1","generation":1})
    )
    .unwrap();
    let cancelled = recv_json(&stdout, timeout);
    assert_eq!(cancelled["type"], "f14_cancelled");
    assert_eq!(cancelled["joined"], false);
    let request = json!({
        "type": "f14_decide",
        "schemaVersion": 1,
        "requestId": "f14-process-1",
        "positionId": "f14-process-opening",
        "generation": 1,
        "execution": profile(),
        "start": {
            "board": empty_board(),
            "queue": ["T","Z","I","O","J","L","S"],
            "hold": null,
            "combo": 0,
            "back_to_back": false,
            "b2b": 0,
            "randomizer": { "type": "seven_bag", "bag_state": [] }
        },
        "selector": {
            "rulesetId": "tetrio-s2-v19-2c47b3df945f6714449b92d1b44346ef4bf0e1a20e95be8ed10c28be75c66a60-beta-1-5-0",
            "board": {
                "fidelity": "exact",
                "width": 10,
                "height": 40,
                "visibleHeight": 20,
                "bufferHeight": 20,
                "cells": "_".repeat(400)
            },
            "pieces": {
                "current": "T",
                "hold": null,
                "holdAvailable": true,
                "known": ["Z","I","O","J","L","S"]
            },
            "chain": { "combo": 0, "b2b": 0 },
            "time": { "logicalFrame": 0, "piecesPlaced": 0, "fidelity": "exact", "frameSemantics": "engine-frame" },
            "incoming": { "pendingRows": 0, "dueThisLockRows": 0 }
        }
    });
    writeln!(stdin, "{request}").unwrap();
    let mut response = None;
    let started = Instant::now();
    while started.elapsed() < timeout {
        let remaining = timeout.saturating_sub(started.elapsed());
        match stdout.recv_timeout(remaining) {
            Ok(line) if line.trim().is_empty() => continue,
            Ok(line) => {
                let value: Value = serde_json::from_str(line.trim()).expect("decision json");
                if value["type"] == "f14_decision" {
                    response = Some(value);
                    break;
                }
            }
            Err(_) => break,
        }
    }
    writeln!(stdin, "{}", json!({"type":"quit"})).ok();
    drop(stdin);
    wait_child(&mut child, Duration::from_secs(10));
    let response = response.expect("f14_decision");
    assert_eq!(response["requestId"], "f14-process-1");
    assert_eq!(response["generation"], 1);
    assert_ne!(response["type"], "s2_decision");
    assert_eq!(response["status"], "move");
    assert_eq!(response["reason"], "selection-budget");
    assert!(response["selectedMove"]["location"]["type"].is_string());
    assert_eq!(response["search"]["requestedSelections"], 8);
    assert_eq!(response["search"]["actualSelections"], 8);
    let selected = response["selectedIdentity"]
        .as_str()
        .expect("selectedIdentity");
    let identities = response["ranking"]["identities"].as_array().unwrap();
    assert!(identities
        .iter()
        .any(|value| value.as_str() == Some(selected)));
}

fn opening_request(generation: u64, selections: u64) -> Value {
    json!({
        "type": "f14_decide",
        "schemaVersion": 1,
        "requestId": "f14-process-1",
        "positionId": "f14-process-opening",
        "generation": generation,
        "execution": {
            "profileId": "f14-amount-only-compat-a/1",
            "configHash": "sha256:12665e92fa86934d82b5fd909b1248954e267d4e5c8fcafb0c23024938d1a769",
            "seed": "1395802947",
            "workerConcurrency": 1,
            "budget": { "mode": "selection", "selections": selections, "maxMillis": 30000 }
        },
        "start": {
            "board": empty_board(),
            "queue": ["T","Z","I","O","J","L","S"],
            "hold": null,
            "combo": 0,
            "back_to_back": false,
            "b2b": 0,
            "randomizer": { "type": "seven_bag", "bag_state": [] }
        },
        "selector": {
            "rulesetId": "tetrio-s2-v19-2c47b3df945f6714449b92d1b44346ef4bf0e1a20e95be8ed10c28be75c66a60-beta-1-5-0",
            "board": {
                "fidelity": "exact",
                "width": 10,
                "height": 40,
                "visibleHeight": 20,
                "bufferHeight": 20,
                "cells": "_".repeat(400)
            },
            "pieces": {
                "current": "T",
                "hold": null,
                "holdAvailable": true,
                "known": ["Z","I","O","J","L","S"]
            },
            "chain": { "combo": 0, "b2b": 0 },
            "time": { "logicalFrame": 0, "piecesPlaced": 0, "fidelity": "exact", "frameSemantics": "engine-frame" },
            "incoming": { "pendingRows": 0, "dueThisLockRows": 0 }
        }
    })
}

#[test]
fn f14_compat_process_cancel_during_search_returns_cancelled() {
    let mut long_profile = profile();
    long_profile["budget"]["selections"] = json!(1_000_000);
    let exe = env!("CARGO_BIN_EXE_cold-clear-2-s2");
    let mut child = Command::new(exe)
        .arg("--f14-compat-profile")
        .arg(long_profile.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn f14 binary");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = spawn_stdout_reader(child.stdout.take().expect("stdout"));
    let timeout = Duration::from_secs(30);
    let info = recv_json(&stdout, timeout);
    assert_eq!(info["type"], "info");
    writeln!(stdin, "{}", json!({"type":"rules"})).unwrap();
    let ready = recv_json(&stdout, timeout);
    assert_eq!(ready["type"], "ready");
    writeln!(stdin, "{}", opening_request(1, 1_000_000)).unwrap();
    thread::sleep(Duration::from_millis(50));
    writeln!(
        stdin,
        "{}",
        json!({"type":"f14_cancel","requestId":"f14-process-1","generation":1})
    )
    .unwrap();
    let mut cancelled = None;
    let mut decision = None;
    let started = Instant::now();
    while started.elapsed() < timeout && (cancelled.is_none() || decision.is_none()) {
        let remaining = timeout.saturating_sub(started.elapsed());
        match stdout.recv_timeout(remaining.min(Duration::from_secs(2))) {
            Ok(line) if line.trim().is_empty() => continue,
            Ok(line) => {
                let value: Value = serde_json::from_str(line.trim()).expect("json");
                match value["type"].as_str() {
                    Some("f14_cancelled") => cancelled = Some(value),
                    Some("f14_decision") => decision = Some(value),
                    _ => {}
                }
            }
            Err(_) => break,
        }
    }
    writeln!(stdin, "{}", json!({"type":"quit"})).ok();
    drop(stdin);
    wait_child(&mut child, Duration::from_secs(10));
    let cancelled = cancelled.expect("f14_cancelled");
    assert_eq!(cancelled["joined"], true);
    if let Some(decision) = decision {
        assert_eq!(decision["status"], "incomplete");
        assert_eq!(decision["reason"], "cancelled");
        assert!(decision["selectedMove"].is_null());
        assert_ne!(decision["status"], "move");
    }
}

#[test]
fn f14_compat_process_does_not_emit_stale_generation() {
    let mut long_profile = profile();
    long_profile["budget"]["selections"] = json!(1_000_000);
    let exe = env!("CARGO_BIN_EXE_cold-clear-2-s2");
    let mut child = Command::new(exe)
        .arg("--f14-compat-profile")
        .arg(long_profile.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn f14 binary");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = spawn_stdout_reader(child.stdout.take().expect("stdout"));
    let timeout = Duration::from_secs(30);
    let _info = recv_json(&stdout, timeout);
    writeln!(stdin, "{}", json!({"type":"rules"})).unwrap();
    let ready = recv_json(&stdout, timeout);
    assert_eq!(ready["type"], "ready");
    writeln!(stdin, "{}", opening_request(1, 1_000_000)).unwrap();
    thread::sleep(Duration::from_millis(50));
    writeln!(
        stdin,
        "{}",
        json!({"type":"f14_cancel","requestId":"f14-process-1","generation":1})
    )
    .unwrap();
    let mut saw_generation_one_move = false;
    let started = Instant::now();
    while started.elapsed() < timeout {
        match stdout.recv_timeout(Duration::from_millis(200)) {
            Ok(line) if line.trim().is_empty() => continue,
            Ok(line) => {
                let value: Value = serde_json::from_str(line.trim()).expect("json");
                if value["type"] == "f14_decision"
                    && value["generation"] == 1
                    && value["status"] == "move"
                {
                    saw_generation_one_move = true;
                }
                if value["type"] == "f14_cancelled" {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    writeln!(stdin, "{}", json!({"type":"quit"})).ok();
    drop(stdin);
    wait_child(&mut child, Duration::from_secs(10));
    assert!(!saw_generation_one_move);
}
