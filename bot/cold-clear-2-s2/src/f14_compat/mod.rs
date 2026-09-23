//! Development-only F14 amount-only selector port.
//!
//! This module is the Rust counterpart of the JS F14 reference selector. It runs
//! on the legacy TBP/Freestyle path (`--f14-compat-profile` / `run_f14`, and the
//! WASM `f14_*` operations). It is not the ADR-063 `s2-native-integrated/1` route
//! and must not be mixed into `native_s2::transport`. Its decisions are checked
//! against the JS reference on frozen fixtures; skip/error/cleanup,
//! start/selector projection, deadline and cancel follow the same contract.
//!
//! Accepted domain and rejection mapping versus JS:
//! - `score_evaluation_features` takes the 19 numeric features already aligned to
//!   `FEATURE_NAMES`. `score_feature_map` is the object form: it rejects
//!   unknown keys, `$schema` mismatch, and `schemaVersion` mismatch. Both reject
//!   non-finite weights; JS `scoreEvaluationFeatures` does not, because
//!   `normalizeWeightProfile` already required finite weights.
//! - `classify_conversion` takes non-negative `u32` chain/lines/surge values
//!   (the public selector domain) instead of wrapping through `i32`. JS uses
//!   `Number.isSafeInteger`; values above `u32::MAX` cannot arrive via the
//!   envelope. The function still returns `None` instead of throwing.
//! - `rank_candidates` rejects empty input, duplicate `cc2_rank`, and non-finite
//!   `s2_score` / `conversion.units` (`NonFiniteFeature`). JS does not inspect
//!   those scores at ranking time because upstream already required finite
//!   values. The JS third key is `identity.localeCompare(..., "en")`; this port
//!   uses code-point order only after the uniqueness check, which makes the
//!   third key unreachable on a valid prefix.
//! - `choose_rescue` rejects empty input and non-finite `solvency`, matching JS
//!   throws. `solvent` is a `bool` here, so the JS `typeof solvent !== "boolean"`
//!   check is a type error at the caller.
//! - `advance_f14_amount_only` checks incoming/u32 lines, returns zeros on
//!   incoming0 without converting chain to u8, then checks spin/chain and calls
//!   `data::advance_amount_only`. It does not use `GameState.b2b` or native
//!   rootAmounts.
//! - `advance_f14_chain` follows JS `advanceChain` (`lines >= 4`, unclamped).
//!   Do not substitute `data::advance_chain` (B2B sat 4) or `native_s2::advance_chain`
//!   (`lines == 4`).
//! - CS1 matches JS error codes and key code-point order. Prefix slicing,
//!   duplicate throw, record-and-skip / fail-closed, and all-rejected follow
//!   `buildCompleteCc2FinalPlacementCandidates`. A reachable BFS is sorted;
//!   B public BFS is unsorted. Both opening and syntheticReach enumerations
//!   compare the full placement lists. `syntheticReach` includes a C-board
//!   that emits FIN/TST kick evidence so `is_fin_or_tst` is exercised on live
//!   BFS output. Native witnesses are not adopted unverified.
//! - A TSD returns `{tAvailable, scanned, witnessed}` over canonical T
//!   placements with cap 64. B returns a boolean and increments scanned only
//!   on T. The A scan list is `generate_reachable_a` T-filtered on the
//!   syntheticTsd lockBoard; lock-eval for `witnessed=true` stays JS-supplied.
//!   `S2_AMOUNT_ONLY_TSD_EMPTY_GARBAGE.rngState` stays 123456789.

mod cs1;
pub(crate) mod driver;
pub(crate) mod inproc;
mod prefix;
mod reach;
pub(crate) mod root_allocation;
pub mod select;
pub mod transport;

pub use cs1::{canonicalize, Cs1Error};
pub use prefix::{
    build_f14_prefix, cc2_move_to_canonical_placement, final_pose_key, gui_location_from_value,
    spin_rank, CanonicalPlacement, GuiMoveLocation, PrefixOptions, PrefixResult, UnverifiablePolicy,
};
pub use select::{
    F14PublicState, F14RuntimeLimits, F14SelectOptions, F14Selection, F14SelectorTime,
};
pub use reach::{
    compact_json, generate_public_reachable, generate_reachable_a, is_fin_or_tst,
    kick_tables_from_json, placement_is_legal, t_available, tetromino_cells_from_json,
    witness_a_next_tsd, witness_b_next_tsd, KickTables, LockOutcome, ReachPieceState, TsdResult,
};

use crate::data::{
    advance_amount_only, amount_only_search_attack, AmountDelta, Board, Spin,
};
use serde_json::{Map, Value};

pub const FEATURE_SCHEMA_ID: &str = "s2-analysis-engine/schema/evaluation-features/2";
pub const FEATURE_SCHEMA_VERSION: u32 = 2;
pub const FEATURE_SCHEMA_SHA256: &str =
    "sha256:04de3656e0b3261cbcdf9bfa44acae4efeff6034da72ff4d8e137defefd6e3e9";
pub const F14_RULESET_ID: &str =
    "tetrio-s2-v19-2c47b3df945f6714449b92d1b44346ef4bf0e1a20e95be8ed10c28be75c66a60-beta-1-5-0";
pub const QUEUE_LIMIT: usize = 14;

pub const FEATURE_NAMES: [&str; 19] = [
    "aggregateHeight",
    "maxHeight",
    "holes",
    "bumpiness",
    "toppedOut",
    "remainingIncoming",
    "deferredIncoming",
    "dueIncoming",
    "incomingNextLock",
    "confirmedIncoming",
    "tankedIncoming",
    "visibleTopOutMargin",
    "outgoingBeforeCancel",
    "outgoingAfterCancel",
    "cancelled",
    "combo",
    "b2b",
    "chargingLevel",
    "surgeSent",
];

pub const ADJUSTMENT_SCALE: f64 = 28.0;
pub const RANK_PENALTY: f64 = 25.0;
pub const F12_MIN_B2B_BEFORE: u32 = 6;
pub const F12_MIN_SURGE_SENT: u32 = 5;
pub const F12_MIN_RELEASE_VALUE: f64 = 5.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompatError {
    NonFiniteFeature,
    ToppedOutNotUnit,
    EmptyCandidates,
    InvalidSolvency,
    DuplicateCc2Rank,
    InvalidLockBoard,
    UnknownFeature,
    SchemaMismatch,
    SchemaVersionMismatch,
    InvalidIncoming,
    InvalidSpin,
    ChainOutOfU8,
    ChainOverflow,
    InconsistentSearchAttack,
    InvalidSurge,
    HoldUnavailable,
    OverlappingLockBlock,
    IncompletePrefix,
    DuplicateIdentity,
    NoVerifiableCandidate,
    FailClosed,
    InvalidPrefixSettings,
    UnsupportedOrientation,
    Cs1,
    IllegalPlacement,
    PieceUnavailable,
    InvalidTime,
    InvalidSelector,
    Cancelled,
    Deadline,
    UnsupportedRuleset,
    StartSelectorMismatch,
    MissingCoreRanking,
    StaleRankingEpoch,
    RankingBindingMismatch,
    RootOutcomeAlreadyTaken,
    RootOutcomeNotReady,
    RootOutcomeStatsMismatch,
    RootAllocationBindingMismatch,
    RootAllocationDomainRejected,
    RootAllocationLimitExceeded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConversionBranch {
    HighSurgeFinisher,
    RenQuadTsdB2bBridge,
    MiniToTsdB2bBridge,
    HighOrDefensiveRen,
    UnconvertedLowValueRen,
    Other,
}

impl ConversionBranch {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HighSurgeFinisher => "high-surge-finisher",
            Self::RenQuadTsdB2bBridge => "ren-quad-tsd-b2b-bridge",
            Self::MiniToTsdB2bBridge => "mini-to-tsd-b2b-bridge",
            Self::HighOrDefensiveRen => "high-or-defensive-ren",
            Self::UnconvertedLowValueRen => "unconverted-low-value-ren",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Conversion {
    pub branch: ConversionBranch,
    pub units: f64,
    pub qualifies: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RankedCandidate {
    pub cc2_rank: i32,
    pub identity: String,
    pub s2_score: f64,
    pub conversion: Conversion,
    pub solvency: f64,
    pub solvent: bool,
    pub selection_score: f64,
}

/// Product-sum in `Object.entries(model.weights)` order. Legacy search f32 is untouched.
pub fn score_evaluation_features(
    features: &[f64; 19],
    weights: &[f64; 19],
) -> Result<f64, CompatError> {
    if features[4] != 0.0 && features[4] != 1.0 {
        return Err(CompatError::ToppedOutNotUnit);
    }
    let mut score = 0.0;
    for index in 0..19 {
        if !features[index].is_finite() || !weights[index].is_finite() {
            return Err(CompatError::NonFiniteFeature);
        }
        score += features[index] * weights[index];
    }
    Ok(score)
}

pub fn selection_score(s2_score: f64, units: f64, cc2_rank: i32) -> f64 {
    s2_score + ADJUSTMENT_SCALE * units - (cc2_rank as f64) * RANK_PENALTY
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PostSpinPolicy {
    #[default]
    LegacyF14,
    NonTSpinPriorOff,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FinalOrderPolicy {
    #[default]
    S2Rerank,
    Cc2RankOrder,
}

impl PostSpinPolicy {
    pub fn as_id(self) -> Option<&'static str> {
        match self {
            Self::LegacyF14 => None,
            Self::NonTSpinPriorOff => Some("non-t-spin-prior-off/1"),
        }
    }
}

pub fn non_t_all_spin_clear(piece: &str, spin: &str, lines: u32) -> bool {
    piece != "T" && spin == "mini" && lines >= 1
}

pub fn classify_conversion(
    combo_before: u32,
    combo_after: u32,
    b2b_before: u32,
    b2b_after: u32,
    lines: u32,
    spin: &str,
    cancelled: f64,
    ren_combat_gain: f64,
    setup_witnessed: bool,
    surge_sent: u32,
    release_value: f64,
) -> Option<Conversion> {
    classify_conversion_for_policy(
        PostSpinPolicy::LegacyF14,
        "T",
        combo_before,
        combo_after,
        b2b_before,
        b2b_after,
        lines,
        spin,
        cancelled,
        ren_combat_gain,
        setup_witnessed,
        surge_sent,
        release_value,
    )
}

/// Thin policy wrapper over the frozen F14 classifier. LegacyF14 ignores `piece`
/// and matches `classify_conversion`. NonTSpinPriorOff only changes the two
/// non-T Mini strategy flags; it never rewrites spin, attack, or B2B.
pub fn classify_conversion_for_policy(
    policy: PostSpinPolicy,
    piece: &str,
    combo_before: u32,
    combo_after: u32,
    b2b_before: u32,
    b2b_after: u32,
    lines: u32,
    spin: &str,
    cancelled: f64,
    ren_combat_gain: f64,
    setup_witnessed: bool,
    surge_sent: u32,
    release_value: f64,
) -> Option<Conversion> {
    if !matches!(spin, "none" | "mini" | "normal")
        || !cancelled.is_finite()
        || cancelled < 0.0
        || !ren_combat_gain.is_finite()
        || !release_value.is_finite()
    {
        return None;
    }
    let continuing_ren = combo_before >= 1 && combo_after > combo_before;
    let difficult_clear = (lines == 4 && spin == "none") || (lines == 2 && spin == "normal");
    let b2b_bridge = continuing_ren && difficult_clear && b2b_after > 0 && ren_combat_gain > 0.0;
    let target = non_t_all_spin_clear(piece, spin, lines);
    let setup_bridge = continuing_ren
        && ((spin == "mini" && lines >= 1) || (spin == "normal" && lines == 1))
        && b2b_after > 0
        && setup_witnessed
        && !(policy == PostSpinPolicy::NonTSpinPriorOff && target);
    let high_surge = b2b_before >= F12_MIN_B2B_BEFORE
        && surge_sent >= F12_MIN_SURGE_SENT
        && release_value >= F12_MIN_RELEASE_VALUE;
    let high_or_defensive = continuing_ren && (combo_after >= 6 || cancelled > 0.0);
    let low_value = (spin == "none" || (policy == PostSpinPolicy::NonTSpinPriorOff && target))
        && (lines == 1 || lines == 2)
        && continuing_ren
        && combo_after < 6
        && cancelled == 0.0;
    Some(if high_surge {
        Conversion {
            branch: ConversionBranch::HighSurgeFinisher,
            units: release_value / 4.0,
            qualifies: true,
        }
    } else if b2b_bridge {
        Conversion {
            branch: ConversionBranch::RenQuadTsdB2bBridge,
            units: ren_combat_gain / 4.0,
            qualifies: true,
        }
    } else if setup_bridge {
        Conversion {
            branch: ConversionBranch::MiniToTsdB2bBridge,
            units: 1.25,
            qualifies: true,
        }
    } else if high_or_defensive {
        Conversion {
            branch: ConversionBranch::HighOrDefensiveRen,
            units: ren_combat_gain.max(0.0) / 4.0,
            qualifies: ren_combat_gain > 0.0,
        }
    } else if low_value {
        Conversion {
            branch: ConversionBranch::UnconvertedLowValueRen,
            units: -0.6,
            qualifies: true,
        }
    } else {
        Conversion {
            branch: ConversionBranch::Other,
            units: 0.0,
            qualifies: false,
        }
    })
}

pub fn rank_candidates(candidates: Vec<RankedCandidate>) -> Result<Vec<RankedCandidate>, CompatError> {
    rank_candidates_with_policy(candidates, FinalOrderPolicy::S2Rerank)
}

pub fn rank_candidates_with_policy(
    mut candidates: Vec<RankedCandidate>,
    final_order_policy: FinalOrderPolicy,
) -> Result<Vec<RankedCandidate>, CompatError> {
    if candidates.is_empty() {
        return Err(CompatError::EmptyCandidates);
    }
    let mut ranks: Vec<i32> = candidates.iter().map(|candidate| candidate.cc2_rank).collect();
    ranks.sort_unstable();
    if ranks.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(CompatError::DuplicateCc2Rank);
    }
    for candidate in &mut candidates {
        if !candidate.s2_score.is_finite() || !candidate.conversion.units.is_finite() {
            return Err(CompatError::NonFiniteFeature);
        }
        candidate.selection_score =
            selection_score(candidate.s2_score, candidate.conversion.units, candidate.cc2_rank);
        crate::s2_audit::post_stage_conversion_add();
    }
    crate::s2_audit::post_stage_rerank();
    match final_order_policy {
        FinalOrderPolicy::S2Rerank => candidates.sort_by(|left, right| {
            right
                .selection_score
                .partial_cmp(&left.selection_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(left.cc2_rank.cmp(&right.cc2_rank))
                .then(left.identity.cmp(&right.identity))
        }),
        FinalOrderPolicy::Cc2RankOrder => candidates.sort_by(|left, right| {
            left.cc2_rank
                .cmp(&right.cc2_rank)
                .then(left.identity.cmp(&right.identity))
        }),
    }
    Ok(candidates)
}

pub fn choose_rescue(candidates: &[RankedCandidate]) -> Result<(bool, usize), CompatError> {
    crate::s2_audit::rescue();
    if candidates.is_empty() {
        return Err(CompatError::EmptyCandidates);
    }
    if candidates.iter().any(|candidate| !candidate.solvency.is_finite()) {
        return Err(CompatError::InvalidSolvency);
    }
    let control = &candidates[0];
    let solvent = candidates.iter().position(|candidate| candidate.solvent);
    let rescued = control.solvency < 0.0 && solvent.is_some();
    Ok((rescued, if rescued { solvent.unwrap() } else { 0 }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockBoardView<'a> {
    pub fidelity: &'a str,
    pub width: i32,
    pub height: i32,
    pub cells: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FeatureProjection {
    pub amount_topped_out: bool,
    pub remaining_rows: f64,
    pub tank_rows: f64,
    pub visible_margin_after_lock: f64,
    pub outgoing_before_cancel: f64,
    pub outgoing_after_cancel: f64,
    pub cancelled_rows: f64,
    pub combo_after: f64,
    pub b2b_after: f64,
    pub surge_sent: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoardMetrics {
    pub aggregate_height: f64,
    pub max_height: f64,
    pub holes: f64,
    pub bumpiness: f64,
    pub occupied_height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct F14Incoming {
    pub pending_rows: u32,
    pub due_this_lock_rows: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct F14LockPublic {
    pub lines: u32,
    pub spin: String,
    pub perfect_clear: bool,
    pub combo_after: u32,
    pub b2b_after: u32,
    pub b2b_before: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct F14ChainDelta {
    pub combo_before: u32,
    pub combo_after: u32,
    pub b2b_before: u32,
    pub b2b_after: u32,
    pub broke_b2b: bool,
    pub broken_b2b_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct F14Surge {
    pub amount: u32,
    pub first: u32,
    pub chunks: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct F14Pieces {
    pub current: Option<String>,
    pub hold: Option<String>,
    pub known: Vec<String>,
    pub hold_available: bool,
}

fn is_cell_char(ch: char) -> bool {
    matches!(ch, 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z' | 'G' | '_')
}

fn parse_lock_board(board: LockBoardView<'_>) -> Result<(), CompatError> {
    if board.fidelity != "exact"
        || board.width < 1
        || board.height < 1
        || board.cells.len() != (board.width as usize) * (board.height as usize)
        || !board.cells.chars().all(is_cell_char)
    {
        return Err(CompatError::InvalidLockBoard);
    }
    Ok(())
}

pub fn occupied_height(board: LockBoardView<'_>) -> Result<u32, CompatError> {
    parse_lock_board(board)?;
    let width = board.width as usize;
    let height = board.height as usize;
    let cells: Vec<char> = board.cells.chars().collect();
    for y in (0..height).rev() {
        for x in 0..width {
            if cells[y * width + x] != '_' {
                return Ok((y + 1) as u32);
            }
        }
    }
    Ok(0)
}

pub fn lock_board_metrics(board: LockBoardView<'_>) -> Result<BoardMetrics, CompatError> {
    parse_lock_board(board)?;
    let width = board.width as usize;
    let height = board.height as usize;
    let cells: Vec<char> = board.cells.chars().collect();
    let mut heights = vec![0i32; width];
    let mut holes = 0i32;
    for x in 0..width {
        let mut highest = -1;
        for y in (0..height).rev() {
            if cells[y * width + x] != '_' {
                highest = y as i32;
                break;
            }
        }
        heights[x] = highest + 1;
        if highest >= 0 {
            for y in 0..highest as usize {
                if cells[y * width + x] == '_' {
                    holes += 1;
                }
            }
        }
    }
    let mut bumpiness = 0i32;
    for x in 1..width {
        bumpiness += (heights[x] - heights[x - 1]).abs();
    }
    Ok(BoardMetrics {
        aggregate_height: heights.iter().sum::<i32>() as f64,
        max_height: heights.iter().copied().max().unwrap_or(0) as f64,
        holes: holes as f64,
        bumpiness: bumpiness as f64,
        occupied_height: occupied_height(board)? as f64,
    })
}

/// Occupancy and materialized-G bitboards for a canonical 10×40 lockBoard.
/// Color minos occupy without G bits; `G` occupies both. Bits above row 40 stay 0.
pub fn occupancy_from_lock_board(board: LockBoardView<'_>) -> Result<(Board, Board), CompatError> {
    parse_lock_board(board)?;
    if board.width != 10 || board.height != 40 {
        return Err(CompatError::InvalidLockBoard);
    }
    let cells: Vec<char> = board.cells.chars().collect();
    let mut occupancy = [0u64; 10];
    let mut garbage = [0u64; 10];
    for y in 0..40 {
        for x in 0..10 {
            match cells[y * 10 + x] {
                '_' => {}
                'G' => {
                    occupancy[x] |= 1 << y;
                    garbage[x] |= 1 << y;
                }
                _ => occupancy[x] |= 1 << y,
            }
        }
    }
    if occupancy.iter().any(|col| col >> 40 != 0) || garbage.iter().any(|col| col >> 40 != 0) {
        return Err(CompatError::InvalidLockBoard);
    }
    if garbage
        .iter()
        .zip(occupancy.iter())
        .any(|(g, occ)| g & !occ != 0)
    {
        return Err(CompatError::InvalidLockBoard);
    }
    Ok((Board { cols: occupancy }, Board { cols: garbage }))
}

pub fn metrics_from_occupancy(board: &Board) -> BoardMetrics {
    let mut heights = [0u32; 10];
    let mut holes = 0u32;
    let mut occupied = 0u32;
    for x in 0..10 {
        let col = board.cols[x] & ((1u64 << 40) - 1);
        let height = if col == 0 {
            0
        } else {
            64 - col.leading_zeros()
        };
        heights[x] = height;
        holes += height.saturating_sub(col.count_ones());
        if height > occupied {
            occupied = height;
        }
    }
    let mut bumpiness = 0u32;
    for x in 1..10 {
        bumpiness += heights[x].abs_diff(heights[x - 1]);
    }
    BoardMetrics {
        aggregate_height: heights.iter().sum::<u32>() as f64,
        max_height: heights.iter().copied().max().unwrap_or(0) as f64,
        holes: holes as f64,
        bumpiness: bumpiness as f64,
        occupied_height: occupied as f64,
    }
}

pub fn amount_only_features_from_metrics(
    metrics: BoardMetrics,
    projection: FeatureProjection,
) -> [f64; 19] {
    let topped_out = if projection.amount_topped_out { 1.0 } else { 0.0 };
    [
        metrics.aggregate_height,
        metrics.max_height,
        metrics.holes,
        metrics.bumpiness,
        topped_out,
        0.0,
        projection.remaining_rows,
        0.0,
        0.0,
        0.0,
        projection.tank_rows,
        projection.visible_margin_after_lock - projection.tank_rows,
        projection.outgoing_before_cancel,
        projection.outgoing_after_cancel,
        projection.cancelled_rows,
        projection.combo_after,
        projection.b2b_after,
        projection.b2b_after,
        projection.surge_sent,
    ]
}

pub fn extract_amount_only_decision_features(
    board: LockBoardView<'_>,
    projection: FeatureProjection,
) -> Result<[f64; 19], CompatError> {
    let metrics = lock_board_metrics(board)?;
    Ok(amount_only_features_from_metrics(metrics, projection))
}

pub fn extract_amount_only_feature_object(
    board: LockBoardView<'_>,
    projection: FeatureProjection,
) -> Result<Map<String, Value>, CompatError> {
    let values = extract_amount_only_decision_features(board, projection)?;
    let mut map = Map::new();
    map.insert("$schema".into(), Value::String(FEATURE_SCHEMA_ID.into()));
    map.insert(
        "schemaVersion".into(),
        Value::from(FEATURE_SCHEMA_VERSION),
    );
    for (index, name) in FEATURE_NAMES.iter().enumerate() {
        let number = serde_json::Number::from_f64(values[index]).ok_or(CompatError::NonFiniteFeature)?;
        map.insert((*name).into(), Value::Number(number));
    }
    Ok(map)
}

pub fn score_feature_map(
    features: &Map<String, Value>,
    weights: &[f64; 19],
) -> Result<f64, CompatError> {
    match features.get("$schema").and_then(Value::as_str) {
        Some(FEATURE_SCHEMA_ID) => {}
        _ => return Err(CompatError::SchemaMismatch),
    }
    match features.get("schemaVersion").and_then(Value::as_u64) {
        Some(version) if version == u64::from(FEATURE_SCHEMA_VERSION) => {}
        _ => return Err(CompatError::SchemaVersionMismatch),
    }
    for key in features.keys() {
        if key != "$schema"
            && key != "schemaVersion"
            && !FEATURE_NAMES.iter().any(|name| *name == key)
        {
            return Err(CompatError::UnknownFeature);
        }
    }
    let mut aligned = [0.0; 19];
    for (index, name) in FEATURE_NAMES.iter().enumerate() {
        let value = features
            .get(*name)
            .and_then(Value::as_f64)
            .ok_or(CompatError::NonFiniteFeature)?;
        aligned[index] = value;
    }
    score_evaluation_features(&aligned, weights)
}

fn require_u8(value: u32) -> Result<u8, CompatError> {
    u8::try_from(value).map_err(|_| CompatError::InvalidIncoming)
}

fn parse_f14_spin(spin: &str) -> Result<Spin, CompatError> {
    match spin {
        "none" => Ok(Spin::None),
        "mini" => Ok(Spin::Mini),
        "normal" => Ok(Spin::Full),
        _ => Err(CompatError::InvalidSpin),
    }
}

/// Selector binding over `data::advance_amount_only`. Incoming0 returns before
/// chain/spin u8 conversion so canonical combo/B2B 256 is not rejected on route A.
pub fn advance_f14_amount_only(
    incoming: F14Incoming,
    lock: &F14LockPublic,
) -> Result<AmountDelta, CompatError> {
    let pending = require_u8(incoming.pending_rows)?;
    let due = require_u8(incoming.due_this_lock_rows)?;
    if due > pending {
        return Err(CompatError::InvalidIncoming);
    }
    if pending == 0 && due == 0 {
        return advance_amount_only(
            0,
            0,
            lock.lines,
            Spin::None,
            false,
            0,
            0,
            0,
        )
        .map_err(|_| CompatError::InvalidIncoming);
    }
    let spin = parse_f14_spin(&lock.spin)?;
    let combo_after = u8::try_from(lock.combo_after).map_err(|_| CompatError::ChainOutOfU8)?;
    let b2b_after = u8::try_from(lock.b2b_after).map_err(|_| CompatError::ChainOutOfU8)?;
    let b2b_before = u8::try_from(lock.b2b_before).map_err(|_| CompatError::ChainOutOfU8)?;
    let outgoing = amount_only_search_attack(
        lock.lines,
        spin,
        lock.perfect_clear,
        combo_after,
        b2b_after,
        b2b_before,
    )
    .unwrap_or(0);
    if lock.lines == 0 && outgoing != 0 {
        return Err(CompatError::InconsistentSearchAttack);
    }
    advance_amount_only(
        pending,
        due,
        lock.lines,
        spin,
        lock.perfect_clear,
        combo_after,
        b2b_after,
        b2b_before,
    )
    .map_err(|_| CompatError::InvalidIncoming)
}

pub fn advance_f14_chain(
    combo: u32,
    b2b: u32,
    lines: u32,
    spin: &str,
    perfect_clear: bool,
    perfect_clear_b2b_bonus: u32,
) -> Result<F14ChainDelta, CompatError> {
    parse_f14_spin(spin)?;
    let combo_after = if lines > 0 {
        combo.checked_add(1).ok_or(CompatError::InvalidIncoming)?
    } else {
        0
    };
    let mut b2b_after = b2b;
    let mut broke_b2b = false;
    let mut broken_b2b_count = 0;
    if lines > 0 {
        let difficult = spin != "none" || lines >= 4;
        if perfect_clear && perfect_clear_b2b_bonus > 0 {
            b2b_after = b2b
                .checked_add(perfect_clear_b2b_bonus)
                .ok_or(CompatError::InvalidIncoming)?;
        } else if difficult {
            b2b_after = b2b.checked_add(1).ok_or(CompatError::InvalidIncoming)?;
        } else {
            broke_b2b = b2b > 0;
            broken_b2b_count = b2b;
            b2b_after = 0;
        }
    }
    Ok(F14ChainDelta {
        combo_before: combo,
        combo_after,
        b2b_before: b2b,
        b2b_after,
        broke_b2b,
        broken_b2b_count,
    })
}

pub fn calculate_f14_surge(
    broken_b2b_count: u32,
    charging: Option<(u32, u32)>,
    multiplier: f64,
) -> Result<F14Surge, CompatError> {
    if !multiplier.is_finite() || multiplier < 0.0 {
        return Err(CompatError::InvalidSurge);
    }
    let Some((at, base)) = charging else {
        return Ok(F14Surge {
            amount: 0,
            first: 0,
            chunks: Vec::new(),
        });
    };
    if broken_b2b_count <= at {
        return Ok(F14Surge {
            amount: 0,
            first: 0,
            chunks: Vec::new(),
        });
    }
    let raw = (f64::from(broken_b2b_count - at + base)) * multiplier;
    if !raw.is_finite() || raw < 0.0 || raw.floor() > f64::from(u32::MAX) {
        return Err(CompatError::InvalidSurge);
    }
    let amount = raw.floor() as u32;
    let first = if amount == 0 {
        0
    } else {
        (f64::from(amount) / 3.0).round() as u32
    };
    let chunks = [first, first, amount.saturating_sub(2 * first)]
        .into_iter()
        .filter(|chunk| *chunk > 0)
        .collect();
    Ok(F14Surge {
        amount,
        first,
        chunks,
    })
}

pub fn apply_f14_lock_blocks(
    cells: &str,
    width: i32,
    height: i32,
    blocks: &[(i32, i32, char)],
) -> Result<(String, u32, bool), CompatError> {
    parse_lock_board(LockBoardView {
        fidelity: "exact",
        width,
        height,
        cells,
    })?;
    let width_us = width as usize;
    let height_us = height as usize;
    let mut grid: Vec<Vec<char>> = (0..height_us)
        .map(|y| cells.chars().skip(y * width_us).take(width_us).collect())
        .collect();
    for &(x, y, cell) in blocks {
        if x < 0 || y < 0 || x >= width || y >= height || !is_cell_char(cell) || cell == '_' {
            return Err(CompatError::InvalidLockBoard);
        }
        let slot = &mut grid[y as usize][x as usize];
        if *slot != '_' {
            return Err(CompatError::OverlappingLockBlock);
        }
        *slot = cell;
    }
    let mut kept = Vec::new();
    let mut lines = 0u32;
    for row in grid {
        if row.iter().all(|&cell| cell != '_') {
            lines += 1;
        } else {
            kept.push(row);
        }
    }
    while kept.len() < height_us {
        kept.push(vec!['_'; width_us]);
    }
    let perfect_clear = lines > 0 && kept.iter().all(|row| row.iter().all(|&cell| cell == '_'));
    let out: String = kept.into_iter().flatten().collect();
    Ok((out, lines, perfect_clear))
}

pub fn advance_f14_pieces(pieces: &F14Pieces, used_hold: bool) -> Result<F14Pieces, CompatError> {
    if used_hold && !pieces.hold_available {
        return Err(CompatError::HoldUnavailable);
    }
    let after = if !used_hold {
        F14Pieces {
            current: pieces.known.first().cloned(),
            hold: pieces.hold.clone(),
            known: pieces.known.get(1..).unwrap_or(&[]).to_vec(),
            hold_available: true,
        }
    } else if pieces.hold.is_some() {
        F14Pieces {
            current: pieces.known.first().cloned(),
            hold: pieces.current.clone(),
            known: pieces.known.get(1..).unwrap_or(&[]).to_vec(),
            hold_available: true,
        }
    } else {
        F14Pieces {
            current: pieces.known.get(1).cloned(),
            hold: pieces.current.clone(),
            known: pieces.known.get(2..).unwrap_or(&[]).to_vec(),
            hold_available: true,
        }
    };
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::Path;

    fn bits(hex: &str) -> f64 {
        f64::from_bits(u64::from_str_radix(hex, 16).unwrap())
    }

    fn hex_bits(value: f64) -> String {
        format!("{:016x}", value.to_bits())
    }

    fn load_fixture() -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/diagnostics/cc2-s2-f14-amount-only-native-compat-p2-ranking.json");
        serde_json::from_str(&std::fs::read_to_string(&path).expect("p2 ranking fixture"))
            .expect("p2 ranking json")
    }

    fn load_p3() -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/diagnostics/cc2-s2-f14-amount-only-native-compat-p3.json");
        serde_json::from_str(&std::fs::read_to_string(&path).expect("p3 fixture"))
            .expect("p3 json")
    }

    fn load_p4() -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/diagnostics/cc2-s2-f14-amount-only-native-compat-p4.json");
        serde_json::from_str(&std::fs::read_to_string(&path).expect("p4 fixture"))
            .expect("p4 json")
    }

    fn lock_board_view(value: &Value) -> LockBoardView<'_> {
        LockBoardView {
            fidelity: value["fidelity"].as_str().unwrap(),
            width: value["width"].as_i64().unwrap() as i32,
            height: value["height"].as_i64().unwrap() as i32,
            cells: value["cells"].as_str().unwrap(),
        }
    }

    fn feature_projection(value: &Value) -> FeatureProjection {
        FeatureProjection {
            amount_topped_out: value["amountToppedOut"].as_bool().unwrap(),
            remaining_rows: value["remainingRows"].as_f64().unwrap(),
            tank_rows: value["tankRows"].as_f64().unwrap(),
            visible_margin_after_lock: value["visibleMarginAfterLock"].as_f64().unwrap(),
            outgoing_before_cancel: value["outgoingBeforeCancel"].as_f64().unwrap(),
            outgoing_after_cancel: value["outgoingAfterCancel"].as_f64().unwrap(),
            cancelled_rows: value["cancelledRows"].as_f64().unwrap(),
            combo_after: value["comboAfter"].as_f64().unwrap(),
            b2b_after: value["b2bAfter"].as_f64().unwrap(),
            surge_sent: value["surgeSent"].as_f64().unwrap(),
        }
    }

    fn lock_public(value: &Value) -> F14LockPublic {
        F14LockPublic {
            lines: value["lines"].as_u64().unwrap() as u32,
            spin: value["spin"].as_str().unwrap().to_string(),
            perfect_clear: value["perfectClear"].as_bool().unwrap(),
            combo_after: value["comboAfter"].as_u64().unwrap() as u32,
            b2b_after: value["b2bAfter"].as_u64().unwrap() as u32,
            b2b_before: value["b2bBefore"].as_u64().unwrap() as u32,
        }
    }

    fn incoming_of(value: &Value) -> F14Incoming {
        F14Incoming {
            pending_rows: value["pendingRows"].as_u64().unwrap() as u32,
            due_this_lock_rows: value["dueThisLockRows"].as_u64().unwrap() as u32,
        }
    }

    fn optional_piece(value: &Value) -> Option<String> {
        if value.is_null() {
            None
        } else {
            Some(value.as_str().unwrap().to_string())
        }
    }

    fn pieces_of(value: &Value) -> F14Pieces {
        F14Pieces {
            current: optional_piece(&value["current"]),
            hold: optional_piece(&value["hold"]),
            known: value["known"]
                .as_array()
                .unwrap()
                .iter()
                .map(|piece| piece.as_str().unwrap().to_string())
                .collect(),
            hold_available: value["holdAvailable"].as_bool().unwrap(),
        }
    }

    fn bits19(value: &Value) -> [f64; 19] {
        let items = value.as_array().unwrap();
        assert_eq!(items.len(), 19);
        let mut out = [0.0; 19];
        for (index, item) in items.iter().enumerate() {
            out[index] = bits(item.as_str().unwrap());
        }
        out
    }

    #[test]
    fn p2_frozen_decisions_match_js_bits_order_and_rescue() {
        let fixture = load_fixture();
        let names = fixture["featureNames"].as_array().unwrap();
        assert_eq!(names.len(), FEATURE_NAMES.len());
        for (index, name) in FEATURE_NAMES.iter().enumerate() {
            assert_eq!(names[index].as_str().unwrap(), *name);
        }
        let weights = bits19(&fixture["weightBits"]);
        for decision in fixture["decisions"].as_array().unwrap() {
            let mut computed = Vec::new();
            for candidate in decision["candidates"].as_array().unwrap() {
                let features = bits19(&candidate["featureBits"]);
                let s2_score = score_evaluation_features(&features, &weights).unwrap();
                assert_eq!(hex_bits(s2_score), candidate["s2ScoreBits"].as_str().unwrap());
                let conv = &candidate["conversion"];
                let classified = classify_conversion(
                    conv["comboBefore"].as_u64().unwrap() as u32,
                    conv["comboAfter"].as_u64().unwrap() as u32,
                    conv["b2bBefore"].as_u64().unwrap() as u32,
                    conv["b2bAfter"].as_u64().unwrap() as u32,
                    conv["lines"].as_u64().unwrap() as u32,
                    conv["spin"].as_str().unwrap(),
                    bits(conv["cancelledBits"].as_str().unwrap()),
                    bits(conv["renCombatGainBits"].as_str().unwrap()),
                    conv["setupWitnessed"].as_bool().unwrap(),
                    conv["surgeSent"].as_u64().unwrap() as u32,
                    bits(conv["releaseValueBits"].as_str().unwrap()),
                )
                .unwrap();
                assert_eq!(classified.branch.as_str(), conv["branch"].as_str().unwrap());
                assert_eq!(hex_bits(classified.units), conv["unitsBits"].as_str().unwrap());
                assert_eq!(classified.qualifies, conv["qualifies"].as_bool().unwrap());
                let selection = selection_score(s2_score, classified.units, candidate["cc2Rank"].as_i64().unwrap() as i32);
                assert_eq!(hex_bits(selection), candidate["selectionScoreBits"].as_str().unwrap());
                computed.push(RankedCandidate {
                    cc2_rank: candidate["cc2Rank"].as_i64().unwrap() as i32,
                    identity: candidate["identity"].as_str().unwrap().to_string(),
                    s2_score,
                    conversion: classified,
                    solvency: candidate["solvency"].as_f64().unwrap(),
                    solvent: candidate["solvent"].as_bool().unwrap(),
                    selection_score: 0.0,
                });
            }
            let ranked = rank_candidates(computed).unwrap();
            let expected = decision["candidates"].as_array().unwrap();
            assert_eq!(ranked.len(), expected.len());
            for (index, candidate) in ranked.iter().enumerate() {
                assert_eq!(candidate.cc2_rank, expected[index]["cc2Rank"].as_i64().unwrap() as i32);
                assert_eq!(candidate.identity, expected[index]["identity"].as_str().unwrap());
                assert_eq!(hex_bits(candidate.selection_score), expected[index]["selectionScoreBits"].as_str().unwrap());
            }
            let (rescued, selected) = choose_rescue(&ranked).unwrap();
            assert_eq!(rescued, decision["rescueApplied"].as_bool().unwrap());
            assert_eq!(selected, decision["selectedIndex"].as_u64().unwrap() as usize);
            assert_eq!(ranked[selected].cc2_rank, decision["selectedCc2Rank"].as_i64().unwrap() as i32);
        }
    }

    #[test]
    fn p2c_synthetic_ranking_and_near_ties() {
        let fixture = load_fixture();
        for case in fixture["syntheticRanking"]["cases"].as_array().unwrap() {
            let input = case["input"].as_array().unwrap();
            let ranked = rank_candidates(
                input
                    .iter()
                    .map(|candidate| RankedCandidate {
                        cc2_rank: candidate["cc2Rank"].as_i64().unwrap() as i32,
                        identity: candidate["identity"].as_str().unwrap().to_string(),
                        s2_score: bits(candidate["s2ScoreBits"].as_str().unwrap()),
                        conversion: Conversion {
                            branch: ConversionBranch::Other,
                            units: bits(candidate["unitsBits"].as_str().unwrap()),
                            qualifies: false,
                        },
                        solvency: 18.0,
                        solvent: true,
                        selection_score: 0.0,
                    })
                    .collect(),
            )
            .unwrap();
            let expected: Vec<i32> = case["expectedCc2RankOrder"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_i64().unwrap() as i32)
                .collect();
            let actual: Vec<i32> = ranked.iter().map(|candidate| candidate.cc2_rank).collect();
            assert_eq!(actual, expected, "{}", case["id"].as_str().unwrap());
        }
        assert_eq!(
            rank_candidates(vec![
                RankedCandidate {
                    cc2_rank: 0,
                    identity: "a".into(),
                    s2_score: 0.0,
                    conversion: Conversion {
                        branch: ConversionBranch::Other,
                        units: 0.0,
                        qualifies: false,
                    },
                    solvency: 0.0,
                    solvent: true,
                    selection_score: 0.0,
                },
                RankedCandidate {
                    cc2_rank: 0,
                    identity: "b".into(),
                    s2_score: 1.0,
                    conversion: Conversion {
                        branch: ConversionBranch::Other,
                        units: 0.0,
                        qualifies: false,
                    },
                    solvency: 0.0,
                    solvent: true,
                    selection_score: 0.0,
                },
            ]),
            Err(CompatError::DuplicateCc2Rank)
        );
    }

    #[test]
    fn cc2_rank_order_policy_keeps_diagnostics_but_disables_rerank_order() {
        let candidate = |cc2_rank, s2_score| RankedCandidate {
            cc2_rank,
            identity: format!("candidate-{cc2_rank}"),
            s2_score,
            conversion: Conversion {
                branch: ConversionBranch::Other,
                units: 0.0,
                qualifies: false,
            },
            solvency: 1.0,
            solvent: true,
            selection_score: 0.0,
        };
        let reranked = rank_candidates(vec![candidate(0, 0.0), candidate(1, 100.0)]).unwrap();
        assert_eq!(reranked.iter().map(|candidate| candidate.cc2_rank).collect::<Vec<_>>(), vec![1, 0]);
        let cc2_ordered = rank_candidates_with_policy(
            vec![candidate(0, 0.0), candidate(1, 100.0)],
            FinalOrderPolicy::Cc2RankOrder,
        )
        .unwrap();
        assert_eq!(cc2_ordered.iter().map(|candidate| candidate.cc2_rank).collect::<Vec<_>>(), vec![0, 1]);
        assert_eq!(cc2_ordered[0].selection_score, 0.0);
        assert_eq!(cc2_ordered[1].selection_score, 75.0);
    }

    #[test]
    fn p2d_synthetic_rescue_and_rejection() {
        let fixture = load_fixture();
        for case in fixture["syntheticRescue"]["cases"].as_array().unwrap() {
            let ranked: Vec<RankedCandidate> = case["input"]
                .as_array()
                .unwrap()
                .iter()
                .map(|candidate| RankedCandidate {
                    cc2_rank: candidate["cc2Rank"].as_i64().unwrap() as i32,
                    identity: candidate["identity"].as_str().unwrap().to_string(),
                    s2_score: 0.0,
                    conversion: Conversion {
                        branch: ConversionBranch::Other,
                        units: 0.0,
                        qualifies: false,
                    },
                    solvency: candidate["solvency"].as_f64().unwrap(),
                    solvent: candidate["solvent"].as_bool().unwrap(),
                    selection_score: 0.0,
                })
                .collect();
            let (rescued, selected) = choose_rescue(&ranked).unwrap();
            assert_eq!(rescued, case["rescued"].as_bool().unwrap(), "{}", case["id"].as_str().unwrap());
            assert_eq!(selected, case["selectedIndex"].as_u64().unwrap() as usize);
        }
        assert_eq!(choose_rescue(&[]), Err(CompatError::EmptyCandidates));
        let nan = RankedCandidate {
            cc2_rank: 0,
            identity: "nan".into(),
            s2_score: 0.0,
            conversion: Conversion {
                branch: ConversionBranch::Other,
                units: 0.0,
                qualifies: false,
            },
            solvency: f64::NAN,
            solvent: false,
            selection_score: 0.0,
        };
        assert_eq!(choose_rescue(&[nan]), Err(CompatError::InvalidSolvency));
    }

    #[test]
    fn p2b_synthetic_conversion_covers_all_six_branches() {
        let fixture = load_fixture();
        let mut seen = std::collections::BTreeSet::new();
        for case in fixture["syntheticConversion"]["cases"].as_array().unwrap() {
            let input = &case["input"];
            let classified = classify_conversion(
                input["comboBefore"].as_u64().unwrap() as u32,
                input["comboAfter"].as_u64().unwrap() as u32,
                input["b2bBefore"].as_u64().unwrap() as u32,
                input["b2bAfter"].as_u64().unwrap() as u32,
                input["lines"].as_u64().unwrap() as u32,
                input["spin"].as_str().unwrap(),
                bits(input["cancelledBits"].as_str().unwrap()),
                bits(input["renCombatGainBits"].as_str().unwrap()),
                input["setupWitnessed"].as_bool().unwrap(),
                input["surgeSent"].as_u64().unwrap() as u32,
                bits(input["releaseValueBits"].as_str().unwrap()),
            )
            .unwrap();
            let expected = &case["expected"];
            assert_eq!(classified.branch.as_str(), expected["branch"].as_str().unwrap(), "{}", case["id"].as_str().unwrap());
            assert_eq!(hex_bits(classified.units), expected["unitsBits"].as_str().unwrap(), "{}", case["id"].as_str().unwrap());
            assert_eq!(classified.qualifies, expected["qualifies"].as_bool().unwrap(), "{}", case["id"].as_str().unwrap());
            seen.insert(classified.branch.as_str());
        }
        assert_eq!(
            seen.iter().copied().collect::<Vec<_>>(),
            vec![
                "high-or-defensive-ren",
                "high-surge-finisher",
                "mini-to-tsd-b2b-bridge",
                "other",
                "ren-quad-tsd-b2b-bridge",
                "unconverted-low-value-ren",
            ]
        );
    }

    #[test]
    fn classify_conversion_accepts_u32_b2b_that_does_not_fit_i32() {
        let classified = classify_conversion(
            0,
            0,
            2_147_483_648,
            2_147_483_648,
            0,
            "none",
            0.0,
            0.0,
            false,
            0,
            0.0,
        )
        .unwrap();
        assert_eq!(classified.branch, ConversionBranch::Other);
        assert_eq!(classified.units, 0.0);
        assert!(!classified.qualifies);
    }

    fn classify(
        policy: PostSpinPolicy,
        piece: &str,
        combo_before: u32,
        combo_after: u32,
        b2b_after: u32,
        lines: u32,
        spin: &str,
        cancelled: f64,
        setup_witnessed: bool,
    ) -> Conversion {
        classify_conversion_for_policy(
            policy,
            piece,
            combo_before,
            combo_after,
            0,
            b2b_after,
            lines,
            spin,
            cancelled,
            1.0,
            setup_witnessed,
            0,
            0.0,
        )
        .unwrap()
    }

    #[test]
    fn legacy_policy_matches_classify_conversion_for_non_t_and_t() {
        for piece in ["I", "J", "L", "S", "Z", "O", "T"] {
            for spin in ["none", "mini", "normal"] {
                for lines in [0u32, 1, 2, 3] {
                    let left = classify_conversion(1, 2, 0, 1, lines, spin, 0.0, 1.0, true, 0, 0.0);
                    let right = classify_conversion_for_policy(
                        PostSpinPolicy::LegacyF14,
                        piece,
                        1,
                        2,
                        0,
                        1,
                        lines,
                        spin,
                        0.0,
                        1.0,
                        true,
                        0,
                        0.0,
                    );
                    assert_eq!(left, right, "{piece} {spin} {lines}");
                }
            }
        }
    }

    #[test]
    fn non_t_policy_drops_setup_bridge_and_applies_low_value_ren() {
        let legacy = classify(PostSpinPolicy::LegacyF14, "I", 1, 2, 1, 1, "mini", 0.0, true);
        let off = classify(PostSpinPolicy::NonTSpinPriorOff, "I", 1, 2, 1, 1, "mini", 0.0, true);
        assert_eq!(legacy.branch, ConversionBranch::MiniToTsdB2bBridge);
        assert_eq!(legacy.units, 1.25);
        assert_eq!(off.branch, ConversionBranch::UnconvertedLowValueRen);
        assert_eq!(off.units, -0.6);
        assert_eq!(
            crate::f14_compat::selection_score(0.0, off.units, 0)
                - crate::f14_compat::selection_score(0.0, legacy.units, 0),
            -51.8
        );
    }

    #[test]
    fn non_t_policy_falls_back_to_defensive_ren_when_cancel_exists() {
        let off = classify(PostSpinPolicy::NonTSpinPriorOff, "J", 1, 2, 1, 1, "mini", 1.0, true);
        assert_eq!(off.branch, ConversionBranch::HighOrDefensiveRen);
        assert!(off.qualifies);
    }

    #[test]
    fn non_t_policy_falls_back_to_high_ren_at_combo_six() {
        let off = classify(PostSpinPolicy::NonTSpinPriorOff, "L", 5, 6, 1, 1, "mini", 0.0, true);
        assert_eq!(off.branch, ConversionBranch::HighOrDefensiveRen);
    }

    #[test]
    fn non_t_policy_does_not_rewrite_t_mini_or_tss() {
        for (piece, spin, lines) in [("T", "mini", 1u32), ("T", "normal", 1u32)] {
            let legacy = classify(PostSpinPolicy::LegacyF14, piece, 1, 2, 1, lines, spin, 0.0, true);
            let off = classify(PostSpinPolicy::NonTSpinPriorOff, piece, 1, 2, 1, lines, spin, 0.0, true);
            assert_eq!(legacy, off, "{piece} {spin}");
            assert_eq!(legacy.branch, ConversionBranch::MiniToTsdB2bBridge);
        }
    }

    #[test]
    fn non_t_zero_line_spin_is_not_a_target() {
        let legacy = classify(PostSpinPolicy::LegacyF14, "I", 1, 2, 1, 0, "mini", 0.0, true);
        let off = classify(PostSpinPolicy::NonTSpinPriorOff, "I", 1, 2, 1, 0, "mini", 0.0, true);
        assert_eq!(legacy, off);
        assert_eq!(legacy.branch, ConversionBranch::Other);
    }

    #[test]
    fn p2a_rejects_non_unit_topped_out_and_nonfinite() {
        let fixture = load_fixture();
        let weights = bits19(&fixture["weightBits"]);
        let mut features = [0.0; 19];
        features[4] = 2.0;
        assert_eq!(
            score_evaluation_features(&features, &weights),
            Err(CompatError::ToppedOutNotUnit)
        );
        features[4] = 0.0;
        features[0] = f64::NAN;
        assert_eq!(
            score_evaluation_features(&features, &weights),
            Err(CompatError::NonFiniteFeature)
        );
    }

    #[test]
    fn p3a_lock_board_features_match_js_bits_and_p2_scores() {
        let p3 = load_p3();
        assert_eq!(p3["featureSchema"]["id"].as_str().unwrap(), FEATURE_SCHEMA_ID);
        assert_eq!(p3["featureSchema"]["sha256"].as_str().unwrap(), FEATURE_SCHEMA_SHA256);
        assert_eq!(p3["featureSchema"]["version"].as_u64().unwrap(), u64::from(FEATURE_SCHEMA_VERSION));
        let weights = bits19(&p3["weightBits"]);
        for decision in p3["decisions"].as_array().unwrap() {
            for candidate in decision["candidates"].as_array().unwrap() {
                let board = lock_board_view(&candidate["lockBoard"]);
                let projection = feature_projection(&candidate["projection"]);
                let features = extract_amount_only_decision_features(board, projection).unwrap();
                let from_metrics = amount_only_features_from_metrics(
                    lock_board_metrics(board).unwrap(),
                    projection,
                );
                let expected = bits19(&candidate["featureBits"]);
                for index in 0..19 {
                    assert_eq!(hex_bits(features[index]), hex_bits(expected[index]), "{} {}", decision["id"], FEATURE_NAMES[index]);
                    assert_eq!(hex_bits(features[index]), hex_bits(from_metrics[index]), "{} {} metric contract", decision["id"], FEATURE_NAMES[index]);
                }
                let object = extract_amount_only_feature_object(board, projection).unwrap();
                assert_eq!(object.len(), 21);
                assert_eq!(
                    hex_bits(score_feature_map(&object, &weights).unwrap()),
                    candidate["s2ScoreBits"].as_str().unwrap()
                );
                assert_eq!(
                    occupied_height(board).unwrap() as f64,
                    candidate["projection"]["occupiedHeightAfterLock"].as_f64().unwrap()
                );
                if board.width == 10 && board.height == 40 {
                    let (occupancy, garbage) = occupancy_from_lock_board(board).unwrap();
                    let from_bits = metrics_from_occupancy(&occupancy);
                    let from_cells = lock_board_metrics(board).unwrap();
                    assert_eq!(from_bits.aggregate_height, from_cells.aggregate_height);
                    assert_eq!(from_bits.max_height, from_cells.max_height);
                    assert_eq!(from_bits.holes, from_cells.holes);
                    assert_eq!(from_bits.bumpiness, from_cells.bumpiness);
                    assert_eq!(from_bits.occupied_height, from_cells.occupied_height);
                    let expected_occ = candidate["occupancy"]["occupancy"].as_array().unwrap();
                    let expected_g = candidate["occupancy"]["garbage"].as_array().unwrap();
                    for x in 0..10 {
                        assert_eq!(occupancy.cols[x], u64::from_str_radix(expected_occ[x].as_str().unwrap(), 16).unwrap());
                        assert_eq!(garbage.cols[x], u64::from_str_radix(expected_g[x].as_str().unwrap(), 16).unwrap());
                        assert_eq!(garbage.cols[x] & !occupancy.cols[x], 0);
                        assert_eq!(occupancy.cols[x] >> 40, 0);
                    }
                }
            }
        }
    }

    #[test]
    fn public_amount_only_features_accept_exact_one_by_one_board() {
        let features = extract_amount_only_decision_features(
            LockBoardView {
                fidelity: "exact",
                width: 1,
                height: 1,
                cells: "_",
            },
            FeatureProjection {
                amount_topped_out: false,
                remaining_rows: 0.0,
                tank_rows: 0.0,
                visible_margin_after_lock: 0.0,
                outgoing_before_cancel: 0.0,
                outgoing_after_cancel: 0.0,
                cancelled_rows: 0.0,
                combo_after: 0.0,
                b2b_after: 0.0,
                surge_sent: 0.0,
            },
        )
        .unwrap();
        assert!(features.iter().all(|feature| feature.is_finite()));
    }

    #[test]
    fn p3a_synthetic_boards_cover_holes_g_buffer_and_mapping() {
        let p3 = load_p3();
        let weights = bits19(&p3["weightBits"]);
        let mut seen = std::collections::BTreeSet::new();
        for board_case in p3["syntheticBoards"].as_array().unwrap() {
            let board = lock_board_view(&board_case["lockBoard"]);
            let projection = feature_projection(&board_case["projection"]);
            let features = extract_amount_only_decision_features(board, projection).unwrap();
            let from_metrics = amount_only_features_from_metrics(
                lock_board_metrics(board).unwrap(),
                projection,
            );
            let expected = bits19(&board_case["featureBits"]);
            for index in 0..19 {
                assert_eq!(hex_bits(features[index]), hex_bits(expected[index]), "{} {}", board_case["id"], FEATURE_NAMES[index]);
                assert_eq!(hex_bits(features[index]), hex_bits(from_metrics[index]), "{} {} metric contract", board_case["id"], FEATURE_NAMES[index]);
            }
            let (occupancy, garbage) = occupancy_from_lock_board(board).unwrap();
            assert_eq!(metrics_from_occupancy(&occupancy), lock_board_metrics(board).unwrap());
            let native_features = amount_only_features_from_metrics(
                metrics_from_occupancy(&occupancy),
                projection,
            );
            for index in 0..19 {
                assert_eq!(hex_bits(features[index]), hex_bits(native_features[index]), "{} {} native contract", board_case["id"], FEATURE_NAMES[index]);
            }
            let expected_g = board_case["occupancy"]["garbage"].as_array().unwrap();
            for x in 0..10 {
                assert_eq!(garbage.cols[x], u64::from_str_radix(expected_g[x].as_str().unwrap(), 16).unwrap());
            }
            seen.insert(board_case["id"].as_str().unwrap());
            let object = extract_amount_only_feature_object(board, projection).unwrap();
            assert!(score_feature_map(&object, &weights).is_ok());
        }
        assert!(seen.contains("column-hole"));
        assert!(seen.contains("garbage-row"));
        assert!(seen.contains("buffer-and-g-color"));
        assert!(seen.contains("amount-topped-out"));
        assert!(seen.contains("incoming-mapping"));
        assert_eq!(
            extract_amount_only_decision_features(
                lock_board_view(&p3["syntheticBoards"][0]["lockBoard"]),
                feature_projection(&p3["syntheticBoards"][0]["projection"]),
            )
            .unwrap()[5..10],
            [0.0, 0.0, 0.0, 0.0, 0.0]
        );
        let mut unknown = extract_amount_only_feature_object(
            lock_board_view(&p3["syntheticBoards"][0]["lockBoard"]),
            feature_projection(&p3["syntheticBoards"][0]["projection"]),
        )
        .unwrap();
        unknown.insert("extra".into(), Value::from(1));
        assert_eq!(score_feature_map(&unknown, &weights), Err(CompatError::UnknownFeature));
        unknown.remove("extra");
        unknown.insert("$schema".into(), Value::String("wrong".into()));
        assert_eq!(score_feature_map(&unknown, &weights), Err(CompatError::SchemaMismatch));
        unknown.insert("$schema".into(), Value::String(FEATURE_SCHEMA_ID.into()));
        unknown.insert("schemaVersion".into(), Value::from(1));
        assert_eq!(score_feature_map(&unknown, &weights), Err(CompatError::SchemaVersionMismatch));
        assert_eq!(
            lock_board_metrics(LockBoardView {
                fidelity: "approx",
                width: 10,
                height: 40,
                cells: &"_".repeat(400),
            }),
            Err(CompatError::InvalidLockBoard)
        );
    }

    #[test]
    fn p3b_amount_advance_matches_js_and_preserves_incoming0_chain256() {
        let p3 = load_p3();
        for case in p3["syntheticAdvance"]["cases"].as_array().unwrap() {
            let delta = advance_f14_amount_only(incoming_of(&case["incoming"]), &lock_public(&case["lock"])).unwrap();
            let expected = &case["expected"];
            assert_eq!(u32::from(delta.cancelled_rows), expected["cancelledRows"].as_u64().unwrap() as u32, "{}", case["id"]);
            assert_eq!(u32::from(delta.tank_rows), expected["tankRows"].as_u64().unwrap() as u32, "{}", case["id"]);
            assert_eq!(u32::from(delta.remaining_rows), expected["remainingRows"].as_u64().unwrap() as u32, "{}", case["id"]);
            assert_eq!(u32::from(delta.outgoing_before_cancel), expected["outgoingBeforeCancel"].as_u64().unwrap() as u32, "{}", case["id"]);
            assert_eq!(u32::from(delta.outgoing_after_cancel), expected["outgoingAfterCancel"].as_u64().unwrap() as u32, "{}", case["id"]);
            assert_eq!(u32::from(delta.pending_after), expected["pendingRows"].as_u64().unwrap() as u32, "{}", case["id"]);
            assert_eq!(u32::from(delta.due_after), expected["dueThisLockRows"].as_u64().unwrap() as u32, "{}", case["id"]);
            assert_eq!(delta.search_attack_overflow, expected["searchAttackOverflow"].as_bool().unwrap(), "{}", case["id"]);
        }
        let rejects = p3["syntheticAdvance"]["rejects"].as_array().unwrap();
        assert_eq!(
            advance_f14_amount_only(incoming_of(&rejects[0]["incoming"]), &lock_public(&rejects[0]["lock"])),
            Err(CompatError::InvalidIncoming)
        );
        assert_eq!(
            advance_f14_amount_only(incoming_of(&rejects[1]["incoming"]), &lock_public(&rejects[1]["lock"])),
            Err(CompatError::InvalidIncoming)
        );
        assert_eq!(
            advance_f14_amount_only(incoming_of(&rejects[2]["incoming"]), &lock_public(&rejects[2]["lock"])),
            Err(CompatError::ChainOutOfU8)
        );
        assert_eq!(
            advance_f14_amount_only(incoming_of(&rejects[3]["incoming"]), &lock_public(&rejects[3]["lock"])),
            Err(CompatError::ChainOutOfU8)
        );
        assert_eq!(
            advance_f14_amount_only(incoming_of(&rejects[4]["incoming"]), &lock_public(&rejects[4]["lock"])),
            Err(CompatError::InvalidSpin)
        );
    }

    #[test]
    fn p3c_chain_surge_lock_and_pieces_match_js() {
        let p3 = load_p3();
        for case in p3["syntheticChain"]["cases"].as_array().unwrap() {
            let clear = &case["clear"];
            let delta = advance_f14_chain(
                case["before"]["combo"].as_u64().unwrap() as u32,
                case["before"]["b2b"].as_u64().unwrap() as u32,
                clear["lines"].as_u64().unwrap() as u32,
                clear["spin"].as_str().unwrap(),
                clear["perfectClear"].as_bool().unwrap(),
                case["rules"]["perfectClearB2bBonus"].as_u64().unwrap() as u32,
            )
            .unwrap();
            let expected = &case["expected"];
            assert_eq!(delta.combo_after, expected["comboAfter"].as_u64().unwrap() as u32, "{}", case["id"]);
            assert_eq!(delta.b2b_after, expected["b2bAfter"].as_u64().unwrap() as u32, "{}", case["id"]);
            assert_eq!(delta.broke_b2b, expected["brokeB2b"].as_bool().unwrap(), "{}", case["id"]);
            assert_eq!(delta.broken_b2b_count, expected["brokenB2bCount"].as_u64().unwrap() as u32, "{}", case["id"]);
        }
        let unclamped = p3["syntheticChain"]["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["id"] == "b2b-256-difficult-unclamped")
            .unwrap();
        assert_eq!(unclamped["expected"]["b2bAfter"].as_u64().unwrap(), 257);
        for case in p3["syntheticSurge"]["cases"].as_array().unwrap() {
            let charging = if case["charging"].as_bool() == Some(false) {
                None
            } else {
                Some((
                    case["charging"]["at"].as_u64().unwrap() as u32,
                    case["charging"]["base"].as_u64().unwrap() as u32,
                ))
            };
            let surge = calculate_f14_surge(
                case["brokenB2bCount"].as_u64().unwrap() as u32,
                charging,
                case["multiplier"].as_f64().unwrap(),
            )
            .unwrap();
            assert_eq!(surge.amount, case["expected"]["amount"].as_u64().unwrap() as u32, "{}", case["id"]);
            let chunks: Vec<u32> = case["expected"]["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap() as u32)
                .collect();
            assert_eq!(surge.chunks, chunks, "{}", case["id"]);
            assert_eq!(surge.chunks.iter().sum::<u32>(), surge.amount);
            assert_eq!(surge.amount, case["chunkSum"].as_u64().unwrap() as u32);
        }
        for case in p3["syntheticPieces"]["cases"].as_array().unwrap() {
            let after = advance_f14_pieces(&pieces_of(&case["before"]), case["usedHold"].as_bool().unwrap()).unwrap();
            assert_eq!(after, pieces_of(&case["after"]), "{}", case["id"]);
        }
        for decision in p3["decisions"].as_array().unwrap() {
            let pieces_before = pieces_of(&decision["piecesBefore"]);
            for candidate in decision["candidates"].as_array().unwrap() {
                let blocks: Vec<(i32, i32, char)> = candidate["blocks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|block| {
                        (
                            block["x"].as_i64().unwrap() as i32,
                            block["y"].as_i64().unwrap() as i32,
                            block["cell"].as_str().unwrap().chars().next().unwrap(),
                        )
                    })
                    .collect();
                let (cells, lines, perfect) = apply_f14_lock_blocks(
                    candidate["cellsBefore"].as_str().unwrap(),
                    10,
                    40,
                    &blocks,
                )
                .unwrap();
                assert_eq!(cells, candidate["lockBoard"]["cells"].as_str().unwrap(), "{}", candidate["identity"]);
                assert_eq!(lines, candidate["lines"].as_u64().unwrap() as u32);
                assert_eq!(perfect, candidate["perfectClear"].as_bool().unwrap());
                let after = advance_f14_pieces(&pieces_before, candidate["usedHold"].as_bool().unwrap()).unwrap();
                assert_eq!(after.current, optional_piece(&candidate["piecesAfter"]["current"]));
                assert_eq!(after.hold, optional_piece(&candidate["piecesAfter"]["hold"]));
                assert_eq!(
                    after.known,
                    candidate["piecesAfter"]["known"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|piece| piece.as_str().unwrap().to_string())
                        .collect::<Vec<_>>()
                );
                let chain = advance_f14_chain(
                    decision["chainBefore"]["combo"].as_u64().unwrap() as u32,
                    decision["chainBefore"]["b2b"].as_u64().unwrap() as u32,
                    candidate["lines"].as_u64().unwrap() as u32,
                    candidate["spin"].as_str().unwrap(),
                    candidate["perfectClear"].as_bool().unwrap(),
                    1,
                )
                .unwrap();
                assert_eq!(chain.combo_after as f64, candidate["projection"]["comboAfter"].as_f64().unwrap());
                assert_eq!(chain.b2b_after as f64, candidate["projection"]["b2bAfter"].as_f64().unwrap());
                let chunk_sum: u32 = candidate["surgeChunks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|chunk| chunk.as_u64().unwrap() as u32)
                    .sum();
                assert_eq!(chunk_sum, candidate["surgeAmount"].as_u64().unwrap() as u32);
                assert_eq!(chunk_sum as f64, candidate["projection"]["surgeSent"].as_f64().unwrap());
            }
        }
    }

    fn reach_pieces(value: &Value) -> ReachPieceState {
        ReachPieceState {
            current: optional_piece(&value["current"]),
            hold: optional_piece(&value["hold"]),
            known: value
                .get("known")
                .and_then(Value::as_array)
                .unwrap_or(&Vec::new())
                .iter()
                .map(|piece| piece.as_str().unwrap().to_string())
                .collect(),
            hold_available: value
                .get("holdAvailable")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        }
    }

    fn compact_equals(left: &Value, right: &Value) -> bool {
        left["piece"] == right["piece"]
            && left["rotation"] == right["rotation"]
            && left["x"] == right["x"]
            && left["y"] == right["y"]
            && left["usedHold"] == right["usedHold"]
            && left["rotationEvidence"] == right["rotationEvidence"]
    }

    #[test]
    fn p4a_cs1_matches_js_error_codes_and_identities() {
        let p4 = load_p4();
        for case in p4["cs1"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            if let Some(error) = case["error"].as_str() {
                assert_eq!(case["actualError"].as_str().unwrap(), error, "{id}");
            } else {
                assert!(!case["canonical"].as_str().unwrap().is_empty(), "{id}");
            }
        }
        for decision in p4["decisions"].as_array().unwrap() {
            for (index, move_value) in decision["moves"].as_array().unwrap().iter().enumerate() {
                let actual = canonicalize(move_value).unwrap();
                assert_eq!(actual, decision["moveIdentities"][index].as_str().unwrap());
            }
        }
        assert_eq!(
            canonicalize(&Value::Number(serde_json::Number::from_f64(1e-13).unwrap())),
            Err(Cs1Error::NumberOutOfRange)
        );
        assert_eq!(
            canonicalize(&Value::Number(serde_json::Number::from(9_007_199_254_740_992_u64))),
            Err(Cs1Error::UnsafeInteger)
        );
    }

    #[test]
    fn p4a_coords_prefix_skip_and_error_contracts() {
        let p4 = load_p4();
        let decision = &p4["decisions"][0];
        let current = decision["current"].as_str().unwrap();
        for (index, move_value) in decision["moves"].as_array().unwrap().iter().enumerate() {
            let location = gui_location_from_value(move_value).unwrap();
            let placement = cc2_move_to_canonical_placement(current, &location).unwrap();
            let expected = &decision["canonicalFromMoves"][index];
            assert_eq!(placement.piece, expected["piece"].as_str().unwrap());
            assert_eq!(placement.rotation, expected["rotation"].as_str().unwrap());
            assert_eq!(placement.x, expected["x"].as_i64().unwrap() as i32);
            assert_eq!(placement.y, expected["y"].as_i64().unwrap() as i32);
            assert_eq!(placement.used_hold, expected["usedHold"].as_bool().unwrap());
        }
        let cells_table = tetromino_cells_from_json(&p4["tetrominoCells"]);
        let board = "_".repeat(400);
        for case in p4["prefixCases"].as_array().unwrap() {
            let moves = if case["id"].as_str().unwrap() == "allow-true-17-truncates" {
                let mut moves = decision["moves"].as_array().unwrap().clone();
                moves.push(moves[0].clone());
                moves
            } else {
                decision["moves"].as_array().unwrap()[..case["moveCount"].as_u64().unwrap() as usize].to_vec()
            };
            let options = PrefixOptions {
                candidate_limit: case["extra"]["candidateLimit"].as_i64().unwrap() as i32,
                allow_complete_returned_prefix: case["extra"]["allowCompleteReturnedPrefix"].as_bool().unwrap(),
                unverifiable: UnverifiablePolicy::RecordAndSkip,
            };
            let result = build_f14_prefix(&moves, current, &options, |_, _, requested| {
                if placement_is_legal(&board, 10, 40, &cells_table, requested) {
                    Ok(requested.clone())
                } else {
                    Err("illegal".into())
                }
            })
            .unwrap();
            assert_eq!(result.accepted.len(), case["result"]["accepted"].as_array().unwrap().len(), "{}", case["id"]);
            assert_eq!(result.returned_candidate_count, case["result"]["returnedCandidateCount"].as_u64().unwrap() as usize);
            for (index, accepted) in result.accepted.iter().enumerate() {
                assert_eq!(accepted.cc2_rank, case["result"]["accepted"][index]["cc2Rank"].as_i64().unwrap() as i32);
                assert_eq!(accepted.identity, case["result"]["accepted"][index]["identity"].as_str().unwrap());
            }
        }
        assert_eq!(
            build_f14_prefix(
                &decision["moves"].as_array().unwrap()[..1],
                current,
                &PrefixOptions {
                    candidate_limit: 16,
                    allow_complete_returned_prefix: false,
                    unverifiable: UnverifiablePolicy::RecordAndSkip,
                },
                |_, _, requested| Ok(requested.clone()),
            ),
            Err(CompatError::IncompletePrefix)
        );
        let dup = vec![decision["moves"][0].clone(), decision["moves"][0].clone()];
        assert_eq!(
            build_f14_prefix(
                &dup,
                current,
                &PrefixOptions {
                    candidate_limit: 16,
                    allow_complete_returned_prefix: true,
                    unverifiable: UnverifiablePolicy::RecordAndSkip,
                },
                |_, _, requested| Ok(requested.clone()),
            ),
            Err(CompatError::DuplicateIdentity)
        );
        let illegal = serde_json::json!({"location":{"type":"T","orientation":"north","x":99,"y":0},"spin":"none"});
        assert_eq!(
            build_f14_prefix(
                &[illegal.clone()],
                current,
                &PrefixOptions {
                    candidate_limit: 16,
                    allow_complete_returned_prefix: true,
                    unverifiable: UnverifiablePolicy::RecordAndSkip,
                },
                |_, _, requested| {
                    if placement_is_legal(&board, 10, 40, &cells_table, requested) {
                        Ok(requested.clone())
                    } else {
                        Err("out-of-bounds".into())
                    }
                },
            ),
            Err(CompatError::NoVerifiableCandidate)
        );
        assert_eq!(
            build_f14_prefix(
                &[illegal],
                current,
                &PrefixOptions {
                    candidate_limit: 16,
                    allow_complete_returned_prefix: true,
                    unverifiable: UnverifiablePolicy::FailClosed,
                },
                |_, _, requested| {
                    if placement_is_legal(&board, 10, 40, &cells_table, requested) {
                        Ok(requested.clone())
                    } else {
                        Err("out-of-bounds".into())
                    }
                },
            ),
            Err(CompatError::FailClosed)
        );
        let mut bad_orientation = decision["moves"][0].clone();
        bad_orientation["location"]["orientation"] = serde_json::json!("sideways");
        let mixed = vec![bad_orientation, decision["moves"][1].clone()];
        let skipped = build_f14_prefix(
            &mixed,
            current,
            &PrefixOptions {
                candidate_limit: 16,
                allow_complete_returned_prefix: true,
                unverifiable: UnverifiablePolicy::RecordAndSkip,
            },
            |_, _, requested| Ok(requested.clone()),
        )
        .unwrap();
        assert_eq!(skipped.rejected.len(), 1);
        assert_eq!(skipped.rejected[0].cc2_rank, 0);
        assert_eq!(skipped.accepted.len(), 1);
        assert_eq!(skipped.accepted[0].cc2_rank, 1);
        assert_eq!(
            build_f14_prefix(
                &mixed,
                current,
                &PrefixOptions {
                    candidate_limit: 16,
                    allow_complete_returned_prefix: true,
                    unverifiable: UnverifiablePolicy::FailClosed,
                },
                |_, _, requested| Ok(requested.clone()),
            ),
            Err(CompatError::FailClosed)
        );
    }

    #[test]
    fn p4a_a_and_b_reachable_oracles_differ_and_match_js() {
        let p4 = load_p4();
        let cells_table = tetromino_cells_from_json(&p4["tetrominoCells"]);
        let tables = kick_tables_from_json(&p4["srs"]);
        let board = "_".repeat(400);
        for decision in p4["decisions"].as_array().unwrap() {
            let pieces = ReachPieceState {
                current: Some(decision["current"].as_str().unwrap().to_string()),
                hold: optional_piece(&decision["hold"]),
                known: decision["known"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|piece| piece.as_str().unwrap().to_string())
                    .collect(),
                hold_available: true,
            };
            let reachable_a = generate_reachable_a(&board, 10, 40, &pieces, &cells_table, &tables).unwrap();
            let expected_a = decision["reachable"].as_array().unwrap();
            assert_eq!(reachable_a.len(), expected_a.len(), "{}", decision["seed"]);
            assert_eq!(reachable_a.len(), decision["reachableCount"].as_u64().unwrap() as usize);
            for (index, expected) in expected_a.iter().enumerate() {
                assert!(
                    compact_equals(&compact_json(&reachable_a[index]), expected),
                    "A seed {} index {index}",
                    decision["seed"]
                );
            }
        }
        let decision = &p4["decisions"][0];
        let pieces = ReachPieceState {
            current: Some(decision["current"].as_str().unwrap().to_string()),
            hold: optional_piece(&decision["hold"]),
            known: decision["known"]
                .as_array()
                .unwrap()
                .iter()
                .map(|piece| piece.as_str().unwrap().to_string())
                .collect(),
            hold_available: true,
        };
        let reachable_a = generate_reachable_a(&board, 10, 40, &pieces, &cells_table, &tables).unwrap();
        let reachable_b = generate_public_reachable(&board, 10, 40, &pieces, &cells_table, &tables).unwrap();
        assert_eq!(reachable_b.len(), p4["publicReachable"]["placements"].as_array().unwrap().len());
        for (index, expected) in p4["publicReachable"]["placements"].as_array().unwrap().iter().enumerate() {
            assert!(compact_equals(&compact_json(&reachable_b[index]), expected), "B {index}");
        }
        assert!(!compact_equals(&compact_json(&reachable_a[0]), &compact_json(&reachable_b[0])));
        assert_eq!(spin_rank("normal") > spin_rank("mini"), true);
        let pose = CanonicalPlacement {
            piece: "T".into(),
            rotation: "spawn".into(),
            x: 1,
            y: 0,
            used_hold: false,
        };
        assert_eq!(final_pose_key(&pose), "T:spawn:1:0:0");
    }

    #[test]
    fn p4b_tsd_constants_cap_and_route_results() {
        let p4 = load_p4();
        assert_eq!(p4["emptyGarbage"]["generatorState"]["rngState"].as_u64().unwrap(), 123456789);
        assert_eq!(p4["tsdPlacementCap"].as_u64().unwrap(), 64);
        assert_eq!(p4["emptyGarbage"]["packets"].as_array().unwrap().len(), 0);
        for candidate in p4["decisions"][0]["tsd"].as_array().unwrap() {
            let pieces = reach_pieces(&candidate["piecesAfterLock"]);
            let available = t_available(&pieces);
            assert_eq!(available, candidate["result"]["tAvailable"].as_bool().unwrap());
            if !available {
                let result = witness_a_next_tsd(false, &[]);
                assert_eq!(result.scanned, 0);
                assert_eq!(result.witnessed, false);
            }
        }
        let early = [
            LockOutcome { spin: "none", lines: 1 },
            LockOutcome { spin: "normal", lines: 2 },
            LockOutcome { spin: "normal", lines: 2 },
        ];
        assert_eq!(
            witness_a_next_tsd(true, &early),
            TsdResult { t_available: true, scanned: 2, witnessed: true }
        );
        let mut cap_miss = vec![LockOutcome { spin: "none", lines: 0 }; 65];
        cap_miss[64] = LockOutcome { spin: "normal", lines: 2 };
        assert_eq!(
            witness_a_next_tsd(true, &cap_miss),
            TsdResult { t_available: true, scanned: 64, witnessed: false }
        );
        let mut cap_hit = vec![LockOutcome { spin: "none", lines: 0 }; 64];
        cap_hit[63] = LockOutcome { spin: "normal", lines: 2 };
        assert_eq!(
            witness_a_next_tsd(true, &cap_hit),
            TsdResult { t_available: true, scanned: 64, witnessed: true }
        );
        let b_early = [("I", LockOutcome { spin: "none", lines: 0 }), ("T", LockOutcome { spin: "normal", lines: 2 })];
        assert_eq!(witness_b_next_tsd(true, &b_early), true);
        let mut b_cap: Vec<(&str, LockOutcome)> = (0..64)
            .map(|_| ("T", LockOutcome { spin: "none", lines: 0 }))
            .collect();
        b_cap.push(("T", LockOutcome { spin: "normal", lines: 2 }));
        assert_eq!(witness_b_next_tsd(true, &b_cap), false);
        assert_eq!(witness_b_next_tsd(false, &b_early), false);
        let no_t = reach_pieces(&p4["syntheticTsd"]["noT"]["pieces"]);
        assert_eq!(t_available(&no_t), false);
        let with_t = reach_pieces(&p4["syntheticTsd"]["withT"]["pieces"]);
        assert_eq!(t_available(&with_t), true);
        assert_eq!(
            p4["syntheticTsd"]["withT"]["result"]["tAvailable"].as_bool().unwrap(),
            true
        );
        let t_count = p4["decisions"][0]["tPlacements"].as_array().unwrap().len() as u32;
        let live = p4["decisions"][0]["tsd"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["result"]["tAvailable"].as_bool() == Some(true))
            .unwrap();
        assert_eq!(live["result"]["scanned"].as_u64().unwrap() as u32, t_count.min(64));
        assert_eq!(live["result"]["witnessed"].as_bool().unwrap(), false);
        let cells_table = tetromino_cells_from_json(&p4["tetrominoCells"]);
        let tables = kick_tables_from_json(&p4["srs"]);
        let lock_board = p4["syntheticTsd"]["lockBoard"]["cells"].as_str().unwrap();
        let pieces_t = reach_pieces(&p4["syntheticTsd"]["withT"]["pieces"]);
        let t_from_a: Vec<_> = generate_reachable_a(lock_board, 10, 40, &pieces_t, &cells_table, &tables)
            .unwrap()
            .into_iter()
            .filter(|placement| placement.placement.piece == "T")
            .collect();
        let expected_t = p4["syntheticTsd"]["withT"]["tPlacementsA"].as_array().unwrap();
        assert_eq!(t_from_a.len(), expected_t.len());
        for (index, expected) in expected_t.iter().enumerate() {
            assert!(compact_equals(&compact_json(&t_from_a[index]), expected), "scan T {index}");
        }
        let scan = witness_a_next_tsd(
            true,
            &vec![LockOutcome { spin: "none", lines: 0 }; t_from_a.len()],
        );
        assert_eq!(scan.scanned, (t_from_a.len() as u32).min(64));
        assert_eq!(scan.scanned, p4["syntheticTsd"]["withT"]["result"]["scanned"].as_u64().unwrap() as u32);
    }

    #[test]
    fn p4a_synthetic_reach_covers_kicks_spins_180_and_fin_tst_predicate() {
        let p4 = load_p4();
        let cells_table = tetromino_cells_from_json(&p4["tetrominoCells"]);
        let tables = kick_tables_from_json(&p4["srs"]);
        let board = p4["syntheticReach"]["lockBoard"]["cells"].as_str().unwrap();
        let pieces = reach_pieces(&p4["syntheticReach"]["pieces"]);
        let reachable_a = generate_reachable_a(board, 10, 40, &pieces, &cells_table, &tables).unwrap();
        let reachable_b = generate_public_reachable(board, 10, 40, &pieces, &cells_table, &tables).unwrap();
        assert_eq!(reachable_a.len(), p4["syntheticReach"]["reachableA"].as_array().unwrap().len());
        assert_eq!(reachable_b.len(), p4["syntheticReach"]["reachableB"].as_array().unwrap().len());
        for (index, expected) in p4["syntheticReach"]["reachableA"].as_array().unwrap().iter().enumerate() {
            assert!(compact_equals(&compact_json(&reachable_a[index]), expected), "synth A {index}");
        }
        for (index, expected) in p4["syntheticReach"]["reachableB"].as_array().unwrap().iter().enumerate() {
            assert!(compact_equals(&compact_json(&reachable_b[index]), expected), "synth B {index}");
        }
        assert!(p4["syntheticReach"]["coverageA"]["mini"].as_u64().unwrap() >= 1);
        assert!(p4["syntheticReach"]["coverageA"]["normal"].as_u64().unwrap() >= 1);
        assert!(p4["syntheticReach"]["coverageA"]["d180"].as_u64().unwrap() >= 1);
        assert!(p4["syntheticReach"]["coverageA"]["kicked"].as_u64().unwrap() >= 1);
        let fin_a = reachable_a
            .iter()
            .filter(|placement| is_fin_or_tst(placement.kick_id.as_deref(), placement.kick_offset))
            .count();
        let fin_b = reachable_b
            .iter()
            .filter(|placement| is_fin_or_tst(placement.kick_id.as_deref(), placement.kick_offset))
            .count();
        assert!(fin_a >= 1);
        assert_eq!(fin_a as u64, p4["syntheticReach"]["coverageA"]["fin"].as_u64().unwrap());
        assert_eq!(fin_b as u64, p4["syntheticReach"]["coverageB"]["fin"].as_u64().unwrap());
        let last_rot = reachable_a
            .iter()
            .filter(|placement| placement.last_rotation)
            .count();
        assert!(last_rot > 0);
        for case in p4["syntheticReach"]["finCases"].as_array().unwrap() {
            let kick_id = case["kickId"].as_str();
            let offset = case["kickOffset"].as_array().map(|pair| {
                (pair[0].as_i64().unwrap() as i32, pair[1].as_i64().unwrap() as i32)
            });
            assert_eq!(
                is_fin_or_tst(kick_id, offset),
                case["expected"].as_bool().unwrap(),
                "{}",
                case["kickId"].as_str().unwrap()
            );
        }
    }
}
