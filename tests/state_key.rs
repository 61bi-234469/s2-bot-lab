use std::fs;

use s2_analysis_engine::state_key::{
    StateKeyError, current_piece_structural_key, full_state_key, hold_aware_move_generation_key,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyFixture {
    source_fixture: String,
    expected: Expected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    full_state: String,
    current_piece: String,
    hold_aware: String,
}

#[test]
fn state_keys_match_the_node_fixture() {
    let fixture: KeyFixture =
        serde_json::from_slice(&fs::read("fixtures/cross-runtime/state-keys.json").unwrap())
            .unwrap();
    let transition: Value =
        serde_json::from_slice(&fs::read(fixture.source_fixture).unwrap()).unwrap();
    let state = &transition["input"]["state"];

    assert_eq!(full_state_key(state).unwrap(), fixture.expected.full_state);
    assert_eq!(
        current_piece_structural_key(state).unwrap(),
        fixture.expected.current_piece
    );
    assert_eq!(
        hold_aware_move_generation_key(state).unwrap(),
        fixture.expected.hold_aware
    );
}

#[test]
fn hold_aware_key_separates_hold_legality_inputs() {
    let transition: Value =
        serde_json::from_slice(&fs::read("fixtures/golden/placement-no-clear-tank.json").unwrap())
            .unwrap();
    let state = &transition["input"]["state"];
    let current_key = current_piece_structural_key(state).unwrap();
    let hold_key = hold_aware_move_generation_key(state).unwrap();

    for (field, value) in [
        ("hold", Value::String("T".to_owned())),
        ("holdAvailable", Value::Bool(false)),
    ] {
        let mut changed = state.clone();
        changed["pieces"][field] = value;
        assert_eq!(current_piece_structural_key(&changed).unwrap(), current_key);
        assert_ne!(hold_aware_move_generation_key(&changed).unwrap(), hold_key);
    }

    let mut queue_changed = state.clone();
    queue_changed["pieces"]["known"][0] = Value::String("Z".to_owned());
    assert_eq!(
        current_piece_structural_key(&queue_changed).unwrap(),
        current_key
    );
    assert_ne!(
        hold_aware_move_generation_key(&queue_changed).unwrap(),
        hold_key
    );
}

#[test]
fn empty_hold_with_unknown_queue_fails_closed() {
    let transition: Value =
        serde_json::from_slice(&fs::read("fixtures/golden/placement-no-clear-tank.json").unwrap())
            .unwrap();
    let mut state = transition["input"]["state"].clone();
    state["pieces"]["known"] = Value::Array(Vec::new());

    assert_eq!(
        hold_aware_move_generation_key(&state),
        Err(StateKeyError::UnknownQueueAfterEmptyHold)
    );
}
