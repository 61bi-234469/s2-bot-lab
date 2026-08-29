use s2_analysis_engine::{
    fixture::{Fixture, FixtureError},
    simulator::{GarbagePacket, GarbageState, receive_garbage},
};
use serde_json::{Value, json};

#[path = "support/mod.rs"]
mod support;

#[test]
fn validates_every_complete_fixture_in_the_corpus() {
    let paths = support::complete_fixture_paths();
    assert!(
        paths.len() >= 9,
        "found only {} complete fixtures",
        paths.len()
    );

    let mut ids = std::collections::BTreeSet::new();
    for path in &paths {
        // Load performs schema-version, comparison, ruleset and CS/1 hash
        // validation, so a corpus-wide load is the cross-runtime hash check.
        let fixture = Fixture::load(path).unwrap_or_else(|error| panic!("{path}: {error}"));
        assert_eq!(fixture.evidence_layer, "golden", "{path}");
        assert!(
            ids.insert(fixture.id.clone()),
            "{path}: duplicate fixture id {}",
            fixture.id
        );
    }
}

#[test]
fn loads_and_executes_garbage_receive_fixture() {
    let fixture = Fixture::load("fixtures/golden/garbage-receive-same-frame-fifo.json").unwrap();
    let state: GarbageState =
        serde_json::from_value(fixture.input["state"]["garbage"].clone()).unwrap();
    let packet: GarbagePacket =
        serde_json::from_value(fixture.input["action"]["packet"].clone()).unwrap();

    let next = receive_garbage(&state, packet).unwrap();
    let expected: GarbageState =
        serde_json::from_value(fixture.expected["nextState"]["garbage"].clone()).unwrap();
    assert_eq!(next, expected);

    let actual: Value = serde_json::to_value(next).unwrap();
    assert_eq!(actual["packets"][0]["packetId"], 10);
    assert_eq!(actual["packets"][1]["packetId"], 11);
}

#[test]
fn validates_complete_placement_fixture_hash() {
    let no_clear = Fixture::load("fixtures/golden/placement-no-clear-tank.json").unwrap();
    let tspin = Fixture::load("fixtures/golden/placement-tspin-single.json").unwrap();
    let perfect_clear = Fixture::load("fixtures/golden/placement-perfect-clear.json").unwrap();

    assert_eq!(no_clear.input["action"]["kind"], "placement");
    assert_eq!(no_clear.expected["lockResult"]["lines"], 0);
    assert_eq!(
        no_clear.expected["tankResult"]["inserted"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(no_clear.expected["nextState"]["time"]["piecesPlaced"], 1);

    assert_eq!(tspin.input["action"]["kind"], "placement");
    assert_eq!(tspin.expected["lockResult"]["spin"], "normal");
    assert_eq!(tspin.expected["lockResult"]["lines"], 1);
    assert_eq!(tspin.expected["chain"]["b2bAfter"], 1);
    assert_eq!(tspin.expected["attackStages"]["specialBonus"], 1);
    assert_eq!(tspin.expected["attackStages"]["outgoingBeforeCancel"], 3);
    assert_eq!(tspin.expected["nextState"]["time"]["piecesPlaced"], 1);

    assert_eq!(perfect_clear.expected["lockResult"]["perfectClear"], true);
    assert_eq!(perfect_clear.expected["chain"]["b2bBefore"], 0);
    assert_eq!(perfect_clear.expected["chain"]["b2bAfter"], 1);
    assert_eq!(perfect_clear.expected["attackStages"]["afterRounding"], 0);
    assert_eq!(
        perfect_clear.expected["attackStages"]["perfectClearBonus"],
        10
    );
    assert_eq!(
        perfect_clear.expected["cancelResult"]["outgoingAfterCancel"],
        10
    );
}

#[test]
fn validates_surge_and_partial_cancel_fixtures() {
    let surge = Fixture::load("fixtures/golden/placement-b2b-charging-surge.json").unwrap();
    let quad = Fixture::load("fixtures/golden/placement-quad-partial-cancel.json").unwrap();

    // The Surge fixture must not share the Foundation ruleset identity: the
    // profiles differ in b2bCharging, and one identity cannot carry both.
    assert_ne!(surge.ruleset_id, quad.ruleset_id);
    assert_eq!(surge.expected["chain"]["b2bBefore"], 6);
    assert_eq!(surge.expected["chain"]["b2bAfter"], 0);
    assert_eq!(surge.expected["chain"]["brokeB2b"], true);
    assert_eq!(
        surge.expected["attackStages"]["surgeChunks"],
        json!([2, 2, 1])
    );
    assert_eq!(surge.expected["attackStages"]["afterRounding"], 0);
    assert_eq!(surge.expected["attackStages"]["outgoingBeforeCancel"], 5);
    assert_eq!(surge.expected["cancelResult"]["cancelled"], 4);
    assert_eq!(surge.expected["cancelResult"]["outgoingAfterCancel"], 1);
    assert_eq!(surge.expected["tankResult"]["inserted"], json!([]));

    assert_eq!(quad.expected["lockResult"]["lines"], 4);
    assert_eq!(quad.expected["lockResult"]["perfectClear"], false);
    assert_eq!(quad.expected["attackStages"]["raw"], 5);
    assert_eq!(quad.expected["attackStages"]["specialBonus"], 1);
    assert_eq!(quad.expected["attackStages"]["afterRounding"], 6);
    assert_eq!(quad.expected["cancelResult"]["cancelled"], 6);
    assert_eq!(quad.expected["cancelResult"]["outgoingAfterCancel"], 0);

    // A partially cancelled packet survives the transition with its identity
    // intact and its order re-indexed to stay contiguous from zero.
    let remaining: Vec<GarbagePacket> =
        serde_json::from_value(quad.expected["nextState"]["garbage"]["packets"].clone()).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].packet_id, 31);
    assert_eq!(remaining[0].amount, 2);
    assert_eq!(remaining[0].order, 0);
    assert_eq!(
        quad.expected["cancelResult"]["remainingIncoming"],
        quad.expected["nextState"]["garbage"]["packets"]
    );
}

#[test]
fn validates_combo_multiplier_and_tank_cap_fixtures() {
    // Loading validates the CS/1 hash, so this is also the first fixture whose
    // hash depends on Rust and Node formatting a fractional number identically.
    let combo = Fixture::load("fixtures/golden/placement-combo-multiplier-rounding.json").unwrap();
    let tank_cap = Fixture::load("fixtures/golden/placement-tank-cap-boundary.json").unwrap();

    assert_eq!(combo.expected["chain"]["comboAfter"], 4);
    assert_eq!(combo.expected["attackStages"]["raw"], 1.75);
    assert_eq!(combo.expected["attackStages"]["afterMultiplier"], 1.75);
    assert_eq!(combo.expected["attackStages"]["afterRounding"], 1);
    assert_eq!(combo.expected["attackStages"]["specialBonus"], 0);
    assert_eq!(combo.expected["lockResult"]["perfectClear"], false);

    // The cap bounds one placement: two rows enter the board now and the rest
    // stays owed as a single re-indexed packet.
    assert_eq!(tank_cap.expected["lockResult"]["lines"], 0);
    assert_eq!(
        tank_cap.expected["tankResult"]["inserted"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        tank_cap.expected["nextState"]["garbage"]["capState"]["consumedThisTick"],
        2
    );

    let deferred: Vec<GarbagePacket> =
        serde_json::from_value(tank_cap.expected["tankResult"]["deferred"].clone()).unwrap();
    assert_eq!(deferred.len(), 1);
    assert_eq!(deferred[0].packet_id, 41);
    assert_eq!(deferred[0].amount, 2);
    assert_eq!(deferred[0].order, 0);
    assert_eq!(
        tank_cap.expected["tankResult"]["deferred"],
        tank_cap.expected["nextState"]["garbage"]["packets"]
    );
}

#[test]
fn rejects_a_fixture_whose_state_declares_another_ruleset() {
    let mut fixture: Value = serde_json::from_slice(
        &std::fs::read("fixtures/golden/placement-quad-partial-cancel.json").unwrap(),
    )
    .unwrap();
    fixture["input"]["state"]["rulesetId"] = json!("tetrio-s2-v19-other-beta-1-5-0");

    let parsed: Fixture = serde_json::from_value(fixture).unwrap();
    assert!(matches!(
        parsed.validate(),
        Err(FixtureError::RulesetMismatch {
            path: "input.state",
            ..
        })
    ));
}
