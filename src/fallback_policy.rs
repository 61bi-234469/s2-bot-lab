use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const DEGRADED_REASONS: [&str; 11] = [
    "structured-garbage-unavailable",
    "exact-b2b-unavailable",
    "b2b-charging-unavailable",
    "surge-unavailable",
    "cancellation-unavailable",
    "chain-state-unavailable",
    "time-state-unavailable",
    "queue-unknown",
    "movement-model-unavailable",
    "rule-option-guard-only",
    "user-selected-incompatible-engine",
];

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackAssessment {
    pub inert: bool,
    pub auto_fallback_safe: bool,
    pub decision: String,
    pub result_kind: Option<String>,
    pub degraded: Vec<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FallbackError {
    #[error("unknown fallback operation {0}")]
    UnknownOperation(String),
    #[error("operation mechanisms must be arrays")]
    InvalidMechanisms,
    #[error("unknown fallback mechanism {0}")]
    UnknownMechanism(String),
    #[error("unknown neutral predicate {0}")]
    UnknownPredicate(String),
}

impl FallbackError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownOperation(_) => "unknown-operation",
            Self::InvalidMechanisms => "invalid-mechanisms",
            Self::UnknownMechanism(_) => "unknown-mechanism",
            Self::UnknownPredicate(_) => "unknown-predicate",
        }
    }
}

pub fn assess_fallback(
    operation: &str,
    state: &Value,
    engine: &Value,
    manifest: &Value,
    user_selected: bool,
) -> Result<FallbackAssessment, FallbackError> {
    let requirements = manifest["operationRequirements"]
        .get(operation)
        .ok_or_else(|| FallbackError::UnknownOperation(operation.to_owned()))?;
    let current = mechanisms(&requirements["currentStateMechanisms"])?;
    let reachable = mechanisms(&requirements["reachableMechanisms"])?;
    let support = &engine["capabilities"]["mechanismSupport"];

    let mut current_missing = Vec::new();
    for mechanism in current {
        if support[mechanism] != "exact"
            && !evaluate_neutral(manifest["neutralPredicates"][mechanism].as_str(), state)?
        {
            current_missing.push(mechanism);
        }
    }
    let queue_unknown = state["pieces"]["fidelity"] != "exact"
        || state["pieces"]["queueModel"]["tail"] == "unknown";
    let queue_blocked = engine["capabilities"]["unknownQueue"] == "reject" && queue_unknown;
    let information_loss = state["informationLoss"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let inert = current_missing.is_empty() && !queue_blocked && information_loss.is_empty();

    let reachable_missing: Vec<_> = reachable
        .into_iter()
        .filter(|mechanism| support[*mechanism] != "exact")
        .collect();
    let auto_fallback_safe = inert && reachable_missing.is_empty();

    if auto_fallback_safe {
        return Ok(FallbackAssessment {
            inert,
            auto_fallback_safe,
            decision: if queue_unknown {
                "auto-speculative"
            } else {
                "auto-exact"
            }
            .to_owned(),
            result_kind: Some(
                if queue_unknown {
                    "speculative-input"
                } else {
                    "exact-input"
                }
                .to_owned(),
            ),
            degraded: if queue_unknown {
                vec!["queue-unknown".to_owned()]
            } else {
                Vec::new()
            },
            error_code: None,
        });
    }

    if user_selected && inert {
        let mut degraded: Vec<_> = reachable_missing
            .iter()
            .map(|mechanism| reason_for_mechanism(mechanism).map(str::to_owned))
            .collect::<Result<_, _>>()?;
        if queue_unknown {
            degraded.push("queue-unknown".to_owned());
        }
        degraded.push("user-selected-incompatible-engine".to_owned());
        return Ok(FallbackAssessment {
            inert,
            auto_fallback_safe,
            decision: "user-degraded".to_owned(),
            result_kind: Some(
                if queue_unknown {
                    "speculative-input"
                } else {
                    "degraded-input"
                }
                .to_owned(),
            ),
            degraded: unique(degraded),
            error_code: None,
        });
    }

    let mut degraded: Vec<String> = current_missing
        .iter()
        .chain(reachable_missing.iter())
        .map(|mechanism| reason_for_mechanism(mechanism).map(str::to_owned))
        .collect::<Result<_, _>>()?;
    if queue_blocked || queue_unknown {
        degraded.push("queue-unknown".to_owned());
    }
    degraded.extend(information_loss.iter().map(reason_for_information_loss));
    Ok(FallbackAssessment {
        inert,
        auto_fallback_safe,
        decision: "unsupported".to_owned(),
        result_kind: None,
        degraded: unique(degraded),
        error_code: Some("capability-missing".to_owned()),
    })
}

fn mechanisms(value: &Value) -> Result<Vec<&str>, FallbackError> {
    value
        .as_array()
        .ok_or(FallbackError::InvalidMechanisms)?
        .iter()
        .map(|value| {
            let mechanism = value.as_str().ok_or(FallbackError::InvalidMechanisms)?;
            reason_for_mechanism(mechanism)?;
            Ok(mechanism)
        })
        .collect()
}

fn evaluate_neutral(predicate: Option<&str>, state: &Value) -> Result<bool, FallbackError> {
    match predicate {
        Some("b2b-inactive") => {
            Ok(state["chain"]["fidelity"] == "exact" && state["chain"]["b2b"] == 0)
        }
        Some("chain-inactive") => Ok(state["chain"]["fidelity"] == "exact"
            && state["chain"]["combo"] == 0
            && state["chain"]["b2b"] == 0),
        Some("garbage-empty") => Ok(state["garbage"]["fidelity"] == "exact"
            && state["garbage"]["packets"]
                .as_array()
                .is_some_and(Vec::is_empty)),
        None => Ok(false),
        Some(predicate) => Err(FallbackError::UnknownPredicate(predicate.to_owned())),
    }
}

fn reason_for_mechanism(mechanism: &str) -> Result<&'static str, FallbackError> {
    match mechanism {
        "structured-garbage" => Ok("structured-garbage-unavailable"),
        "exact-b2b" => Ok("exact-b2b-unavailable"),
        "b2b-charging" => Ok("b2b-charging-unavailable"),
        "surge" => Ok("surge-unavailable"),
        "cancellation" => Ok("cancellation-unavailable"),
        "chain-state" => Ok("chain-state-unavailable"),
        "time-state" => Ok("time-state-unavailable"),
        "known-queue" => Ok("queue-unknown"),
        "movement-model" => Ok("movement-model-unavailable"),
        "rule-option" => Ok("rule-option-guard-only"),
        mechanism => Err(FallbackError::UnknownMechanism(mechanism.to_owned())),
    }
}

fn reason_for_information_loss(loss: &Value) -> String {
    let field = loss["field"].as_str().unwrap_or_default();
    if field.starts_with("garbage") {
        "structured-garbage-unavailable"
    } else if field.starts_with("chain.b2b") {
        "exact-b2b-unavailable"
    } else if field.starts_with("chain") {
        "chain-state-unavailable"
    } else if field.starts_with("time") {
        "time-state-unavailable"
    } else if field.starts_with("pieces") {
        "queue-unknown"
    } else if field.starts_with("board") {
        "movement-model-unavailable"
    } else {
        "rule-option-guard-only"
    }
    .to_owned()
}

fn unique(reasons: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    reasons
        .into_iter()
        .filter(|reason| seen.insert(reason.clone()))
        .collect()
}
