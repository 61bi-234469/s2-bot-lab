//! Fixture plumbing shared by the direct-call tests and the ABI tests.
//!
//! The fallback cases are patches over a source fixture rather than standalone
//! states. Two copies of that patching would let one test drift into asserting
//! against a state the other never builds, so both read it from here.

// Each integration test target compiles this module separately and uses only
// the part it needs, so unused-item warnings here are about the other targets.
#![allow(dead_code)]

use std::fs;

use serde::Deserialize;
use serde_json::{Value, json};

pub const GOLDEN_DIR: &str = "fixtures/golden";
pub const FIXTURE_SCHEMA: &str = "s2-analysis-engine/schema/fixture/1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackFixture {
    pub source_fixture: String,
    pub manifest: Value,
    pub engine: Value,
    pub cases: Vec<FallbackCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackCase {
    pub id: String,
    pub operation: String,
    pub user_selected: bool,
    pub state_patch: Option<Value>,
    pub engine_patch: Option<Value>,
    pub expected: Value,
}

impl FallbackFixture {
    pub fn load() -> Self {
        read_json("fixtures/golden/fallback-policy.json")
    }

    pub fn source_state(&self) -> Value {
        let source: Value = read_json(&self.source_fixture);
        let mut state = source["input"]["state"].clone();
        state["pieces"]["queueModel"]["tail"] = json!("deterministic");
        state
    }

    pub fn state_for(&self, case: &FallbackCase) -> Value {
        let mut state = self.source_state();
        let patch = case.state_patch.clone().unwrap_or(Value::Null);
        if let Some(b2b) = patch.get("b2b") {
            state["chain"]["b2b"] = b2b.clone();
        }
        if let Some(tail) = patch.get("queueTail") {
            state["pieces"]["queueModel"]["tail"] = tail.clone();
        }
        if let Some(field) = patch.get("informationLossField") {
            state["informationLoss"]
                .as_array_mut()
                .expect("canonical state carries an informationLoss array")
                .push(json!({
                    "field": field,
                    "reason": "fixture-loss",
                    "effect": "degraded"
                }));
        }
        state
    }

    pub fn engine_for(&self, case: &FallbackCase) -> Value {
        let mut engine = self.engine.clone();
        if let Some(unknown_queue) = case
            .engine_patch
            .as_ref()
            .and_then(|patch| patch.get("unknownQueue"))
        {
            engine["capabilities"]["unknownQueue"] = unknown_queue.clone();
        }
        engine
    }
}

/// Every complete `S-FIXTURE/1` in the corpus, found by enumerating the
/// directory. A fixture nobody remembered to name is otherwise unverified on
/// this side even though Node executes it.
pub fn complete_fixture_paths() -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(GOLDEN_DIR)
        .expect("the golden corpus directory exists")
        .map(|entry| entry.expect("golden corpus entries are readable").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .filter_map(|path| {
            let body: Value = read_json(&path.to_string_lossy());
            (body["$schema"] == FIXTURE_SCHEMA).then(|| path.to_string_lossy().replace('\\', "/"))
        })
        .collect();
    found.sort();
    found
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &str) -> T {
    serde_json::from_slice(&fs::read(path).unwrap_or_else(|error| panic!("{path}: {error}")))
        .unwrap_or_else(|error| panic!("{path}: {error}"))
}
