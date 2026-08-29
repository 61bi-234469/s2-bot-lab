use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarbagePacket {
    pub packet_id: u64,
    pub source_game_id: u64,
    pub amount: u64,
    pub hole_size: u64,
    pub arrival_frame: u64,
    pub confirmed: bool,
    pub order: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarbageState {
    pub packets: Vec<GarbagePacket>,
    pub generator_state: GeneratorState,
    pub cap_state: CapState,
    pub fidelity: Fidelity,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorState {
    pub rng_state: u64,
    pub last_tank_frame: u64,
    pub last_hole_column: i64,
    pub sent_for_opener: u64,
    pub hole_changed: bool,
    pub received_count_since_reset: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapState {
    pub consumed_this_tick: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Fidelity {
    Exact,
    Partial,
    Absent,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TransitionError {
    #[error("duplicate garbage packet identity")]
    DuplicatePacket,
    #[error("garbage packet amount must be positive")]
    InvalidPacketAmount,
}

impl TransitionError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DuplicatePacket => "duplicate-packet",
            Self::InvalidPacketAmount => "invalid-packet-amount",
        }
    }
}

pub fn receive_garbage(
    state: &GarbageState,
    packet: GarbagePacket,
) -> Result<GarbageState, TransitionError> {
    if packet.amount == 0 {
        return Err(TransitionError::InvalidPacketAmount);
    }
    if state.packets.iter().any(|current| {
        current.packet_id == packet.packet_id && current.source_game_id == packet.source_game_id
    }) {
        return Err(TransitionError::DuplicatePacket);
    }

    let mut next = state.clone();
    next.packets.push(packet);
    next.packets
        .sort_by_key(|packet| (packet.arrival_frame, packet.order));
    Ok(next)
}
