use serde_json::{Map, Value, json};
use thiserror::Error;

use crate::cs1;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum StateKeyError {
    #[error("canonical state must be an object")]
    NotAnObject,
    #[error("move-generation keys require exact board and piece state")]
    InexactMoveState,
    #[error("HOLD with an empty slot requires a known queue head")]
    UnknownQueueAfterEmptyHold,
    #[error(transparent)]
    Canonicalization(#[from] cs1::Cs1Error),
}

impl StateKeyError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotAnObject => "not-an-object",
            Self::InexactMoveState => "inexact-move-state",
            Self::UnknownQueueAfterEmptyHold => "unknown-queue-after-empty-hold",
            Self::Canonicalization(error) => error.code(),
        }
    }
}

pub fn full_state_key(state: &Value) -> Result<String, StateKeyError> {
    let mut payload = state.as_object().ok_or(StateKeyError::NotAnObject)?.clone();
    payload.remove("provenance");
    hash_key("s2-full-state/1", &Value::Object(payload))
}

pub fn current_piece_structural_key(state: &Value) -> Result<String, StateKeyError> {
    exact_move_state(state)?;
    hash_key(
        "s2-current-piece/1",
        &json!({
            "schemaVersion": state["schemaVersion"],
            "rulesetId": state["rulesetId"],
            "board": state["board"],
            "current": state["pieces"]["current"],
        }),
    )
}

pub fn hold_aware_move_generation_key(state: &Value) -> Result<String, StateKeyError> {
    exact_move_state(state)?;
    let pieces = &state["pieces"];
    let queue_head = pieces["known"].as_array().and_then(|known| known.first());
    if pieces["holdAvailable"] == Value::Bool(true)
        && pieces["hold"].is_null()
        && queue_head.is_none()
    {
        return Err(StateKeyError::UnknownQueueAfterEmptyHold);
    }
    hash_key(
        "s2-hold-aware/1",
        &json!({
            "schemaVersion": state["schemaVersion"],
            "rulesetId": state["rulesetId"],
            "board": state["board"],
            "current": pieces["current"],
            "hold": pieces["hold"],
            "holdAvailable": pieces["holdAvailable"],
            "queueHead": queue_head.cloned().unwrap_or(Value::Null),
        }),
    )
}

fn exact_move_state(state: &Value) -> Result<&Map<String, Value>, StateKeyError> {
    let object = state.as_object().ok_or(StateKeyError::NotAnObject)?;
    if state["board"]["fidelity"] != "exact" || state["pieces"]["fidelity"] != "exact" {
        return Err(StateKeyError::InexactMoveState);
    }
    Ok(object)
}

fn hash_key(namespace: &str, payload: &Value) -> Result<String, StateKeyError> {
    Ok(format!("{namespace}:{}", cs1::hash(payload)?))
}
