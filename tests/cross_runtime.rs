use std::{fs, process::Command};

use s2_analysis_engine::cs1;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    value: Value,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct ResultRow {
    id: String,
    ok: bool,
    canonical: Option<String>,
    error: Option<String>,
}

#[test]
fn rust_and_node_produce_identical_cs1_results() {
    let path = "fixtures/cross-runtime/cs1.json";
    let cases: Vec<Case> = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let rust: Vec<ResultRow> = cases
        .into_iter()
        .map(|case| match cs1::canonicalize(&case.value) {
            Ok(bytes) => ResultRow {
                id: case.id,
                ok: true,
                canonical: Some(String::from_utf8(bytes).unwrap()),
                error: None,
            },
            Err(error) => ResultRow {
                id: case.id,
                ok: false,
                canonical: None,
                error: Some(error.code().to_owned()),
            },
        })
        .collect();

    let output = Command::new("node")
        .args(["scripts/cs1.mjs", "--emit", path])
        .output()
        .expect("Node.js is required for the cross-runtime conformance test");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let node: Vec<ResultRow> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(rust, node);
}
