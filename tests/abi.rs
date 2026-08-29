//! The native leg of SIM-005.
//!
//! Every assertion here is driven by a fixture file and reached through
//! [`abi::dispatch`], which is the same entry point the `wasm32-unknown-unknown`
//! artifact exports. `tests-js/wasm-parity.test.mjs` runs this corpus through
//! that artifact and compares against the same recorded values, so the two legs
//! differ only in the machine underneath.

use s2_analysis_engine::abi;
use serde::Deserialize;
use serde_json::{Value, json};

#[path = "support/mod.rs"]
mod support;

#[derive(Debug, Deserialize)]
struct Cs1Case {
    id: String,
    value: Value,
    canonical: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateKeyFixture {
    source_fixture: String,
    expected: StateKeyExpectation,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateKeyExpectation {
    full_state: String,
    current_piece: String,
    hold_aware: String,
}

fn value(request: Value) -> Value {
    let response = abi::dispatch(&request);
    assert_eq!(
        response["ok"], true,
        "{}: {}",
        request["op"], response["error"]
    );
    response["value"].clone()
}

fn error(request: Value) -> String {
    let response = abi::dispatch(&request);
    assert_eq!(response["ok"], false, "expected {} to fail", request["op"]);
    response["error"]
        .as_str()
        .expect("error codes are strings")
        .to_owned()
}

#[test]
fn abi_canonicalizes_the_cross_runtime_cs1_cases() {
    let cases: Vec<Cs1Case> = support::read_json("fixtures/cross-runtime/cs1.json");
    assert!(!cases.is_empty());

    for case in cases {
        let request = json!({ "op": "cs1-canonicalize", "value": case.value });
        match (&case.canonical, &case.error) {
            (Some(canonical), None) => assert_eq!(&value(request), canonical, "{}", case.id),
            (None, Some(code)) => assert_eq!(&error(request), code, "{}", case.id),
            _ => panic!(
                "{}: a case declares exactly one of canonical/error",
                case.id
            ),
        }
    }
}

#[test]
fn abi_reproduces_the_recorded_state_keys() {
    let fixture: StateKeyFixture = support::read_json("fixtures/cross-runtime/state-keys.json");
    let transition: Value = support::read_json(&fixture.source_fixture);
    let state = &transition["input"]["state"];

    for (kind, expected) in [
        ("full-state", &fixture.expected.full_state),
        ("current-piece", &fixture.expected.current_piece),
        ("hold-aware", &fixture.expected.hold_aware),
    ] {
        let key = value(json!({ "op": "state-key", "kind": kind, "state": state }));
        assert_eq!(&key, expected, "{kind}");
    }

    // The fail-closed boundary has to cross the ABI as a code, not as a trap:
    // a runtime that aborts cannot tell the caller which rule it hit.
    let mut unknown_queue = state.clone();
    unknown_queue["pieces"]["known"] = json!([]);
    assert_eq!(
        error(json!({ "op": "state-key", "kind": "hold-aware", "state": unknown_queue })),
        "unknown-queue-after-empty-hold"
    );
    assert_eq!(
        error(json!({ "op": "state-key", "kind": "invented", "state": state })),
        "unknown-state-key-kind"
    );
}

#[test]
fn abi_validates_and_rehashes_every_complete_fixture() {
    let paths = support::complete_fixture_paths();
    assert!(
        paths.len() >= 14,
        "found only {} complete fixtures",
        paths.len()
    );

    for path in &paths {
        let body: Value = support::read_json(path);
        let validated = value(json!({ "op": "fixture-validate", "fixture": body }));
        assert_eq!(validated["hash"], body["hash"], "{path}");
        assert_eq!(validated["id"], body["id"], "{path}");
        assert_eq!(validated["rulesetId"], body["rulesetId"], "{path}");

        // Recomputing the hash from the parts it covers, rather than trusting
        // the validator's own comparison, is what makes this a byte-level
        // agreement between runtimes rather than a self-consistent pass.
        let rehashed = value(json!({
            "op": "cs1-hash",
            "value": {
                "rulesetId": body["rulesetId"],
                "input": body["input"],
                "expected": body["expected"],
            },
        }));
        assert_eq!(rehashed, body["hash"], "{path}");
    }
}

#[test]
fn abi_rejects_a_fixture_whose_state_declares_another_ruleset() {
    let mut body: Value = support::read_json("fixtures/golden/placement-quad-partial-cancel.json");
    body["input"]["state"]["rulesetId"] = json!("tetrio-s2-v19-other-beta-1-5-0");
    assert_eq!(
        error(json!({ "op": "fixture-validate", "fixture": body })),
        "fixture-ruleset-mismatch"
    );
}

#[test]
fn abi_matches_the_fallback_golden_cases() {
    let fixture = support::FallbackFixture::load();
    assert!(!fixture.cases.is_empty());

    for case in &fixture.cases {
        let assessment = value(json!({
            "op": "fallback-assess",
            "operation": case.operation,
            "state": fixture.state_for(case),
            "engine": fixture.engine_for(case),
            "manifest": fixture.manifest,
            "userSelected": case.user_selected,
        }));
        assert_eq!(assessment, case.expected, "{}", case.id);
    }
}

#[test]
fn abi_runs_the_garbage_receive_fixture() {
    let body: Value = support::read_json("fixtures/golden/garbage-receive-same-frame-fifo.json");
    let next = value(json!({
        "op": "garbage-receive",
        "state": body["input"]["state"]["garbage"],
        "packet": body["input"]["action"]["packet"],
    }));
    assert_eq!(next, body["expected"]["nextState"]["garbage"]);

    // Re-receiving a packet the queue already holds is a duplicate, not an
    // idempotent no-op.
    assert_eq!(
        error(json!({
            "op": "garbage-receive",
            "state": body["expected"]["nextState"]["garbage"],
            "packet": body["input"]["action"]["packet"],
        })),
        "duplicate-packet"
    );

    let mut zero = body["input"]["action"]["packet"].clone();
    zero["packetId"] = json!(99);
    zero["amount"] = json!(0);
    assert_eq!(
        error(json!({
            "op": "garbage-receive",
            "state": body["input"]["state"]["garbage"],
            "packet": zero,
        })),
        "invalid-packet-amount"
    );
}

#[test]
fn abi_reports_malformed_requests_as_values() {
    assert_eq!(error(json!({})), "missing-op");
    assert_eq!(error(json!({ "op": "teleport" })), "unknown-op");
    assert_eq!(
        error(json!({ "op": "cs1-canonicalize", "value": 1e21 })),
        "unsafe-integer"
    );
}
