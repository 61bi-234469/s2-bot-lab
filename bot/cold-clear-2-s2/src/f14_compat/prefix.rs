use super::{canonicalize, CompatError};
use serde_json::Value;

const ORIGINS_I: [(&str, i32, i32); 4] = [
    ("north", -1, -2),
    ("east", -2, -2),
    ("south", -2, -1),
    ("west", -1, -1),
];
const ORIGINS_O: [(&str, i32, i32); 4] = [
    ("north", 0, 0),
    ("east", 0, -1),
    ("south", -1, -1),
    ("west", -1, 0),
];
const ORIGINS_JLSTZ: [(&str, i32, i32); 4] = [
    ("north", -1, -1),
    ("east", -1, -1),
    ("south", -1, -1),
    ("west", -1, -1),
];
const ORIENTATION_TO_ROTATION: [(&str, &str); 4] = [
    ("north", "spawn"),
    ("east", "right"),
    ("south", "reverse"),
    ("west", "left"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnverifiablePolicy {
    RecordAndSkip,
    FailClosed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrefixOptions {
    pub candidate_limit: i32,
    pub allow_complete_returned_prefix: bool,
    pub unverifiable: UnverifiablePolicy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuiMoveLocation {
    pub piece: String,
    pub orientation: String,
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalPlacement {
    pub piece: String,
    pub rotation: String,
    pub x: i32,
    pub y: i32,
    pub used_hold: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedCandidate {
    pub cc2_rank: i32,
    pub identity: String,
    pub placement: CanonicalPlacement,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RejectedCandidate {
    pub cc2_rank: i32,
    pub identity: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrefixResult {
    pub accepted: Vec<AcceptedCandidate>,
    pub rejected: Vec<RejectedCandidate>,
    pub returned_candidate_count: usize,
}

pub fn final_pose_key(placement: &CanonicalPlacement) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        placement.piece,
        placement.rotation,
        placement.x,
        placement.y,
        if placement.used_hold { 1 } else { 0 }
    )
}

pub fn spin_rank(spin: &str) -> i32 {
    match spin {
        "none" => 0,
        "mini" => 1,
        "normal" => 2,
        _ => -1,
    }
}

fn origin_for(piece: &str, orientation: &str) -> Result<(i32, i32), CompatError> {
    let table = match piece {
        "I" => &ORIGINS_I,
        "O" => &ORIGINS_O,
        "T" | "L" | "J" | "S" | "Z" => &ORIGINS_JLSTZ,
        _ => return Err(CompatError::UnsupportedOrientation),
    };
    table
        .iter()
        .find(|(name, _, _)| *name == orientation)
        .map(|(_, x, y)| (*x, *y))
        .ok_or(CompatError::UnsupportedOrientation)
}

pub fn cc2_move_to_canonical_placement(
    current: &str,
    location: &GuiMoveLocation,
) -> Result<CanonicalPlacement, CompatError> {
    let rotation = ORIENTATION_TO_ROTATION
        .iter()
        .find(|(orientation, _)| *orientation == location.orientation)
        .map(|(_, rotation)| (*rotation).to_string())
        .ok_or(CompatError::UnsupportedOrientation)?;
    let (ox, oy) = origin_for(&location.piece, &location.orientation)?;
    Ok(CanonicalPlacement {
        piece: location.piece.clone(),
        rotation,
        x: location.x + ox,
        y: location.y + oy,
        used_hold: location.piece != current,
    })
}

pub fn gui_location_from_value(move_value: &Value) -> Result<GuiMoveLocation, CompatError> {
    let location = &move_value["location"];
    Ok(GuiMoveLocation {
        piece: location["type"].as_str().ok_or(CompatError::InvalidPrefixSettings)?.to_string(),
        orientation: location["orientation"]
            .as_str()
            .ok_or(CompatError::InvalidPrefixSettings)?
            .to_string(),
        x: location["x"].as_i64().ok_or(CompatError::InvalidPrefixSettings)? as i32,
        y: location["y"].as_i64().ok_or(CompatError::InvalidPrefixSettings)? as i32,
    })
}

pub fn build_f14_prefix(
    moves: &[Value],
    current: &str,
    options: &PrefixOptions,
    mut verify: impl FnMut(usize, &Value, &CanonicalPlacement) -> Result<CanonicalPlacement, String>,
) -> Result<PrefixResult, CompatError> {
    if options.candidate_limit < 1 || options.candidate_limit > 64 {
        return Err(CompatError::InvalidPrefixSettings);
    }
    if moves.is_empty()
        || (!options.allow_complete_returned_prefix && moves.len() < options.candidate_limit as usize)
    {
        return Err(CompatError::IncompletePrefix);
    }
    let take = if options.allow_complete_returned_prefix {
        moves.len().min(options.candidate_limit as usize)
    } else {
        options.candidate_limit as usize
    };
    let prefix = &moves[..take];
    let mut identities = Vec::with_capacity(prefix.len());
    for move_value in prefix {
        identities.push(canonicalize(move_value).map_err(|_| CompatError::Cs1)?);
    }
    let mut sorted = identities.clone();
    sorted.sort();
    if sorted.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(CompatError::DuplicateIdentity);
    }
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    for (cc2_rank, move_value) in prefix.iter().enumerate() {
        // Per-candidate pose conversion belongs in the same skip/fail-closed
        // bucket as verification. Duplicate identity above is prefix-wide.
        let requested = match gui_location_from_value(move_value)
            .and_then(|location| cc2_move_to_canonical_placement(current, &location))
        {
            Ok(requested) => requested,
            Err(error) => {
                if options.unverifiable == UnverifiablePolicy::FailClosed {
                    return Err(CompatError::FailClosed);
                }
                rejected.push(RejectedCandidate {
                    cc2_rank: cc2_rank as i32,
                    identity: identities[cc2_rank].clone(),
                    reason: format!("{error:?}"),
                });
                continue;
            }
        };
        match verify(cc2_rank, move_value, &requested) {
            Ok(placement) => accepted.push(AcceptedCandidate {
                cc2_rank: cc2_rank as i32,
                identity: identities[cc2_rank].clone(),
                placement,
            }),
            Err(reason) => {
                if options.unverifiable == UnverifiablePolicy::FailClosed {
                    return Err(CompatError::FailClosed);
                }
                rejected.push(RejectedCandidate {
                    cc2_rank: cc2_rank as i32,
                    identity: identities[cc2_rank].clone(),
                    reason,
                });
            }
        }
    }
    if accepted.is_empty() {
        return Err(CompatError::NoVerifiableCandidate);
    }
    Ok(PrefixResult {
        accepted,
        rejected,
        returned_candidate_count: moves.len(),
    })
}
