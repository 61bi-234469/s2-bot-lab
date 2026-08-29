use std::{fs, path::Path};

use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;

use crate::cs1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    pub schema_version: u32,
    pub id: String,
    pub ruleset_id: String,
    pub evidence_layer: String,
    pub coverage_cells: Vec<String>,
    pub source: Value,
    pub input: Value,
    pub expected: Value,
    pub comparison: Comparison,
    pub generated_at: String,
    pub hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub mode: String,
    pub float_tolerance: u32,
}

#[derive(Debug, Error)]
pub enum FixtureError {
    #[error("failed to read fixture: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid fixture JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported fixture schema version {0}")]
    SchemaVersion(u32),
    #[error("fixture must use exact comparison with zero tolerance")]
    Comparison,
    #[error("fixture hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("fixture cannot have an empty id, ruleset id, or coverage cell list")]
    MissingIdentity,
    #[error("{path} declares ruleset {actual}, but the fixture declares {expected}")]
    RulesetMismatch {
        path: &'static str,
        expected: String,
        actual: String,
    },
    #[error("unsupported evidence layer {0}")]
    EvidenceLayer(String),
    #[error(transparent)]
    Canonicalization(#[from] cs1::Cs1Error),
}

impl FixtureError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "fixture-unreadable",
            Self::Json(_) => "fixture-invalid-json",
            Self::SchemaVersion(_) => "fixture-schema-version",
            Self::Comparison => "fixture-comparison-not-exact",
            Self::HashMismatch { .. } => "fixture-hash-mismatch",
            Self::MissingIdentity => "fixture-missing-identity",
            Self::RulesetMismatch { .. } => "fixture-ruleset-mismatch",
            Self::EvidenceLayer(_) => "fixture-evidence-layer",
            Self::Canonicalization(error) => error.code(),
        }
    }
}

impl Fixture {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, FixtureError> {
        let bytes = fs::read(path)?;
        let fixture: Self = serde_json::from_slice(&bytes)?;
        fixture.validate()?;
        Ok(fixture)
    }

    pub fn validate(&self) -> Result<(), FixtureError> {
        if self.schema_version != 1 {
            return Err(FixtureError::SchemaVersion(self.schema_version));
        }
        if self.id.is_empty() || self.ruleset_id.is_empty() || self.coverage_cells.is_empty() {
            return Err(FixtureError::MissingIdentity);
        }
        if !matches!(
            self.evidence_layer.as_str(),
            "differential" | "golden" | "replay-results" | "metamorphic" | "cross-runtime"
        ) {
            return Err(FixtureError::EvidenceLayer(self.evidence_layer.clone()));
        }
        if self.comparison.mode != "exact" || self.comparison.float_tolerance != 0 {
            return Err(FixtureError::Comparison);
        }
        // Rules are resolved from the ruleset identity, so a fixture whose
        // states name a different ruleset would be evaluated under rules it
        // does not declare.
        self.check_ruleset("input.state", &self.input["state"])?;
        self.check_ruleset("expected.nextState", &self.expected["nextState"])?;
        let hash_input = json!({
            "rulesetId": self.ruleset_id,
            "input": self.input,
            "expected": self.expected,
        });
        let actual = cs1::hash(&hash_input)?;
        if self.hash != actual {
            return Err(FixtureError::HashMismatch {
                expected: self.hash.clone(),
                actual,
            });
        }
        Ok(())
    }

    fn check_ruleset(&self, path: &'static str, state: &Value) -> Result<(), FixtureError> {
        if state.is_null() {
            return Ok(());
        }
        let actual = state["rulesetId"].as_str().unwrap_or_default();
        if actual != self.ruleset_id {
            return Err(FixtureError::RulesetMismatch {
                path,
                expected: self.ruleset_id.clone(),
                actual: actual.to_owned(),
            });
        }
        Ok(())
    }
}
