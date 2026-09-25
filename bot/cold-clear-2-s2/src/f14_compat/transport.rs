//! Legacy-path F14 envelope. Not ADR-063 `s2-native-integrated/1` transport.
#[cfg(test)]
use super::select::{
    apply_residual_rescue, select_f14_amount_only_limited, select_f14_public_limited,
    CoreRankedSnapshot,
};
use super::select::{
    public_context_digest, public_state_from_json, snapshot_binding, AllocationMode,
    F14PublicState, F14RuntimeLimits, F14SelectOptions, F14Selection, FinishedRootDecision,
    FinishedRootOutcome, PostStageCountersSnapshot, PublicRootLockContext, RootDecisionStage,
    RootObjectiveSession, SnapshotBinding, EFFECTIVE_WEIGHTS,
};
use super::{CompatError, FinalOrderPolicy, PostSpinPolicy, F14_RULESET_ID, QUEUE_LIMIT};
use crate::bot::{BotConfig, Statistics};
use crate::data::Placement;
use crate::time::Instant;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

fn deserialize_present_optional_string<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

pub const A_PROFILE: &str = "f14-amount-only-compat-a/1";
pub const PUBLIC_PROFILE: &str = "f14-amount-only-compat-b/1";
pub const COMPOSED_A: &str = "f14-composed-ranking-a/1";
pub const COMPOSED_B: &str = "f14-composed-ranking-b/1";
pub const CORE_ALLSPIN_PROFILE: &str = "f14-core-allspin-b/1";
pub const ROOT_VALUE_PROFILE: &str = "f14-core-allspin-rootvalue/1";
pub const ROOT_VALUE_MIX_PROFILE: &str = "f14-root-value-mix-b/1";
pub const ROOT_VALUE_TIEBREAK_PROFILE: &str = "f14-root-value-tiebreak-b/1";
pub const LEAF_CONVERSION_PROFILE: &str = "f14-leaf-conversion-b/1";
pub const LEAF_CONVERSION_GATED_PROFILE: &str = "f14-leaf-conversion-gated-b/1";
pub const LEAF_CONVERSION_PRESSURE_GATED_PROFILE: &str = "f14-leaf-conversion-pressure-gated-b/1";
pub const LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE: &str =
    "f14-leaf-conversion-gated-b2b-charge-b/1";
pub const RANK_ORDER_PROFILE: &str = "f14-rank-order-b/1";
pub const ROOT_OBJECTIVE_PROFILE: &str = "f14-root-objective-b/1";
pub const POST_SPIN_POLICY_OFF: &str = "non-t-spin-prior-off/1";
/// Host-clocked think time: the WASM host stops `work` at its own deadline and
/// asks for an early finish; `selections` is then an upper bound. The public
/// champion and gated leaf-conversion profiles admit it only through WASM.
pub const TIME_BUDGET_MODE: &str = "time";
pub const FINAL_ORDER_POLICY_CC2: &str = "cc2-rank-order/1";

pub const FEATURE: &str = "s2-f14-amount-only-compat/1";
pub const CORE_ALLSPIN_FEATURE: &str = "s2-f14-core-allspin/1";
pub const RANK_ORDER_FEATURE: &str = "s2-f14-rank-order/1";
pub const CONFIG: &str =
    include_str!("../../../../fixtures/tuning/cc2-s2-spawn-integrity-substrate-v2.json");
pub const CONFIG_HASH: &str =
    "sha256:12665e92fa86934d82b5fd909b1248954e267d4e5c8fcafb0c23024938d1a769";
pub const CAS_CONFIG: &str =
    include_str!("../../../../fixtures/tuning/cc2-s2-r3-core-allspin-v1-candidate.json");
pub const CAS_CONFIG_HASH: &str =
    "sha256:8ff0f083600d105754a97b4aba7c33ed189fe0ec5cc0a910fe25a10865a6a352";
pub const MS06_CONFIG: &str =
    include_str!("../../../../fixtures/tuning/cc2-s2-s1a-mini-spin-single-06.json");
pub const MS06_CONFIG_HASH: &str =
    "sha256:9755265ba731f8128387af77c17d2692f47bc80cad383d1348343a7a430c62fa";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub profile_id: String,
    pub config_hash: String,
    pub seed: String,
    pub worker_concurrency: u32,
    pub budget: Budget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_spin_policy_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allocation_mode: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_present_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub root_value_scale: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_present_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub leaf_conversion_scale: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_present_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub leaf_conversion_max_height: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_present_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub b2b_charge_scale: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_order_policy_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    pub mode: String,
    pub selections: u64,
    pub max_millis: u64,
}

impl Profile {
    pub fn valid(&self) -> bool {
        let common = self.worker_concurrency == 1
            && self
                .seed
                .parse::<u64>()
                .map_or(false, |n| n.to_string() == self.seed)
            && self.budget_mode_valid()
            && (1..=1_000_000).contains(&self.budget.selections)
            && (0..=300_000).contains(&self.budget.max_millis);
        if !common {
            return false;
        }
        if self.profile_id != LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE
            && self.b2b_charge_scale.is_some()
        {
            return false;
        }
        match self.profile_id.as_str() {
            A_PROFILE | PUBLIC_PROFILE | COMPOSED_A | COMPOSED_B => {
                self.post_spin_policy_id.is_none()
                    && self.allocation_mode.is_none()
                    && self.root_value_scale.is_none()
                    && self.leaf_conversion_scale.is_none()
                    && self.leaf_conversion_max_height.is_none()
                    && self.final_order_policy_id.is_none()
                    && self.config_hash == CONFIG_HASH
            }
            CORE_ALLSPIN_PROFILE => {
                self.post_spin_policy_id.as_deref() == Some(POST_SPIN_POLICY_OFF)
                    && self.allocation_mode.is_none()
                    && self.root_value_scale.is_none()
                    && self.leaf_conversion_scale.is_none()
                    && self.leaf_conversion_max_height.is_none()
                    && self.final_order_policy_id.is_none()
                    && (self.config_hash == CONFIG_HASH || self.config_hash == CAS_CONFIG_HASH)
            }
            ROOT_VALUE_PROFILE => {
                self.post_spin_policy_id.as_deref() == Some(POST_SPIN_POLICY_OFF)
                    && self.allocation_mode.is_none()
                    && self.root_value_scale.is_none()
                    && self.leaf_conversion_scale.is_none()
                    && self.leaf_conversion_max_height.is_none()
                    && self.final_order_policy_id.is_none()
                    && self.config_hash == CAS_CONFIG_HASH
            }
            ROOT_VALUE_MIX_PROFILE => {
                self.post_spin_policy_id.is_none()
                    && self.allocation_mode.as_deref() == Some(super::root_allocation::ROOT_VALUE_MIX_MODE)
                    && self.root_value_scale_f64().is_some()
                    && self.leaf_conversion_scale.is_none()
                    && self.leaf_conversion_max_height.is_none()
                    && self.final_order_policy_id.as_deref() == Some(FINAL_ORDER_POLICY_CC2)
                    && self.config_hash == CONFIG_HASH
            }
            ROOT_VALUE_TIEBREAK_PROFILE => {
                self.post_spin_policy_id.is_none()
                    && self.allocation_mode.as_deref()
                        == Some(super::root_allocation::ROOT_VALUE_TIEBREAK_MODE)
                    && self.root_value_scale.is_none()
                    && self.leaf_conversion_scale.is_none()
                    && self.leaf_conversion_max_height.is_none()
                    && self.final_order_policy_id.as_deref() == Some(FINAL_ORDER_POLICY_CC2)
                    && self.config_hash == CONFIG_HASH
            }
            LEAF_CONVERSION_PROFILE => {
                self.post_spin_policy_id.is_none()
                    && self.allocation_mode.as_deref()
                        == Some(super::root_allocation::LEAF_CONVERSION_MODE)
                    && self.root_value_scale.is_none()
                    && self.leaf_conversion_scale_f64().is_some()
                    && self.leaf_conversion_max_height.is_none()
                    && self.final_order_policy_id.as_deref() == Some(FINAL_ORDER_POLICY_CC2)
                    && self.config_hash == CONFIG_HASH
            }
            LEAF_CONVERSION_GATED_PROFILE => {
                self.post_spin_policy_id.is_none()
                    && self.allocation_mode.as_deref()
                        == Some(super::root_allocation::LEAF_CONVERSION_GATED_MODE)
                    && self.root_value_scale.is_none()
                    && self.leaf_conversion_scale_f64().is_some()
                    && self.leaf_conversion_max_height_u32().is_some()
                    && self.final_order_policy_id.as_deref() == Some(FINAL_ORDER_POLICY_CC2)
                    && self.config_hash == CONFIG_HASH
            }
            LEAF_CONVERSION_PRESSURE_GATED_PROFILE => {
                self.post_spin_policy_id.is_none()
                    && self.allocation_mode.as_deref()
                        == Some(super::root_allocation::LEAF_CONVERSION_PRESSURE_GATED_MODE)
                    && self.root_value_scale.is_none()
                    && self.leaf_conversion_scale_f64().is_some()
                    && self.leaf_conversion_max_height_u32().is_some()
                    && self.final_order_policy_id.as_deref() == Some(FINAL_ORDER_POLICY_CC2)
                    && self.config_hash == CONFIG_HASH
            }
            LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE => {
                self.post_spin_policy_id.is_none()
                    && self.allocation_mode.as_deref()
                        == Some(super::root_allocation::LEAF_CONVERSION_GATED_B2B_CHARGE_MODE)
                    && self.root_value_scale.is_none()
                    && self.leaf_conversion_scale_f64().is_some()
                    && self.leaf_conversion_max_height_u32().is_some()
                    && self.b2b_charge_scale_f32().is_some()
                    && self.final_order_policy_id.as_deref() == Some(FINAL_ORDER_POLICY_CC2)
                    && self.config_hash == CONFIG_HASH
            }
            RANK_ORDER_PROFILE => {
                self.post_spin_policy_id.is_none()
                    && self.allocation_mode.is_none()
                    && self.root_value_scale.is_none()
                    && self.leaf_conversion_scale.is_none()
                    && self.leaf_conversion_max_height.is_none()
                    && self.final_order_policy_id.as_deref() == Some(FINAL_ORDER_POLICY_CC2)
                    && (self.config_hash == CONFIG_HASH || self.config_hash == MS06_CONFIG_HASH)
            }
            ROOT_OBJECTIVE_PROFILE => {
                self.post_spin_policy_id.is_none()
                    && self.root_value_scale.is_none()
                    && self.leaf_conversion_scale.is_none()
                    && self.leaf_conversion_max_height.is_none()
                    && self.final_order_policy_id.is_none()
                    && matches!(
                        self.allocation_mode.as_deref(),
                        Some("off") | Some("conversion-permutation-v1")
                    )
                    && self.config_hash == CONFIG_HASH
                    && self.seed == "5994928009864282113"
                    && self.budget.selections == 512
            }
            _ => false,
        }
    }

    fn budget_mode_valid(&self) -> bool {
        match self.budget.mode.as_str() {
            "selection" => true,
            TIME_BUDGET_MODE => {
                (self.profile_id == PUBLIC_PROFILE || self.profile_id == LEAF_CONVERSION_GATED_PROFILE)
                    && (10..=10_000).contains(&self.budget.max_millis)
            }
            _ => false,
        }
    }

    pub fn is_time_budget(&self) -> bool {
        self.budget.mode == TIME_BUDGET_MODE
    }

    /// A selection budget must be met exactly; a time budget ends after at
    /// least one selection and never beyond its selection cap.
    pub fn budget_met(&self, selections: u64) -> bool {
        if self.is_time_budget() {
            (1..=self.budget.selections).contains(&selections)
        } else {
            selections == self.budget.selections
        }
    }

    pub fn seed_u64(&self) -> Option<u64> {
        self.seed.parse().ok()
    }

    pub(crate) fn root_value_scale_f64(&self) -> Option<f64> {
        self.root_value_scale
            .as_ref()?
            .as_deref()?
            .parse::<f64>()
            .ok()
            .filter(|scale| scale.is_finite())
    }

    pub(crate) fn leaf_conversion_scale_f64(&self) -> Option<f64> {
        self.leaf_conversion_scale
            .as_ref()?
            .as_deref()?
            .parse::<f64>()
            .ok()
            .filter(|scale| scale.is_finite())
    }

    pub(crate) fn leaf_conversion_max_height_u32(&self) -> Option<u32> {
        let value = self.leaf_conversion_max_height.as_ref()?.as_deref()?;
        let height = value.parse::<u32>().ok()?;
        ((1..=40).contains(&height) && value == height.to_string()).then_some(height)
    }

    pub(crate) fn b2b_charge_scale_f32(&self) -> Option<f32> {
        let value = self.b2b_charge_scale.as_ref()?.as_deref()?;
        if !canonical_nonnegative_decimal(value) {
            return None;
        }
        let scale = value.parse::<f32>().ok()?;
        (scale.is_finite() && scale >= 0.0).then_some(scale)
    }

    pub(crate) fn apply_search_config_overrides(&self, config: &mut BotConfig) {
        if self.profile_id == LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE {
            let scale = self
                .b2b_charge_scale_f32()
                .expect("admitted B2B charge profile has a valid scale");
            config.enable_s2_b2b_surge = true;
            config.freestyle_weights.s2_b2b_surge = 1.0;
            config.freestyle_weights.s2_b2b_charge = scale;
            config.freestyle_weights.s2_b2b_charge_cap_rows = 12;
        }
    }

    pub fn is_public_amount(&self) -> bool {
        matches!(
            self.profile_id.as_str(),
            PUBLIC_PROFILE
                | CORE_ALLSPIN_PROFILE
                | ROOT_VALUE_PROFILE
                | ROOT_VALUE_MIX_PROFILE
                | ROOT_VALUE_TIEBREAK_PROFILE
                | LEAF_CONVERSION_PROFILE
                | LEAF_CONVERSION_GATED_PROFILE
                | LEAF_CONVERSION_PRESSURE_GATED_PROFILE
                | LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE
                | RANK_ORDER_PROFILE
                | COMPOSED_B
                | ROOT_OBJECTIVE_PROFILE
        )
    }

    pub fn is_composed(&self) -> bool {
        matches!(self.profile_id.as_str(), COMPOSED_A | COMPOSED_B)
    }

    pub fn uses_core_snapshot(&self) -> bool {
        self.profile_id == ROOT_OBJECTIVE_PROFILE
    }

    pub fn uses_core_decision(&self) -> bool {
        self.is_composed()
            || self.uses_core_snapshot()
            || matches!(
                self.profile_id.as_str(),
                A_PROFILE | PUBLIC_PROFILE | CORE_ALLSPIN_PROFILE | ROOT_VALUE_PROFILE
                    | ROOT_VALUE_MIX_PROFILE | ROOT_VALUE_TIEBREAK_PROFILE | LEAF_CONVERSION_PROFILE
                    | LEAF_CONVERSION_GATED_PROFILE
                    | LEAF_CONVERSION_PRESSURE_GATED_PROFILE
                    | LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE
                    | RANK_ORDER_PROFILE
            )
    }

    pub(crate) fn decision_stage(&self) -> RootDecisionStage {
        RootDecisionStage::new(F14SelectOptions {
            candidate_limit: 16,
            allow_complete_returned_prefix: true,
            unverifiable: super::UnverifiablePolicy::RecordAndSkip,
            weights: EFFECTIVE_WEIGHTS,
            post_spin_policy: self.post_spin_policy(),
            final_order_policy: self.final_order_policy(),
        })
    }

    fn final_order_policy(&self) -> FinalOrderPolicy {
        if self.final_order_policy_id.as_deref() == Some(FINAL_ORDER_POLICY_CC2) {
            FinalOrderPolicy::Cc2RankOrder
        } else {
            FinalOrderPolicy::S2Rerank
        }
    }

    fn post_spin_policy(&self) -> PostSpinPolicy {
        if self.post_spin_policy_id.as_deref() == Some(POST_SPIN_POLICY_OFF) {
            PostSpinPolicy::NonTSpinPriorOff
        } else {
            PostSpinPolicy::LegacyF14
        }
    }

    pub fn config_bytes(&self) -> &'static str {
        if self.config_hash == CAS_CONFIG_HASH {
            CAS_CONFIG
        } else if self.config_hash == MS06_CONFIG_HASH {
            MS06_CONFIG
        } else {
            CONFIG
        }
    }

    pub(crate) fn search_bot_config(&self) -> Result<BotConfig, serde_json::Error> {
        let mut config: BotConfig = serde_json::from_str(self.config_bytes())?;
        config.search_seed = self.seed_u64().expect("admitted F14 profile has a valid seed");
        config.search_selection_limit = self.budget.selections;
        config.enable_s2_amount_only_incoming = false;
        self.apply_search_config_overrides(&mut config);
        Ok(config)
    }

    pub fn advertised_feature(&self) -> &'static str {
        if self.profile_id == CORE_ALLSPIN_PROFILE || self.profile_id == ROOT_VALUE_PROFILE {
            CORE_ALLSPIN_FEATURE
        } else if self.profile_id == RANK_ORDER_PROFILE {
            RANK_ORDER_FEATURE
        } else {
            FEATURE
        }
    }
}

fn canonical_nonnegative_decimal(value: &str) -> bool {
    if value == "0" {
        return true;
    }
    let (integer, _) = value.split_once('.').unwrap_or((value, ""));
    if integer.is_empty()
        || !integer.bytes().all(|byte| byte.is_ascii_digit())
        || (integer.len() > 1 && integer.starts_with('0'))
    {
        return false;
    }
    if let Some((_, fraction)) = value.split_once('.') {
        if fraction.is_empty()
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
            || fraction.ends_with('0')
        {
            return false;
        }
    }
    integer != "0" || value.contains('.')
}

fn id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_graphic())
}

#[derive(Clone, Copy, Debug)]
pub struct SearchStats {
    pub nodes: u64,
    pub selections: u64,
}

pub fn error(request: &Json, status: &str, reason: &str) -> Json {
    let safe = |key: &str| {
        request
            .get(key)
            .and_then(Json::as_str)
            .filter(|value| id(value))
            .map(str::to_owned)
    };
    json!({
        "type": "f14_decision",
        "schemaVersion": 1,
        "requestId": safe("requestId"),
        "positionId": safe("positionId"),
        "generation": request.get("generation").and_then(Json::as_u64),
        "profileId": request.pointer("/execution/profileId").and_then(Json::as_str).filter(|value| id(value)),
        "status": status,
        "reason": reason,
        "selectedMove": null,
        "selectedPlacement": null,
        "search": {},
        "diagnostics": {},
        "boundaryAudit": crate::s2_audit::Audit::default()
    })
}

fn map_error(error: CompatError) -> (&'static str, &'static str) {
    match error {
        CompatError::EmptyCandidates => ("error", "empty-candidates"),
        CompatError::NoVerifiableCandidate => ("error", "no-verifiable-candidate"),
        CompatError::Cancelled => ("incomplete", "cancelled"),
        CompatError::Deadline => ("incomplete", "deadline"),
        CompatError::UnsupportedRuleset => ("unsupported", "unsupported-ruleset"),
        CompatError::StartSelectorMismatch => ("error", "start-selector-mismatch"),
        CompatError::MissingCoreRanking => ("error", "missing-core-ranking"),
        CompatError::StaleRankingEpoch => ("error", "stale-ranking-epoch"),
        CompatError::RankingBindingMismatch => ("error", "ranking-binding-mismatch"),
        CompatError::RootOutcomeAlreadyTaken => ("error", "root-outcome-already-taken"),
        CompatError::RootOutcomeNotReady => ("error", "root-outcome-not-ready"),
        CompatError::RootOutcomeStatsMismatch => ("error", "root-outcome-stats-mismatch"),
        CompatError::RootAllocationBindingMismatch => ("error", "root-allocation-binding-mismatch"),
        CompatError::RootAllocationDomainRejected => ("error", "root-allocation-domain-rejected"),
        CompatError::RootAllocationLimitExceeded => ("incomplete", "root-allocation-limit"),
        CompatError::IncompletePrefix => ("error", "incomplete-prefix"),
        CompatError::DuplicateIdentity | CompatError::DuplicateCc2Rank => {
            ("error", "duplicate-identity")
        }
        CompatError::InvalidIncoming
        | CompatError::InvalidTime
        | CompatError::InvalidLockBoard
        | CompatError::InvalidSelector
        | CompatError::Cs1
        | CompatError::InvalidPrefixSettings => ("error", "invalid-input"),
        CompatError::ChainOverflow => ("error", "chain-overflow"),
        CompatError::FailClosed => ("error", "fail-closed"),
        _ => ("error", "error"),
    }
}

pub struct F14StartGate {
    live_generation: u64,
}

impl F14StartGate {
    pub fn new() -> Self {
        Self { live_generation: 0 }
    }

    pub fn begin(&mut self, token: u64) {
        self.live_generation = token;
    }

    pub fn allow_start(&self, token: u64, cancel: &AtomicBool) -> bool {
        !cancel.load(Ordering::Acquire) && self.live_generation == token
    }

    pub fn invalidate(&mut self) {
        self.live_generation = self.live_generation.wrapping_add(1);
    }
}

pub struct F14Park {
    entered: Sender<()>,
    release: Receiver<()>,
}

pub struct F14Hold {
    entered: Receiver<()>,
    release: Sender<()>,
}

impl F14Park {
    pub fn pair() -> (Self, F14Hold) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        (
            Self {
                entered: entered_tx,
                release: release_rx,
            },
            F14Hold {
                entered: entered_rx,
                release: release_tx,
            },
        )
    }

    pub fn park(&self) {
        let _ = self.entered.send(());
        let _ = self.release.recv();
    }
}

impl F14Hold {
    pub fn wait_entered(&self, timeout: Duration) {
        self.entered
            .recv_timeout(timeout)
            .expect("F14 cancel hook did not enter");
    }

    pub fn release(&self) {
        self.release.send(()).expect("F14 cancel hook release");
    }
}

pub struct F14CancelHook {
    pub after_flag_check: Option<F14Park>,
    pub before_start: Option<F14Park>,
    pub after_selector_enter: Option<F14Park>,
    pub after_budget_wait: Option<F14Park>,
}

impl F14CancelHook {
    pub fn park(slot: Option<&F14Park>) {
        if let Some(slot) = slot {
            slot.park();
        }
    }
}

fn json_piece(value: Option<&Json>) -> Result<Option<&str>, CompatError> {
    match value {
        None | Some(Json::Null) => Ok(None),
        Some(Json::String(piece)) => Ok(Some(piece.as_str())),
        _ => Err(CompatError::StartSelectorMismatch),
    }
}

pub fn assert_start_selector_projection(start: &Json, selector: &Json) -> Result<(), CompatError> {
    assert_start_selector_projection_with_queue_limit(start, selector, QUEUE_LIMIT)
}

/// The public and gated leaf-conversion champion profiles may also carry a longer queue (up to
/// `PUBLIC_QUEUE_LIMIT`), which must still be a prefix of current + known.
/// The default 14-piece truncation stays admitted for every profile.
pub const PUBLIC_QUEUE_LIMIT: usize = 28;

pub fn assert_start_selector_projection_with_queue_limit(
    start: &Json,
    selector: &Json,
    queue_limit: usize,
) -> Result<(), CompatError> {
    let ruleset = selector
        .get("rulesetId")
        .and_then(Json::as_str)
        .ok_or(CompatError::InvalidSelector)?;
    if ruleset != F14_RULESET_ID {
        return Err(CompatError::UnsupportedRuleset);
    }
    let cells = selector
        .pointer("/board/cells")
        .and_then(Json::as_str)
        .ok_or(CompatError::InvalidSelector)?;
    if cells.len() != 400 {
        return Err(CompatError::InvalidLockBoard);
    }
    let board = start
        .get("board")
        .and_then(Json::as_array)
        .ok_or(CompatError::StartSelectorMismatch)?;
    if board.len() != 40 {
        return Err(CompatError::StartSelectorMismatch);
    }
    for y in 0..40 {
        let row = board[y]
            .as_array()
            .ok_or(CompatError::StartSelectorMismatch)?;
        if row.len() != 10 {
            return Err(CompatError::StartSelectorMismatch);
        }
        for x in 0..10 {
            let expected = cells.as_bytes()[y * 10 + x];
            let actual = match &row[x] {
                Json::Null => b'_',
                Json::String(cell) if cell.len() == 1 => cell.as_bytes()[0],
                _ => return Err(CompatError::StartSelectorMismatch),
            };
            if expected != actual {
                return Err(CompatError::StartSelectorMismatch);
            }
        }
    }
    if selector
        .pointer("/pieces/holdAvailable")
        .and_then(Json::as_bool)
        != Some(true)
    {
        return Err(CompatError::StartSelectorMismatch);
    }
    let current = json_piece(selector.pointer("/pieces/current"))?
        .ok_or(CompatError::StartSelectorMismatch)?;
    let hold = json_piece(selector.pointer("/pieces/hold"))?;
    if json_piece(start.get("hold"))? != hold {
        return Err(CompatError::StartSelectorMismatch);
    }
    let known = selector
        .pointer("/pieces/known")
        .and_then(Json::as_array)
        .ok_or(CompatError::StartSelectorMismatch)?;
    let queue = start
        .get("queue")
        .and_then(Json::as_array)
        .ok_or(CompatError::StartSelectorMismatch)?;
    let available = known.len() + 1;
    let truncated = available.min(QUEUE_LIMIT);
    let extended = queue.len() > QUEUE_LIMIT && queue.len() <= queue_limit.min(available);
    let length = if extended { queue.len() } else { truncated };
    let mut expected_queue = Vec::with_capacity(length);
    expected_queue.push(current);
    for piece in known {
        if expected_queue.len() == length {
            break;
        }
        expected_queue.push(piece.as_str().ok_or(CompatError::StartSelectorMismatch)?);
    }
    if queue.len() != expected_queue.len() {
        return Err(CompatError::StartSelectorMismatch);
    }
    for (actual, expected) in queue.iter().zip(expected_queue) {
        if actual.as_str() != Some(expected) {
            return Err(CompatError::StartSelectorMismatch);
        }
    }
    if start.get("combo") != selector.pointer("/chain/combo") {
        return Err(CompatError::StartSelectorMismatch);
    }
    let selector_b2b = selector.pointer("/chain/b2b").and_then(Json::as_u64);
    let start_b2b = start.get("b2b").and_then(Json::as_u64).or_else(|| {
        start
            .get("back_to_back")
            .and_then(Json::as_bool)
            .map(|flag| u64::from(flag))
    });
    if start_b2b != selector_b2b {
        return Err(CompatError::StartSelectorMismatch);
    }
    if start.pointer("/randomizer/type").and_then(Json::as_str) != Some("seven_bag") {
        return Err(CompatError::StartSelectorMismatch);
    }
    Ok(())
}

fn interrupted(limits: Option<&F14RuntimeLimits>) -> Result<(), CompatError> {
    let Some(limits) = limits else {
        return Ok(());
    };
    if limits.cancel.load(Ordering::Acquire) {
        return Err(CompatError::Cancelled);
    }
    if Instant::now() >= limits.deadline {
        return Err(CompatError::Deadline);
    }
    Ok(())
}

pub fn admit(raw: &Json, profile: &Profile) -> Result<(), Json> {
    if raw.get("rootAmounts").is_some() {
        return Err(error(raw, "error", "invalid-input"));
    }
    if raw.get("type").and_then(Json::as_str) != Some("f14_decide") {
        return Err(error(raw, "error", "invalid-input"));
    }
    let execution: Profile =
        match serde_json::from_value(raw.get("execution").cloned().unwrap_or(Json::Null)) {
            Ok(value) => value,
            Err(_) => return Err(error(raw, "error", "invalid-input")),
        };
    if !profile.valid() || execution != *profile {
        return Err(error(
            raw,
            "unsupported",
            "unsupported-version-model-or-profile",
        ));
    }
    if raw.get("schemaVersion").and_then(Json::as_u64) != Some(1) {
        return Err(error(
            raw,
            "unsupported",
            "unsupported-version-model-or-profile",
        ));
    }
    let selector = match raw.get("selector") {
        Some(value) => value,
        None => return Err(error(raw, "error", "invalid-input")),
    };
    match public_state_from_json(selector) {
        Ok(state) => {
            if !profile.is_public_amount()
                && (state.incoming.pending_rows != 0 || state.incoming.due_this_lock_rows != 0)
            {
                return Err(error(raw, "unsupported", "unsupported-incoming-profile"));
            }
        }
        Err(CompatError::UnsupportedRuleset) => {
            return Err(error(raw, "unsupported", "unsupported-ruleset"));
        }
        Err(_) => return Err(error(raw, "error", "invalid-input")),
    }
    let start = match raw.get("start") {
        Some(value) => value,
        None => return Err(error(raw, "error", "invalid-input")),
    };
    let queue_limit = if profile.profile_id == PUBLIC_PROFILE
        || profile.profile_id == LEAF_CONVERSION_GATED_PROFILE
        || profile.profile_id == LEAF_CONVERSION_PRESSURE_GATED_PROFILE
        || profile.profile_id == LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE
    {
        PUBLIC_QUEUE_LIMIT
    } else {
        QUEUE_LIMIT
    };
    if let Err(compat_error) = assert_start_selector_projection_with_queue_limit(start, selector, queue_limit) {
        let (status, reason) = map_error(compat_error);
        return Err(error(raw, status, reason));
    }
    Ok(())
}

pub fn decide(raw: Json, profile: &Profile, moves: &[Placement], search: SearchStats) -> Json {
    decide_limited(raw, profile, moves, search, None, None, 0)
}

pub fn decide_limited(
    raw: Json,
    profile: &Profile,
    moves: &[Placement],
    search: SearchStats,
    limits: Option<&F14RuntimeLimits>,
    hook: Option<&F14CancelHook>,
    epoch: u64,
) -> Json {
    decide_limited_with_core(raw, profile, moves, search, limits, hook, epoch, None)
}

pub(crate) fn decide_limited_with_core(
    raw: Json,
    profile: &Profile,
    moves: &[Placement],
    search: SearchStats,
    limits: Option<&F14RuntimeLimits>,
    hook: Option<&F14CancelHook>,
    epoch: u64,
    root_decision: Option<FinishedRootDecision>,
) -> Json {
    decide_limited_with_core_admission(raw, profile, moves, search, limits, hook, epoch, root_decision, false)
}

/// The finish of a prepared decision or a retained rerank: `admit` already
/// accepted this exact request on entry, so the finish does not repeat it.
pub(crate) fn decide_limited_with_core_admitted(
    raw: Json,
    profile: &Profile,
    moves: &[Placement],
    search: SearchStats,
    limits: Option<&F14RuntimeLimits>,
    hook: Option<&F14CancelHook>,
    epoch: u64,
    root_decision: Option<FinishedRootDecision>,
) -> Json {
    decide_limited_with_core_admission(raw, profile, moves, search, limits, hook, epoch, root_decision, true)
}

fn decide_limited_with_core_admission(
    raw: Json,
    profile: &Profile,
    moves: &[Placement],
    search: SearchStats,
    limits: Option<&F14RuntimeLimits>,
    hook: Option<&F14CancelHook>,
    epoch: u64,
    root_decision: Option<FinishedRootDecision>,
    admitted: bool,
) -> Json {
    let core_counters = root_decision.as_ref().map(|decision| decision.counters);
    let core_post_stage_counters = root_decision
        .as_ref()
        .map(|decision| decision.post_stage_counters);
    let (mut response, audit) = crate::s2_audit::run_native_f14_compat(|| {
        crate::s2_audit::with_legacy_selector_guard(profile.uses_core_decision(), || {
            decide_limited_inner(
                raw,
                profile,
                moves,
                search,
                limits,
                hook,
                epoch,
                root_decision,
                admitted,
            )
        })
    });
    response["boundaryAudit"] = json!(audit);
    attach_diagnostics(
        &mut response,
        profile,
        core_counters,
        core_post_stage_counters,
        audit,
    );
    response
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn rerank_without_retained(raw: Json) -> Json {
    let profile: Profile = match serde_json::from_value(raw.get("execution").cloned().unwrap_or(Json::Null)) {
        Ok(profile) => profile,
        Err(_) => return error(&raw, "error", "invalid-input"),
    };
    if let Err(response) = admit(&raw, &profile) {
        return response;
    }
    if !supports_retained_rerank(&profile.profile_id) {
        return error(&raw, "unsupported", "f14-rerank-unsupported");
    }
    error(&raw, "unavailable", "rerank-unavailable")
}

/// The pressure-gated profile's search depends on the root request's public
/// pending rows, so a search retained under different incoming rows cannot be
/// reused; callers fall back to a fresh decision.
fn supports_retained_rerank(profile_id: &str) -> bool {
    profile_id == PUBLIC_PROFILE || profile_id == LEAF_CONVERSION_GATED_PROFILE
}

fn input_queue_prefix_allowed(input_speculation: bool, profile_id: &str) -> bool {
    input_speculation && profile_id == LEAF_CONVERSION_GATED_PROFILE
}

pub(crate) fn rerank_retained(
    raw: Json,
    original_request: &Json,
    profile: &Profile,
    retained: &FinishedRootOutcome,
    input_speculation: bool,
) -> Json {
    if let Err(response) = admit(&raw, profile) {
        return response;
    }
    if !supports_retained_rerank(&profile.profile_id) {
        return error(&raw, "unsupported", "f14-rerank-unsupported");
    }
    let allow_input_queue_prefix =
        input_queue_prefix_allowed(input_speculation, &profile.profile_id);
    let prefix_search_length =
        match rerank_request_compatible(original_request, &raw, allow_input_queue_prefix) {
            Some(RerankRequestMatch::Exact) => None,
            Some(RerankRequestMatch::InputQueuePrefix) => original_request
                .pointer("/start/queue")
                .and_then(Json::as_array)
                .map(Vec::len),
            None => return error(&raw, "error", "rerank-mismatch"),
        };

    match retained {
        FinishedRootOutcome::NoCandidates {
            nodes,
            completed_selections,
        } => {
            let token = raw_generation(&raw);
            decide_limited_with_core_admitted(
                raw,
                profile,
                &[],
                SearchStats {
                    nodes: *nodes,
                    selections: *completed_selections,
                },
                None,
                None,
                token,
                None,
            )
        }
        FinishedRootOutcome::Failed(_) => error(&raw, "unavailable", "rerank-unavailable"),
        FinishedRootOutcome::Decided(original) => {
            if original.native_moves.len() != original.native_values.len() {
                return compat_error_response(&raw, CompatError::RootOutcomeStatsMismatch);
            }
            // The native candidate roots are retained, but the ranking context
            // is rebuilt from the target request just as in a fresh decision.
            // In particular, target time resolves the multiplier and target
            // incoming carries the host's cap-aware pressure projection.
            let state = match composed_public_state(&raw) {
                Ok(state) => state,
                Err(compat_error) => return compat_error_response(&raw, compat_error),
            };
            // Match a fresh F14 start's post-search ranking deadline. Host-clocked
            // time budgets keep their recorded N completed selections and still
            // format as time-budget responses after this ranking-only pass.
            let hard_millis = if profile.is_time_budget() {
                profile.budget.max_millis.saturating_add(30_000)
            } else {
                profile.budget.max_millis
            };
            let limits = F14RuntimeLimits {
                deadline: Instant::now() + Duration::from_millis(hard_millis),
                cancel: std::sync::Arc::new(AtomicBool::new(false)),
            };
            let context = match PublicRootLockContext::for_profile(&state, &limits, true) {
                Ok(context) => context,
                Err(compat_error) => return compat_error_response(&raw, compat_error),
            };
            let token = raw_generation(&raw);
            let digest = public_context_digest_for_state(&state, &raw, profile);
            let session = RootObjectiveSession::new_with_allocation_mode(
                context,
                profile.decision_stage(),
                profile.budget.selections,
                token,
                digest,
                AllocationMode::Off,
            );
            let stats = Statistics {
                nodes: original.nodes,
                selections: original.completed_selections,
                ..Default::default()
            };
            let native = original
                .native_moves
                .iter()
                .copied()
                .zip(original.native_values.iter().copied())
                .collect::<Vec<_>>();
            let completion = if original.completed_selections >= profile.budget.selections {
                session.complete_work(&stats, || native)
            } else {
                // Host-clocked time budgets retain N completed selections below
                // the selection cap. Publish that retained prefix through the
                // same early-finish path, while preserving the time-budget wire.
                if let Err(compat_error) = session.complete_work(&stats, Vec::new) {
                    return compat_error_response(&raw, compat_error);
                }
                session.complete_early(|| native)
            };
            if let Err(compat_error) = completion {
                return compat_error_response(&raw, compat_error);
            }
            let decision = match session.take_outcome() {
                Ok(Some(FinishedRootOutcome::Decided(decision))) => decision,
                Ok(Some(FinishedRootOutcome::NoCandidates { .. })) => {
                    return decide_limited_with_core_admitted(
                        raw,
                        profile,
                        &[],
                        SearchStats {
                            nodes: original.nodes,
                            selections: original.completed_selections,
                        },
                        None,
                        None,
                        token,
                        None,
                    );
                }
                Ok(Some(FinishedRootOutcome::Failed(compat_error))) => {
                    return compat_error_response(&raw, compat_error);
                }
                Ok(None) => return compat_error_response(&raw, CompatError::RootOutcomeNotReady),
                Err(compat_error) => return compat_error_response(&raw, compat_error),
            };
            let moves = decision.native_moves.clone();
            let mut response = decide_limited_with_core_admitted(
                raw,
                profile,
                &moves,
                SearchStats {
                    nodes: decision.nodes,
                    selections: decision.completed_selections,
                },
                Some(&limits),
                None,
                token,
                Some(decision),
            );
            if let Some(searched_queue_length) = prefix_search_length {
                if response["status"] == "move" {
                    response["search"]["queueLength"] = json!(searched_queue_length);
                    response["search"]["searchedQueueLength"] = json!(searched_queue_length);
                }
            }
            response
        }
    }
}

fn raw_generation(raw: &Json) -> u64 {
    raw.get("generation").and_then(Json::as_u64).unwrap_or(0)
}

/// A retained search serves any request with the same `start` and execution:
/// the allocation-off search reads only `start`, and the ranking is rebuilt
/// from the rerank request. Besides incoming and time, the selector's known
/// pieces may differ, so a search run for the next piece before its last NEXT
/// piece is revealed (the queue already holds it) serves the real request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RerankRequestMatch {
    Exact,
    InputQueuePrefix,
}

fn rerank_request_compatible(
    original: &Json,
    rerank: &Json,
    allow_input_queue_prefix: bool,
) -> Option<RerankRequestMatch> {
    let Some(original_selector) = original.get("selector").and_then(Json::as_object) else {
        return None;
    };
    let Some(original_known) = original_selector
        .get("pieces")
        .and_then(|pieces| pieces.get("known"))
    else {
        return None;
    };
    let Some(original_incoming) = original_selector.get("incoming") else {
        return None;
    };
    let Some(original_time) = original_selector.get("time") else {
        return None;
    };
    let Some(rerank_selector) = rerank.get("selector").and_then(Json::as_object) else {
        return None;
    };
    if !rerank_selector.contains_key("incoming") || !rerank_selector.contains_key("time") {
        return None;
    }
    let mut expected = original.clone();
    let mut actual = rerank.clone();
    let start_match = if actual.get("start") == expected.get("start") {
        RerankRequestMatch::Exact
    } else if allow_input_queue_prefix && input_queue_prefix_start_matches(&expected, &actual) {
        let Some(original_start) = expected.get("start") else {
            return None;
        };
        let Some(actual_start) = actual.get_mut("start") else {
            return None;
        };
        *actual_start = original_start.clone();
        RerankRequestMatch::InputQueuePrefix
    } else {
        return None;
    };
    for key in ["requestId", "positionId", "generation"] {
        if let Some(object) = expected.as_object_mut() {
            object.remove(key);
        }
        if let Some(object) = actual.as_object_mut() {
            object.remove(key);
        }
    }
    let Some(actual_selector) = actual
        .get_mut("selector")
        .and_then(Json::as_object_mut)
    else {
        return None;
    };
    actual_selector.insert("incoming".to_owned(), original_incoming.clone());
    actual_selector.insert("time".to_owned(), original_time.clone());
    let Some(actual_pieces) = actual_selector
        .get_mut("pieces")
        .and_then(Json::as_object_mut)
    else {
        return None;
    };
    if !actual_pieces.contains_key("known") {
        return None;
    }
    actual_pieces.insert("known".to_owned(), original_known.clone());
    (actual == expected).then_some(start_match)
}

fn input_queue_prefix_start_matches(retained_request: &Json, real_request: &Json) -> bool {
    let Some(retained_start) = retained_request.get("start") else {
        return false;
    };
    let Some(real_start) = real_request.get("start") else {
        return false;
    };
    if retained_start
        .pointer("/randomizer/type")
        .and_then(Json::as_str)
        != Some("seven_bag")
    {
        return false;
    }
    let Some(retained_bag) = retained_start
        .pointer("/randomizer/bag_state")
        .and_then(Json::as_array)
    else {
        return false;
    };
    if !retained_bag.is_empty() {
        return false;
    }
    let Some(retained_queue) = retained_start.get("queue").and_then(Json::as_array) else {
        return false;
    };
    let Some(real_queue) = real_start.get("queue").and_then(Json::as_array) else {
        return false;
    };
    if real_queue.len() != retained_queue.len() + 1
        || retained_queue
            .iter()
            .zip(real_queue)
            .any(|(left, right)| left != right)
    {
        return false;
    }
    let mut comparable_real_start = real_start.clone();
    comparable_real_start["queue"] = Json::Array(retained_queue.clone());
    comparable_real_start == *retained_start
}

fn attach_diagnostics(
    response: &mut Json,
    profile: &Profile,
    core_counters: Option<super::select::CoreDecisionCountersSnapshot>,
    core_post_stage_counters: Option<PostStageCountersSnapshot>,
    audit: crate::s2_audit::Audit,
) {
    if profile.profile_id == CORE_ALLSPIN_PROFILE || profile.profile_id == ROOT_VALUE_PROFILE {
        let counters = core_post_stage_counters.unwrap_or(PostStageCountersSnapshot {
            non_t_setup_witness_calls: audit.non_t_setup_witness_calls,
            non_t_setup_bonus_applied: audit.non_t_setup_bonus_applied,
            ..Default::default()
        });
        response["diagnostics"] = json!({
            "nonTSetupWitnessCalls": counters.non_t_setup_witness_calls,
            "nonTSetupBonusApplied": counters.non_t_setup_bonus_applied,
            "postSpinPolicyId": POST_SPIN_POLICY_OFF,
        });
    } else if profile.uses_core_snapshot() {
        let counters = core_counters.unwrap_or_default();
        response["diagnostics"] = json!({
            "coreRankingComposeCalls": counters.ranking_compose_calls,
            "coreRerankCalls": counters.rerank_calls,
            "coreConversionComputeCalls": counters.conversion_compute_calls,
            "rootObjectiveUsedForSelect": counters.root_objective_used_for_select,
            "deepAllocationAttempts": counters.deep_allocation_attempts,
            "signatureComparisons": counters.signature_comparisons,
            "signatureChanges": counters.signature_changes,
            "nativeSnapshotReads": counters.native_snapshot_reads,
            "revisionRebinds": counters.revision_rebinds,
            "objectiveRebuilds": counters.objective_rebuilds,
            "permutationMaterializations": counters.permutation_materializations,
            "factsCacheMisses": counters.facts_cache_misses,
            "factsCacheHits": counters.facts_cache_hits,
            "identityCanonicalizations": counters.identity_canonicalizations,
            "witnessLookups": counters.witness_lookups,
            "factsCacheEntries": counters.facts_cache_entries,
            "distinctEntrants": counters.distinct_entrants,
            "rawActionsSeen": counters.raw_actions_seen,
            "cacheBytesEstimate": counters.cache_bytes_estimate,
            "rootDraws": counters.root_draws,
            "postStageConversionComputeCalls": audit.post_stage_conversion_compute_calls,
            "postStageConversionAddCalls": audit.post_stage_conversion_add_calls,
            "postStageRerankCalls": audit.post_stage_rerank_calls,
        });
    } else if profile.profile_id == PUBLIC_PROFILE
        || profile.profile_id == RANK_ORDER_PROFILE
        || profile.profile_id == ROOT_VALUE_MIX_PROFILE
        || profile.profile_id == ROOT_VALUE_TIEBREAK_PROFILE
        || profile.profile_id == LEAF_CONVERSION_PROFILE
        || profile.profile_id == LEAF_CONVERSION_GATED_PROFILE
        || profile.profile_id == LEAF_CONVERSION_PRESSURE_GATED_PROFILE
        || profile.profile_id == LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE
    {
        // B keeps the measured earlier transport wire, while composed keeps the
        // frozen transport-thread zeros; only B therefore reads core-carried
        // post-stage counts here.
        let counters = core_post_stage_counters.unwrap_or(PostStageCountersSnapshot {
            conversion_compute_calls: audit.post_stage_conversion_compute_calls,
            conversion_add_calls: audit.post_stage_conversion_add_calls,
            rerank_calls: audit.post_stage_rerank_calls,
            ..Default::default()
        });
        response["diagnostics"] = json!({
            "postStageConversionComputeCalls": counters.conversion_compute_calls,
            "postStageConversionAddCalls": counters.conversion_add_calls,
            "postStageRerankCalls": counters.rerank_calls,
        });
        if profile.profile_id == RANK_ORDER_PROFILE
            || profile.profile_id == ROOT_VALUE_MIX_PROFILE
            || profile.profile_id == ROOT_VALUE_TIEBREAK_PROFILE
            || profile.profile_id == LEAF_CONVERSION_PROFILE
            || profile.profile_id == LEAF_CONVERSION_GATED_PROFILE
            || profile.profile_id == LEAF_CONVERSION_PRESSURE_GATED_PROFILE
            || profile.profile_id == LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE
        {
            response["diagnostics"]["finalOrderPolicyId"] = json!(FINAL_ORDER_POLICY_CC2);
        }
    } else if profile.is_composed() {
        response["diagnostics"] = json!({
            "postStageConversionComputeCalls": audit.post_stage_conversion_compute_calls,
            "postStageConversionAddCalls": audit.post_stage_conversion_add_calls,
            "postStageRerankCalls": audit.post_stage_rerank_calls,
        });
    }
}

pub(crate) fn public_context_digest_for_request(
    request: &Json,
    profile: &Profile,
) -> Result<[u8; 32], CompatError> {
    let state = composed_public_state(request)?;
    Ok(public_context_digest_for_state(&state, request, profile))
}

/// The same digest for a selector state the caller has already parsed from
/// `request`.
pub(crate) fn public_context_digest_for_state(
    state: &F14PublicState,
    request: &Json,
    profile: &Profile,
) -> [u8; 32] {
    public_context_digest(&public_context_document(state, request, profile))
}

// Legacy composed snapshots are retained only to reproduce the earlier
// transport route in byte-compatibility tests. Production obtains the final
// selection from FinishedRootDecision instead.
#[cfg(test)]
pub(crate) fn snapshot_composed_ranking(
    context: &PublicRootLockContext,
    profile: &Profile,
    moves: &[Placement],
    epoch: u64,
    request: &Json,
) -> Result<CoreRankedSnapshot, CompatError> {
    let move_values: Vec<Json> = moves
        .iter()
        .map(|placement| serde_json::to_value(placement).map_err(|_| CompatError::Cs1))
        .collect::<Result<_, _>>()?;
    let identities = placement_identities(&move_values)?;
    let stage = profile.decision_stage();
    Ok(CoreRankedSnapshot {
        binding: snapshot_binding(
            epoch,
            &public_context_document(context.state(), request, profile),
            &identities,
        ),
        prefix: stage.compose_returned_prefix(context, &move_values)?,
    })
}

/// Test-only reproduction of the earlier composed transport route. It keeps
/// the old snapshot and transport rescue together so the new core-owned
/// response can be compared byte-for-byte without keeping that dependency in
/// production.
#[cfg(test)]
pub(crate) fn decide_limited_with_snapshot(
    raw: Json,
    profile: &Profile,
    moves: &[Placement],
    search: SearchStats,
    limits: Option<&F14RuntimeLimits>,
    hook: Option<&F14CancelHook>,
    snapshot: Option<CoreRankedSnapshot>,
    epoch: u64,
) -> Json {
    let (mut response, audit) = crate::s2_audit::run_native_f14_compat(|| {
        crate::s2_audit::with_legacy_selector_guard(false, || {
            if let Err(response) = admit(&raw, profile) {
                return response;
            }
            if let Err(compat_error) = interrupted(limits) {
                let (status, reason) = map_error(compat_error);
                return error(&raw, status, reason);
            }
            F14CancelHook::park(hook.and_then(|value| value.after_selector_enter.as_ref()));
            if let Err(compat_error) = interrupted(limits) {
                let (status, reason) = map_error(compat_error);
                return error(&raw, status, reason);
            }
            if moves.is_empty() {
                return error(&raw, "error", "empty-candidates");
            }
            let move_values: Vec<Json> = match moves
                .iter()
                .map(|placement| serde_json::to_value(placement).map_err(|_| CompatError::Cs1))
                .collect()
            {
                Ok(values) => values,
                Err(_) => return error(&raw, "error", "invalid-input"),
            };
            let selection_result = match snapshot {
                None => Err(CompatError::MissingCoreRanking),
                Some(core) => {
                    validate_snapshot_binding(&core.binding, &raw, profile, &move_values, epoch)
                        .and_then(|()| apply_residual_rescue(core.prefix))
                }
            };
            let selected = match selection_result {
                Ok(value) => value,
                Err(compat_error) => {
                    let (status, reason) = map_error(compat_error);
                    return error(&raw, status, reason);
                }
            };
            if !profile.budget_met(search.selections) {
                return error(&raw, "error", "selection-budget-mismatch");
            }
            format_decision_response(&raw, profile, &move_values, search, selected)
        })
    });
    response["boundaryAudit"] = json!(audit);
    attach_diagnostics(&mut response, profile, None, None, audit);
    response
}

/// Test-only reproduction of the earlier A/B transport selector route. It is
/// retained solely for byte comparison against the core-owned decision.
#[cfg(test)]
pub(crate) fn decide_limited_with_legacy_selector(
    raw: Json,
    profile: &Profile,
    moves: &[Placement],
    search: SearchStats,
    limits: Option<&F14RuntimeLimits>,
    hook: Option<&F14CancelHook>,
    epoch: u64,
) -> Json {
    let (mut response, audit) = crate::s2_audit::run_native_f14_compat(|| {
        crate::s2_audit::with_legacy_selector_guard(false, || {
            if let Err(response) = admit(&raw, profile) {
                return response;
            }
            if let Err(compat_error) = interrupted(limits) {
                let (status, reason) = map_error(compat_error);
                return error(&raw, status, reason);
            }
            F14CancelHook::park(hook.and_then(|value| value.after_selector_enter.as_ref()));
            if let Err(compat_error) = interrupted(limits) {
                let (status, reason) = map_error(compat_error);
                return error(&raw, status, reason);
            }
            if moves.is_empty() {
                return error(&raw, "error", "empty-candidates");
            }
            let selector = raw.get("selector").expect("admitted selector");
            let state = match public_state_from_json(selector) {
                Ok(state) => state,
                Err(compat_error) => {
                    let (status, reason) = map_error(compat_error);
                    return error(&raw, status, reason);
                }
            };
            let move_values: Vec<Json> = match moves
                .iter()
                .map(|placement| serde_json::to_value(placement).map_err(|_| CompatError::Cs1))
                .collect()
            {
                Ok(values) => values,
                Err(_) => return error(&raw, "error", "invalid-input"),
            };
            let stage = profile.decision_stage();
            let options = stage.legacy_selector_options();
            let selected = match profile.profile_id.as_str() {
                A_PROFILE => select_f14_amount_only_limited(&state, &move_values, options, limits),
                PUBLIC_PROFILE | CORE_ALLSPIN_PROFILE | ROOT_VALUE_PROFILE | ROOT_VALUE_MIX_PROFILE
                | ROOT_VALUE_TIEBREAK_PROFILE
                | LEAF_CONVERSION_PROFILE
                | LEAF_CONVERSION_GATED_PROFILE
                | LEAF_CONVERSION_PRESSURE_GATED_PROFILE
                | LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE => {
                    select_f14_public_limited(&state, &move_values, options, limits)
                }
                _ => Err(CompatError::InvalidSelector),
            };
            let selected = match selected {
                Ok(value) => value,
                Err(compat_error) => {
                    let (status, reason) = map_error(compat_error);
                    return error(&raw, status, reason);
                }
            };
            if !profile.budget_met(search.selections) {
                return error(&raw, "error", "selection-budget-mismatch");
            }
            let _ = epoch;
            format_decision_response(&raw, profile, &move_values, search, selected)
        })
    });
    response["boundaryAudit"] = json!(audit);
    attach_diagnostics(&mut response, profile, None, None, audit);
    response
}

fn placement_identities(moves: &[Json]) -> Result<Vec<String>, CompatError> {
    moves
        .iter()
        .map(|value| super::canonicalize(value).map_err(|_| CompatError::Cs1))
        .collect()
}

fn public_context_document(state: &F14PublicState, request: &Json, profile: &Profile) -> Json {
    let start = request.get("start").cloned().unwrap_or(Json::Null);
    let mut profile_document = json!({
        "budget": {
            "maxMillis": profile.budget.max_millis,
            "mode": profile.budget.mode,
            "selections": profile.budget.selections,
        },
        "candidateLimit": 16,
        "configHash": profile.config_hash,
        "isComposed": profile.is_composed(),
        "isPublicAmount": profile.is_public_amount(),
        "postSpinPolicy": match profile.post_spin_policy() {
            PostSpinPolicy::NonTSpinPriorOff => POST_SPIN_POLICY_OFF,
            PostSpinPolicy::LegacyF14 => "legacy-f14",
        },
        "profileId": profile.profile_id,
        "weights": EFFECTIVE_WEIGHTS,
    });
    if let Some(mode) = profile.allocation_mode.as_deref() {
        profile_document["allocationMode"] = json!(mode);
    }
    if let Some(Some(scale)) = profile.root_value_scale.as_ref() {
        profile_document["rootValueScale"] = json!(scale);
    }
    if let Some(Some(scale)) = profile.leaf_conversion_scale.as_ref() {
        profile_document["leafConversionScale"] = json!(scale);
    }
    if let Some(Some(max_height)) = profile.leaf_conversion_max_height.as_ref() {
        profile_document["leafConversionMaxHeight"] = json!(max_height);
    }
    if let Some(Some(scale)) = profile.b2b_charge_scale.as_ref() {
        profile_document["b2bChargeScale"] = json!(scale);
    }
    if let Some(policy) = profile.final_order_policy_id.as_deref() {
        profile_document["finalOrderPolicyId"] = json!(policy);
    }
    json!({
        "profile": profile_document,
        "rulesetId": F14_RULESET_ID,
        "start": {
            "hold": start.get("hold"),
            "queue": start.get("queue"),
            "randomizer": start.get("randomizer"),
        },
        "state": {
            "b2b": state.b2b,
            "boardCells": state.board_cells,
            "combo": state.combo,
            "height": state.height,
            "incoming": {
                "dueThisLockRows": state.incoming.due_this_lock_rows,
                "pendingRows": state.incoming.pending_rows,
            },
            "pieces": {
                "current": state.pieces.current,
                "hold": state.pieces.hold,
                "holdAvailable": state.pieces.hold_available,
                "known": state.pieces.known,
            },
            "time": {
                "fidelity": state.time.fidelity,
                "frameSemantics": state.time.frame_semantics,
                "logicalFrame": state.time.logical_frame,
            },
            "visibleHeight": state.visible_height,
            "width": state.width,
        },
    })
}

fn expected_snapshot_binding(
    request: &Json,
    profile: &Profile,
    moves: &[Json],
    epoch: u64,
) -> Result<super::select::SnapshotBinding, CompatError> {
    let state = public_state_from_json(
        request
            .get("selector")
            .ok_or(CompatError::InvalidSelector)?,
    )?;
    let identities = placement_identities(moves)?;
    Ok(snapshot_binding(
        epoch,
        &public_context_document(&state, request, profile),
        &identities,
    ))
}

fn validate_snapshot_binding(
    binding: &SnapshotBinding,
    request: &Json,
    profile: &Profile,
    moves: &[Json],
    epoch: u64,
) -> Result<(), CompatError> {
    if binding.request_epoch != epoch {
        return Err(CompatError::StaleRankingEpoch);
    }
    let expected = expected_snapshot_binding(request, profile, moves, epoch)?;
    if expected.public_context_digest == binding.public_context_digest
        && expected.returned_count == binding.returned_count
        && expected.returned_identity_digest == binding.returned_identity_digest
        && binding.returned_count == moves.len()
    {
        Ok(())
    } else {
        Err(CompatError::RankingBindingMismatch)
    }
}

pub(crate) fn composed_public_state(raw: &Json) -> Result<F14PublicState, CompatError> {
    let selector = raw.get("selector").ok_or(CompatError::InvalidSelector)?;
    public_state_from_json(selector)
}

pub(crate) fn compat_error_response(raw: &Json, compat_error: CompatError) -> Json {
    let (status, reason) = map_error(compat_error);
    error(raw, status, reason)
}

fn decide_limited_inner(
    raw: Json,
    profile: &Profile,
    moves: &[Placement],
    search: SearchStats,
    limits: Option<&F14RuntimeLimits>,
    hook: Option<&F14CancelHook>,
    epoch: u64,
    root_decision: Option<FinishedRootDecision>,
    admitted: bool,
) -> Json {
    if !admitted {
        if let Err(response) = admit(&raw, profile) {
            return response;
        }
    }
    if let Err(compat_error) = interrupted(limits) {
        let (status, reason) = map_error(compat_error);
        return error(&raw, status, reason);
    }
    F14CancelHook::park(hook.and_then(|value| value.after_selector_enter.as_ref()));
    if let Err(compat_error) = interrupted(limits) {
        let (status, reason) = map_error(compat_error);
        return error(&raw, status, reason);
    }
    if moves.is_empty() {
        return error(&raw, "error", "empty-candidates");
    }
    let move_values: Vec<Json> = match moves
        .iter()
        .map(|placement| serde_json::to_value(placement).map_err(|_| CompatError::Cs1))
        .collect()
    {
        Ok(values) => values,
        Err(_) => return error(&raw, "error", "invalid-input"),
    };
    let selected = match {
        match root_decision {
            None => Err(CompatError::MissingCoreRanking),
            Some(decision) => {
                validate_snapshot_binding(&decision.binding, &raw, profile, &move_values, epoch)
                    .map(|()| decision.selection)
            }
        }
    } {
        Ok(value) => value,
        Err(compat_error) => {
            let (status, reason) = map_error(compat_error);
            return error(&raw, status, reason);
        }
    };
    if !profile.budget_met(search.selections) {
        return error(&raw, "error", "selection-budget-mismatch");
    }
    format_decision_response(&raw, profile, &move_values, search, selected)
}

fn format_decision_response(
    raw: &Json,
    profile: &Profile,
    move_values: &[Json],
    search: SearchStats,
    selected: F14Selection,
) -> Json {
    let termination = if profile.is_time_budget() { "time-budget" } else { "selection-budget" };
    let mut response = error(raw, "move", termination);
    response["execution"] = json!(profile);
    response["selectedPlacement"] = selected_placement_json(&selected.selected);
    response["selectedMove"] = selected.selected.move_value;
    response["selectedIdentity"] = json!(selected.selected.identity);
    response["search"] = json!({
        "nodes": search.nodes,
        "requestedSelections": profile.budget.selections,
        "actualSelections": search.selections,
        "returnedCount": selected.returned_candidate_count,
        "rootLegal": selected.returned_candidate_count,
        "termination": termination
    });
    // A queue beyond the default truncation is echoed, so the host can bind the
    // decision to the search depth it asked for; default responses are unchanged.
    let searched_queue = raw.pointer("/start/queue").and_then(Json::as_array).map_or(0, Vec::len);
    if searched_queue > QUEUE_LIMIT {
        response["search"]["queueLength"] = json!(searched_queue);
    }
    response["ranking"] = json!({
        "selectedCc2Rank": selected.selected.cc2_rank,
        "rescueApplied": selected.rescued,
        "generatedCandidates": selected.generated_candidates,
        "identities": selected.ranked.iter().map(|candidate| candidate.identity.clone()).collect::<Vec<_>>(),
    });
    if profile.is_public_amount() {
        response["ranking"]["returnedIdentities"] = json!(move_values
            .iter()
            .map(|value| super::canonicalize(value).expect("serialized placement"))
            .collect::<Vec<_>>());
        let facts: std::collections::HashMap<i32, &super::select::F14SelectedCandidate> = selected
            .prefix_facts
            .iter()
            .map(|candidate| (candidate.cc2_rank, candidate))
            .collect();
        response["ranking"]["candidates"] = json!(selected
            .ranked
            .iter()
            .map(|candidate| {
                let mut row = json!({
                    "cc2Rank": candidate.cc2_rank,
                    "s2Score": candidate.s2_score,
                    "selectionScore": candidate.selection_score,
                    "solvency": candidate.solvency,
                    "solvent": candidate.solvent,
                    "conversionBranch": candidate.conversion.branch.as_str(),
                    "conversionUnits": candidate.conversion.units,
                });
                if profile.is_composed() || profile.uses_core_snapshot() {
                    if let Some(fact) = facts.get(&candidate.cc2_rank) {
                        row["qualifies"] = json!(fact.conversion.qualifies);
                        row["renCombatGain"] = json!(fact.ren_combat_gain);
                        row["releaseValue"] = json!(fact.release_value);
                        row["setupWitnessed"] = json!(fact.setup_witnessed);
                        row["comboAfter"] = json!(fact.combo_after);
                        row["b2bAfter"] = json!(fact.b2b_after);
                        row["lines"] = json!(fact.lines);
                        row["spin"] = json!(fact.spin);
                        row["surgeSent"] = json!(fact.surge_sent);
                        row["cancelled"] = json!(fact.cancelled);
                    }
                }
                row
            })
            .collect::<Vec<_>>());
    }
    response
}

fn selected_placement_json(selected: &super::select::F14SelectedCandidate) -> Json {
    json!({
        "piece": selected.placement.piece,
        "rotation": selected.placement.rotation,
        "x": selected.placement.x,
        "y": selected.placement.y,
        "usedHold": selected.placement.used_hold,
        "rotationEvidence": {
            "lastInputWasRotation": selected.last_rotation,
            "kickIndex": selected.kick_index,
            "kickId": selected.kick_id,
            "kickOffset": selected.kick_offset.map(|(x, y)| vec![x, y]),
        }
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn pressure_gated_profile_rejects_retained_rerank() {
        assert!(super::supports_retained_rerank(super::PUBLIC_PROFILE));
        assert!(super::supports_retained_rerank(super::LEAF_CONVERSION_GATED_PROFILE));
        assert!(!super::supports_retained_rerank(super::LEAF_CONVERSION_PRESSURE_GATED_PROFILE));
        assert!(!super::supports_retained_rerank(
            super::LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE
        ));
    }

    fn prefix_compatibility_requests() -> (Json, Json) {
        let queue = vec![
            "I", "O", "T", "S", "Z", "J", "L", "T", "S", "Z", "J", "L", "I", "O",
        ];
        let retained = json!({
            "requestId": "prefix-source",
            "positionId": "prefix-source-position",
            "generation": 1,
            "execution": { "profileId": super::LEAF_CONVERSION_GATED_PROFILE },
            "start": {
                "board": "public-board",
                "queue": queue[..13],
                "hold": null,
                "combo": 0,
                "back_to_back": false,
                "b2b": 0,
                "randomizer": { "type": "seven_bag", "bag_state": [] }
            },
            "selector": {
                "pieces": { "current": queue[0], "known": queue[1..13], "hold": null },
                "incoming": { "pendingRows": 0, "dueThisLockRows": 0 },
                "time": { "logicalFrame": 0 }
            }
        });
        let mut real = retained.clone();
        real["requestId"] = json!("prefix-target");
        real["positionId"] = json!("prefix-target-position");
        real["generation"] = json!(2);
        real["start"]["queue"] = json!(queue);
        real["selector"]["pieces"]["known"] =
            json!(["O", "T", "S", "Z", "J", "L", "T", "S", "Z", "J", "L", "I", "O"]);
        real["selector"]["incoming"] = json!({ "pendingRows": 3, "dueThisLockRows": 0 });
        real["selector"]["time"]["logicalFrame"] = json!(10);
        (retained, real)
    }

    #[test]
    fn input_queue_prefix_admission_is_opt_in_and_exactly_one_piece() {
        let (retained, real) = prefix_compatibility_requests();
        assert!(super::input_queue_prefix_allowed(
            true,
            super::LEAF_CONVERSION_GATED_PROFILE
        ));
        assert!(!super::input_queue_prefix_allowed(
            false,
            super::LEAF_CONVERSION_GATED_PROFILE
        ));
        assert!(!super::input_queue_prefix_allowed(
            true,
            super::PUBLIC_PROFILE
        ));
        assert_eq!(
            super::rerank_request_compatible(&retained, &real, true),
            Some(super::RerankRequestMatch::InputQueuePrefix)
        );
        assert_eq!(
            super::rerank_request_compatible(&retained, &real, false),
            None
        );

        let mut two_missing = real.clone();
        two_missing["start"]["queue"]
            .as_array_mut()
            .unwrap()
            .push(json!("T"));
        assert_eq!(
            super::rerank_request_compatible(&retained, &two_missing, true),
            None
        );

        let mut different_prefix_piece = real.clone();
        different_prefix_piece["start"]["queue"][2] = json!("I");
        assert_eq!(
            super::rerank_request_compatible(&retained, &different_prefix_piece, true),
            None
        );

        let mut nonempty_bag = retained.clone();
        nonempty_bag["start"]["randomizer"]["bag_state"] = json!(["O"]);
        assert_eq!(
            super::rerank_request_compatible(&nonempty_bag, &real, true),
            None
        );

        let mut changed_start_field = real.clone();
        changed_start_field["start"]["hold"] = json!("T");
        assert_eq!(
            super::rerank_request_compatible(&retained, &changed_start_field, true),
            None
        );

        let mut changed_execution = real;
        changed_execution["execution"]["seed"] = json!("1");
        assert_eq!(
            super::rerank_request_compatible(&retained, &changed_execution, true),
            None
        );
    }

    use super::*;
    use crate::data::Placement;
    use crate::f14_compat::driver::F14Driver;
    use crate::f14_compat::select::{FinishedRootOutcome, RootObjectiveSession};
    use serde_json::json;
    use std::path::Path;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use std::time::{Duration, Instant};

    fn load_p5() -> Json {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/diagnostics/cc2-s2-f14-amount-only-native-compat-p5.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("p5 fixture")).expect("p5 json")
    }

    fn profile() -> Profile {
        Profile {
            profile_id: "f14-amount-only-compat-a/1".into(),
            config_hash: CONFIG_HASH.into(),
            seed: "1395802947".into(),
            worker_concurrency: 1,
            budget: Budget {
                mode: "selection".into(),
                selections: 512,
                max_millis: 30_000,
            },
            post_spin_policy_id: None,
            allocation_mode: None,
            root_value_scale: None,
            leaf_conversion_scale: None,
            leaf_conversion_max_height: None,
            b2b_charge_scale: None,
            final_order_policy_id: None,
        }
    }

    fn core_allspin_profile(config_hash: &str) -> Profile {
        Profile {
            profile_id: CORE_ALLSPIN_PROFILE.into(),
            config_hash: config_hash.into(),
            seed: "5994928009864282113".into(),
            worker_concurrency: 1,
            budget: Budget {
                mode: "selection".into(),
                selections: 512,
                max_millis: 30_000,
            },
            post_spin_policy_id: Some(POST_SPIN_POLICY_OFF.into()),
            allocation_mode: None,
            root_value_scale: None,
            leaf_conversion_scale: None,
            leaf_conversion_max_height: None,
            b2b_charge_scale: None,
            final_order_policy_id: None,
        }
    }

    fn rank_order_profile(config_hash: &str) -> Profile {
        Profile {
            profile_id: RANK_ORDER_PROFILE.into(),
            config_hash: config_hash.into(),
            seed: "5994928009864282113".into(),
            worker_concurrency: 1,
            budget: Budget {
                mode: "selection".into(),
                selections: 512,
                max_millis: 30_000,
            },
            post_spin_policy_id: None,
            allocation_mode: None,
            root_value_scale: None,
            leaf_conversion_scale: None,
            leaf_conversion_max_height: None,
            b2b_charge_scale: None,
            final_order_policy_id: Some(FINAL_ORDER_POLICY_CC2.into()),
        }
    }

    fn root_value_mix_profile(config_hash: &str) -> Profile {
        Profile {
            profile_id: ROOT_VALUE_MIX_PROFILE.into(),
            config_hash: config_hash.into(),
            seed: "5994928009864282113".into(),
            worker_concurrency: 1,
            budget: Budget {
                mode: "selection".into(),
                selections: 512,
                max_millis: 30_000,
            },
            post_spin_policy_id: None,
            allocation_mode: Some(super::super::root_allocation::ROOT_VALUE_MIX_MODE.into()),
            root_value_scale: Some(Some("0.5".into())),
            leaf_conversion_scale: None,
            leaf_conversion_max_height: None,
            b2b_charge_scale: None,
            final_order_policy_id: Some(FINAL_ORDER_POLICY_CC2.into()),
        }
    }

    fn root_value_tiebreak_profile(config_hash: &str) -> Profile {
        Profile {
            profile_id: ROOT_VALUE_TIEBREAK_PROFILE.into(),
            config_hash: config_hash.into(),
            seed: "5994928009864282113".into(),
            worker_concurrency: 1,
            budget: Budget {
                mode: "selection".into(),
                selections: 512,
                max_millis: 30_000,
            },
            post_spin_policy_id: None,
            allocation_mode: Some(super::super::root_allocation::ROOT_VALUE_TIEBREAK_MODE.into()),
            root_value_scale: None,
            leaf_conversion_scale: None,
            leaf_conversion_max_height: None,
            b2b_charge_scale: None,
            final_order_policy_id: Some(FINAL_ORDER_POLICY_CC2.into()),
        }
    }

    fn leaf_conversion_profile(config_hash: &str) -> Profile {
        Profile {
            profile_id: LEAF_CONVERSION_PROFILE.into(),
            config_hash: config_hash.into(),
            seed: "5994928009864282113".into(),
            worker_concurrency: 1,
            budget: Budget {
                mode: "selection".into(),
                selections: 512,
                max_millis: 30_000,
            },
            post_spin_policy_id: None,
            allocation_mode: Some(super::super::root_allocation::LEAF_CONVERSION_MODE.into()),
            root_value_scale: None,
            leaf_conversion_scale: Some(Some("0.5".into())),
            leaf_conversion_max_height: None,
            b2b_charge_scale: None,
            final_order_policy_id: Some(FINAL_ORDER_POLICY_CC2.into()),
        }
    }

    fn leaf_conversion_gated_profile(config_hash: &str) -> Profile {
        Profile {
            profile_id: LEAF_CONVERSION_GATED_PROFILE.into(),
            config_hash: config_hash.into(),
            seed: "5994928009864282113".into(),
            worker_concurrency: 1,
            budget: Budget {
                mode: "selection".into(),
                selections: 512,
                max_millis: 30_000,
            },
            post_spin_policy_id: None,
            allocation_mode: Some(super::super::root_allocation::LEAF_CONVERSION_GATED_MODE.into()),
            root_value_scale: None,
            leaf_conversion_scale: Some(Some("0.25".into())),
            leaf_conversion_max_height: Some(Some("8".into())),
            b2b_charge_scale: None,
            final_order_policy_id: Some(FINAL_ORDER_POLICY_CC2.into()),
        }
    }

    fn leaf_conversion_pressure_gated_profile(config_hash: &str) -> Profile {
        Profile {
            profile_id: LEAF_CONVERSION_PRESSURE_GATED_PROFILE.into(),
            config_hash: config_hash.into(),
            seed: "5994928009864282113".into(),
            worker_concurrency: 1,
            budget: Budget {
                mode: "selection".into(),
                selections: 512,
                max_millis: 30_000,
            },
            post_spin_policy_id: None,
            allocation_mode: Some(
                super::super::root_allocation::LEAF_CONVERSION_PRESSURE_GATED_MODE.into(),
            ),
            root_value_scale: None,
            leaf_conversion_scale: Some(Some("0.25".into())),
            leaf_conversion_max_height: Some(Some("8".into())),
            b2b_charge_scale: None,
            final_order_policy_id: Some(FINAL_ORDER_POLICY_CC2.into()),
        }
    }

    fn leaf_conversion_gated_b2b_charge_profile(config_hash: &str) -> Profile {
        Profile {
            profile_id: LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE.into(),
            config_hash: config_hash.into(),
            seed: "5994928009864282113".into(),
            worker_concurrency: 1,
            budget: Budget {
                mode: "selection".into(),
                selections: 512,
                max_millis: 30_000,
            },
            post_spin_policy_id: None,
            allocation_mode: Some(
                super::super::root_allocation::LEAF_CONVERSION_GATED_B2B_CHARGE_MODE.into(),
            ),
            root_value_scale: None,
            leaf_conversion_scale: Some(Some("0.25".into())),
            leaf_conversion_max_height: Some(Some("8".into())),
            b2b_charge_scale: Some(Some("0.5".into())),
            final_order_policy_id: Some(FINAL_ORDER_POLICY_CC2.into()),
        }
    }

    fn tbp_board_from_cells(cells: &str) -> Vec<Vec<Option<char>>> {
        (0..40)
            .map(|y| {
                (0..10)
                    .map(|x| {
                        let cell = cells.as_bytes()[y * 10 + x];
                        if cell == b'_' {
                            None
                        } else {
                            Some(cell as char)
                        }
                    })
                    .collect()
            })
            .collect()
    }

    fn opening_start() -> Json {
        let start = load_p5()["decisions"][0]["start"].clone();
        json!({
            "board": tbp_board_from_cells(start["boardCells"].as_str().unwrap()),
            "queue": start["queue"],
            "hold": start["hold"],
            "combo": start["combo"],
            "back_to_back": start["back_to_back"],
            "b2b": start["b2b"],
            "randomizer": start["randomizer"],
        })
    }

    fn request_with_selector(selector: Json) -> Json {
        json!({
            "type": "f14_decide",
            "schemaVersion": 1,
            "requestId": "f14-test",
            "positionId": "f14-test-position",
            "generation": 1,
            "execution": profile(),
            "start": opening_start(),
            "selector": selector,
        })
    }

    fn dummy_move() -> Placement {
        serde_json::from_value(load_p5()["decisions"][0]["moves"][0].clone()).unwrap()
    }

    fn job_config(profile: &Profile) -> Arc<crate::bot::BotConfig> {
        Arc::new(profile.search_bot_config().unwrap())
    }

    fn run_production_job(profile: &Profile, request: Json) -> Json {
        let bot = Arc::new(crate::sync::BotSyncronizer::new());
        let worker_bot = bot.clone();
        let worker = std::thread::spawn(move || worker_bot.work_loop());
        let flag = Arc::new(AtomicBool::new(false));
        let gate = parking_lot::Mutex::new(F14StartGate::new());
        gate.lock().begin(1);
        let response = crate::sync::f14_decide_job(
            request,
            profile,
            job_config(profile),
            &bot,
            &flag,
            1,
            &gate,
            None,
        );
        bot.stop();
        drop(worker);
        response
    }

    fn run_f14_driver_with_retained(
        profile: &Profile,
        request: Json,
    ) -> (Json, Option<crate::f14_compat::driver::F14RerankState>) {
        let mut driver = F14Driver::start(profile.clone(), request).expect("F14 driver start");
        loop {
            if driver.work(8).complete {
                return driver.finish_with_retained();
            }
        }
    }

    fn run_f14_driver(profile: &Profile, request: Json) -> Json {
        run_f14_driver_with_retained(profile, request).0
    }

    fn without_timing_fields(value: &mut Json) {
        match value {
            Json::Object(object) => {
                for key in ["nps", "elapsed", "elapsedMs", "elapsedMillis", "durationMs"] {
                    object.remove(key);
                }
                for child in object.values_mut() {
                    without_timing_fields(child);
                }
            }
            Json::Array(array) => {
                for child in array {
                    without_timing_fields(child);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn f14_driver_admission_errors_match_native_job() {
        let valid = profile();
        let selector = load_p5()["decisions"][0]["selector"].clone();
        let mut unsupported = valid.clone();
        unsupported.profile_id = "f14-unsupported-profile/1".into();
        let mut wrong_hash = valid.clone();
        wrong_hash.config_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000".into();
        let mut missing_start = request_with_profile(selector, &valid);
        missing_start
            .as_object_mut()
            .expect("request object")
            .remove("start");
        let cases = [
            (
                "unsupported profile",
                unsupported.clone(),
                request_with_profile(load_p5()["decisions"][0]["selector"].clone(), &unsupported),
            ),
            (
                "wrong config hash",
                wrong_hash.clone(),
                request_with_profile(load_p5()["decisions"][0]["selector"].clone(), &wrong_hash),
            ),
            ("missing start", valid.clone(), missing_start),
        ];
        for (label, candidate, request) in cases {
            let native = run_production_job(&candidate, request.clone());
            let driver = match F14Driver::start(candidate, request) {
                Ok(_) => panic!("{label}: admission unexpectedly succeeded"),
                Err(response) => response,
            };
            assert_eq!(driver, native, "{label}");
        }
    }

    #[test]
    fn f14_driver_deadline_matches_native_job() {
        let mut candidate = profile();
        candidate.budget.max_millis = 0;
        let request = request_with_profile(load_p5()["decisions"][0]["selector"].clone(), &candidate);
        let native = run_production_job(&candidate, request.clone());
        let driver = match F14Driver::start(candidate, request) {
            Ok(_) => panic!("zero deadline unexpectedly started"),
            Err(response) => response,
        };
        assert_eq!(native["status"], "incomplete");
        assert_eq!(native["reason"], "deadline");
        assert_eq!(driver, native);
    }

    #[test]
    fn f14_driver_budget_completion_matches_native_job() {
        let mut candidate = profile();
        candidate.budget.selections = 8;
        let request = request_with_profile(load_p5()["decisions"][0]["selector"].clone(), &candidate);
        let native = run_production_job(&candidate, request.clone());
        let driver = run_f14_driver(&candidate, request);
        let mut native_without_timing = native;
        let mut driver_without_timing = driver;
        without_timing_fields(&mut native_without_timing);
        without_timing_fields(&mut driver_without_timing);
        assert_eq!(driver_without_timing, native_without_timing);
    }

    #[test]
    fn included_config_hash_matches_p5_file_bytes_binding() {
        let p5 = load_p5();
        assert!(CONFIG.contains("\"enable_direct_180\": true"));
        assert!(CONFIG.contains("\"suggestion_count\": 16"));
        assert!(!CONFIG.contains("enable_s2_amount_only_incoming"));
        assert!(!CONFIG.contains("s2-native-integrated/1"));
        assert_eq!(CONFIG_HASH, p5["nativeConfigSha256"].as_str().unwrap());
        assert_ne!(FEATURE, crate::native_s2::transport::FEATURE);
    }

    fn sha256_hex(bytes: &str) -> String {
        use sha2::{Digest, Sha256};
        format!("sha256:{:x}", Sha256::digest(bytes.as_bytes()))
    }

    #[test]
    fn registry_binds_config_bytes_to_declared_hashes() {
        assert_eq!(sha256_hex(CONFIG), CONFIG_HASH);
        assert_eq!(sha256_hex(CAS_CONFIG), CAS_CONFIG_HASH);
        assert_eq!(sha256_hex(MS06_CONFIG), MS06_CONFIG_HASH);
        assert!(CAS_CONFIG.contains("\"mini_spin_clears\": [0.0, 0.6, 0.95, 1.9]"));
        assert!(MS06_CONFIG.contains("\"mini_spin_clears\": [0.0, 0.6, 0.95, 1.9]"));
        assert!(!CAS_CONFIG.contains("enable_s2_amount_only_incoming"));
        let r = core_allspin_profile(CONFIG_HASH);
        let wr = core_allspin_profile(CAS_CONFIG_HASH);
        let mut root_value = core_allspin_profile(CAS_CONFIG_HASH);
        root_value.profile_id = ROOT_VALUE_PROFILE.into();
        let rank_r = rank_order_profile(CONFIG_HASH);
        let rank_ms06 = rank_order_profile(MS06_CONFIG_HASH);
        assert!(r.valid() && wr.valid());
        assert!(root_value.valid());
        assert!(root_value.is_public_amount() && root_value.uses_core_decision());
        assert_eq!(root_value.advertised_feature(), CORE_ALLSPIN_FEATURE);
        assert_eq!(root_value.config_bytes(), CAS_CONFIG);
        root_value.config_hash = CONFIG_HASH.into();
        assert!(!root_value.valid(), "root-value profile is bound to CAS config");
        assert!(rank_r.valid() && rank_ms06.valid());
        assert_eq!(r.config_bytes(), CONFIG);
        assert_eq!(wr.config_bytes(), CAS_CONFIG);
        assert_eq!(rank_r.config_bytes(), CONFIG);
        assert_eq!(rank_ms06.config_bytes(), MS06_CONFIG);
        assert_eq!(
            r.post_spin_policy(),
            crate::f14_compat::PostSpinPolicy::NonTSpinPriorOff
        );
        assert_eq!(
            profile().post_spin_policy(),
            crate::f14_compat::PostSpinPolicy::LegacyF14
        );
    }

    #[test]
    fn legacy_profiles_reject_policy_field_and_keep_old_wire_shape() {
        let mut extra = profile();
        extra.post_spin_policy_id = Some(POST_SPIN_POLICY_OFF.into());
        assert!(!extra.valid());
        extra.post_spin_policy_id = None;
        extra.final_order_policy_id = Some(FINAL_ORDER_POLICY_CC2.into());
        assert!(!extra.valid());
        let encoded = serde_json::to_value(profile()).unwrap();
        let decoded: Profile = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(decoded, profile(), "profiles without rootValueScale remain deserializable");
        let mut keys: Vec<_> = encoded.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "budget",
                "configHash",
                "profileId",
                "seed",
                "workerConcurrency"
            ]
        );
        assert!(encoded.get("postSpinPolicyId").is_none());
        extra.profile_id = CORE_ALLSPIN_PROFILE.into();
        extra.post_spin_policy_id = None;
        extra.config_hash = CONFIG_HASH.into();
        assert!(!extra.valid());
        extra.post_spin_policy_id = Some("legacy-f14/1".into());
        assert!(!extra.valid());
        extra.profile_id = COMPOSED_A.into();
        extra.post_spin_policy_id = None;
        extra.final_order_policy_id = None;
        assert!(extra.valid());
        assert!(extra.is_composed());
        assert!(!extra.is_public_amount());
        extra.profile_id = COMPOSED_B.into();
        assert!(extra.valid() && extra.is_composed() && extra.is_public_amount());
        extra.profile_id = "f14-root-owned-ranking-a/1".into();
        extra.post_spin_policy_id = None;
        assert!(!extra.valid());
        extra.post_spin_policy_id = Some(POST_SPIN_POLICY_OFF.into());
        assert!(!extra.valid());
    }

    #[test]
    fn rank_order_profile_validity_matrix_is_closed() {
        let valid_champion = rank_order_profile(CONFIG_HASH);
        let valid_mini_spin = rank_order_profile(MS06_CONFIG_HASH);
        assert!(valid_champion.valid());
        assert!(valid_mini_spin.valid());

        let mut unknown_policy = valid_champion.clone();
        unknown_policy.final_order_policy_id = Some("unknown/1".into());
        assert!(!unknown_policy.valid());
        let mut post_spin = valid_champion.clone();
        post_spin.post_spin_policy_id = Some(POST_SPIN_POLICY_OFF.into());
        assert!(!post_spin.valid());
        let mut allocation = valid_champion.clone();
        allocation.allocation_mode = Some("off".into());
        assert!(!allocation.valid());
        let mut wrong_worker = valid_champion.clone();
        wrong_worker.worker_concurrency = 2;
        assert!(!wrong_worker.valid());
        let mut wrong_mode = valid_champion.clone();
        wrong_mode.budget.mode = "time".into();
        assert!(!wrong_mode.valid());

        let mut existing = public_b_profile();
        existing.final_order_policy_id = Some(FINAL_ORDER_POLICY_CC2.into());
        assert!(!existing.valid());
        let encoded = serde_json::to_value(&existing).unwrap();
        assert_eq!(encoded["finalOrderPolicyId"], FINAL_ORDER_POLICY_CC2);
    }

    #[test]
    fn root_profile_rejects_identity_mutations_and_legacy_allocation_mode() {
        let mut root = profile();
        root.profile_id = ROOT_OBJECTIVE_PROFILE.into();
        root.seed = "5994928009864282113".into();
        root.allocation_mode = Some("off".into());
        assert!(root.valid());
        let mut missing_mode = root.clone();
        missing_mode.allocation_mode = None;
        assert!(!missing_mode.valid());
        let mut invalid_mode = root.clone();
        invalid_mode.allocation_mode = Some("on".into());
        assert!(!invalid_mode.valid());
        let mut feedback = root.clone();
        feedback.allocation_mode = Some("conversion-permutation-v1".into());
        assert!(feedback.valid());
        let mut wrong_seed = root.clone();
        wrong_seed.seed = "1395802947".into();
        assert!(!wrong_seed.valid());
        let mut wrong_budget = root.clone();
        wrong_budget.budget.selections = 511;
        assert!(!wrong_budget.valid());
        let mut wrong_worker = root.clone();
        wrong_worker.worker_concurrency = 2;
        assert!(!wrong_worker.valid());
        let mut legacy = profile();
        legacy.allocation_mode = Some("off".into());
        assert!(!legacy.valid());
    }

    #[test]
    fn root_value_mix_profile_is_champion_bound_and_owns_its_scale_field() {
        let mix = root_value_mix_profile(CONFIG_HASH);
        assert!(mix.valid());
        assert!(mix.is_public_amount() && mix.uses_core_decision());
        assert_eq!(mix.root_value_scale_f64(), Some(0.5));
        assert_eq!(mix.decision_stage().legacy_selector_options().final_order_policy,
            FinalOrderPolicy::Cc2RankOrder);

        let mut wrong_config = mix.clone();
        wrong_config.config_hash = CAS_CONFIG_HASH.into();
        assert!(!wrong_config.valid(), "root-value mix is champion-config-only");
        let mut missing_scale = mix.clone();
        missing_scale.root_value_scale = None;
        assert!(!missing_scale.valid());
        let mut non_finite_scale = mix.clone();
        non_finite_scale.root_value_scale = Some(Some("NaN".into()));
        assert!(!non_finite_scale.valid());
        let mut wrong_mode = mix.clone();
        wrong_mode.allocation_mode = Some("off".into());
        assert!(!wrong_mode.valid());
        let mut wrong_order = mix.clone();
        wrong_order.final_order_policy_id = None;
        assert!(!wrong_order.valid());

        let mut legacy_root_value = core_allspin_profile(CAS_CONFIG_HASH);
        legacy_root_value.profile_id = ROOT_VALUE_PROFILE.into();
        let mut composed_a = profile();
        composed_a.profile_id = COMPOSED_A.into();
        let mut other_profiles = vec![
            profile(),
            public_b_profile(),
            composed_a,
            composed_b_profile(),
            core_allspin_profile(CONFIG_HASH),
            legacy_root_value,
            rank_order_profile(CONFIG_HASH),
            root_profile(),
            root_value_tiebreak_profile(CONFIG_HASH),
        ];
        for other in &mut other_profiles {
            other.root_value_scale = Some(Some("0.5".into()));
            assert!(!other.valid(), "{} rejects rootValueScale", other.profile_id);
        }
    }

    #[test]
    fn root_value_tiebreak_profile_is_champion_bound_and_rejects_a_scale() {
        let tie = root_value_tiebreak_profile(CONFIG_HASH);
        assert!(tie.valid());
        assert!(tie.is_public_amount() && tie.uses_core_decision());
        assert_eq!(tie.root_value_scale_f64(), None);
        assert_eq!(
            tie.decision_stage().legacy_selector_options().final_order_policy,
            FinalOrderPolicy::Cc2RankOrder
        );

        let mut wrong_config = tie.clone();
        wrong_config.config_hash = CAS_CONFIG_HASH.into();
        assert!(!wrong_config.valid(), "tiebreak profile is champion-config-only");
        let mut with_scale = tie.clone();
        with_scale.root_value_scale = Some(Some("0.3".into()));
        assert!(!with_scale.valid(), "rootValueScale belongs to the mix profile");
        let mut wrong_mode = tie.clone();
        wrong_mode.allocation_mode = Some(super::super::root_allocation::ROOT_VALUE_MIX_MODE.into());
        assert!(!wrong_mode.valid());
        let mut wrong_order = tie.clone();
        wrong_order.final_order_policy_id = None;
        assert!(!wrong_order.valid());
    }

    #[test]
    fn leaf_conversion_profile_is_champion_bound_and_owns_its_scale_field() {
        let leaf = leaf_conversion_profile(CONFIG_HASH);
        assert!(leaf.valid());
        assert!(leaf.is_public_amount() && leaf.uses_core_decision());
        assert_eq!(leaf.leaf_conversion_scale_f64(), Some(0.5));
        assert_eq!(leaf.root_value_scale_f64(), None);
        assert_eq!(
            leaf.decision_stage()
                .legacy_selector_options()
                .final_order_policy,
            FinalOrderPolicy::Cc2RankOrder
        );

        let mut wrong_config = leaf.clone();
        wrong_config.config_hash = CAS_CONFIG_HASH.into();
        assert!(
            !wrong_config.valid(),
            "leaf conversion is champion-config-only"
        );
        let mut missing_scale = leaf.clone();
        missing_scale.leaf_conversion_scale = None;
        assert!(!missing_scale.valid());
        let mut non_finite_scale = leaf.clone();
        non_finite_scale.leaf_conversion_scale = Some(Some("Infinity".into()));
        assert!(!non_finite_scale.valid());
        let mut wrong_mode = leaf.clone();
        wrong_mode.allocation_mode = Some("off".into());
        assert!(!wrong_mode.valid());
        let mut wrong_order = leaf.clone();
        wrong_order.final_order_policy_id = None;
        assert!(!wrong_order.valid());
        let mut wrong_scale_field = leaf.clone();
        wrong_scale_field.root_value_scale = Some(Some("0.5".into()));
        assert!(!wrong_scale_field.valid());

        let mut legacy_root_value = core_allspin_profile(CAS_CONFIG_HASH);
        legacy_root_value.profile_id = ROOT_VALUE_PROFILE.into();
        let mut composed_a = profile();
        composed_a.profile_id = COMPOSED_A.into();
        let mut other_profiles = vec![
            profile(),
            public_b_profile(),
            composed_a,
            composed_b_profile(),
            core_allspin_profile(CONFIG_HASH),
            legacy_root_value,
            rank_order_profile(CONFIG_HASH),
            root_profile(),
            root_value_mix_profile(CONFIG_HASH),
            root_value_tiebreak_profile(CONFIG_HASH),
        ];
        for other in &mut other_profiles {
            other.leaf_conversion_scale = Some(Some("0.5".into()));
            assert!(
                !other.valid(),
                "{} rejects leafConversionScale",
                other.profile_id
            );
            other.leaf_conversion_scale = None;
            other.leaf_conversion_max_height = Some(Some("8".into()));
            assert!(
                !other.valid(),
                "{} rejects leafConversionMaxHeight",
                other.profile_id
            );
            let mut null_height = serde_json::to_value(other.clone()).unwrap();
            null_height["leafConversionMaxHeight"] = Json::Null;
            assert!(
                !serde_json::from_value::<Profile>(null_height).unwrap().valid(),
                "{} rejects explicit-null leafConversionMaxHeight",
                other.profile_id
            );
        }
    }

    #[test]
    fn leaf_conversion_gated_profile_requires_canonical_scale_and_height() {
        let gated = leaf_conversion_gated_profile(CONFIG_HASH);
        assert!(gated.valid());
        assert!(gated.is_public_amount() && gated.uses_core_decision());
        assert_eq!(gated.leaf_conversion_scale_f64(), Some(0.25));
        assert_eq!(gated.leaf_conversion_max_height_u32(), Some(8));
        assert_eq!(
            gated.decision_stage().legacy_selector_options().final_order_policy,
            FinalOrderPolicy::Cc2RankOrder
        );

        let mut wrong_config = gated.clone();
        wrong_config.config_hash = CAS_CONFIG_HASH.into();
        assert!(!wrong_config.valid());
        let mut missing_scale = gated.clone();
        missing_scale.leaf_conversion_scale = None;
        assert!(!missing_scale.valid());
        let mut missing_height = gated.clone();
        missing_height.leaf_conversion_max_height = None;
        assert!(!missing_height.valid());
        for value in ["0", "41", "01", "8.0", " 8"] {
            let mut bad_height = gated.clone();
            bad_height.leaf_conversion_max_height = Some(Some(value.into()));
            assert!(!bad_height.valid(), "reject height {value:?}");
        }
        let mut null_scale = serde_json::to_value(&gated).unwrap();
        null_scale["leafConversionScale"] = Json::Null;
        assert!(!serde_json::from_value::<Profile>(null_scale).unwrap().valid());
        let mut null_height = serde_json::to_value(&gated).unwrap();
        null_height["leafConversionMaxHeight"] = Json::Null;
        let parsed: Profile = serde_json::from_value(null_height).unwrap();
        assert_eq!(parsed.leaf_conversion_max_height, Some(None));
        assert!(!parsed.valid());

        let mut old_leaf = leaf_conversion_profile(CONFIG_HASH);
        old_leaf.leaf_conversion_max_height = Some(Some("8".into()));
        assert!(!old_leaf.valid(), "the ungated leaf profile rejects the new field");
    }

    #[test]
    fn leaf_conversion_gated_scale_and_height_change_public_context_digest() {
        let selector = load_p5()["decisions"][0]["selector"].clone();
        let base = leaf_conversion_gated_profile(CONFIG_HASH);
        let mut changed_scale = base.clone();
        changed_scale.leaf_conversion_scale = Some(Some("0.3".into()));
        let mut changed_height = base.clone();
        changed_height.leaf_conversion_max_height = Some(Some("9".into()));
        let base_request = request_with_profile(selector.clone(), &base);
        let scale_request = request_with_profile(selector.clone(), &changed_scale);
        let height_request = request_with_profile(selector, &changed_height);
        let base_digest = public_context_digest_for_request(&base_request, &base).unwrap();
        assert_ne!(
            base_digest,
            public_context_digest_for_request(&scale_request, &changed_scale).unwrap()
        );
        assert_ne!(
            base_digest,
            public_context_digest_for_request(&height_request, &changed_height).unwrap()
        );
        let state = composed_public_state(&base_request).unwrap();
        let document = public_context_document(&state, &base_request, &base);
        assert_eq!(document["profile"]["leafConversionScale"], "0.25");
        assert_eq!(document["profile"]["leafConversionMaxHeight"], "8");
    }

    #[test]
    fn leaf_conversion_pressure_gated_profile_is_selection_only_and_height_bound() {
        let pressure = leaf_conversion_pressure_gated_profile(CONFIG_HASH);
        assert!(pressure.valid());
        assert!(pressure.is_public_amount() && pressure.uses_core_decision());
        assert_eq!(pressure.leaf_conversion_scale_f64(), Some(0.25));
        assert_eq!(pressure.leaf_conversion_max_height_u32(), Some(8));
        assert_eq!(
            pressure.decision_stage().legacy_selector_options().final_order_policy,
            FinalOrderPolicy::Cc2RankOrder
        );

        let mut missing_height = pressure.clone();
        missing_height.leaf_conversion_max_height = None;
        assert!(!missing_height.valid());
        for value in ["0", "41", "01", "8.0", " 8"] {
            let mut bad_height = pressure.clone();
            bad_height.leaf_conversion_max_height = Some(Some(value.into()));
            assert!(!bad_height.valid(), "reject pressure gate height {value:?}");
        }
        let mut wrong_config = pressure.clone();
        wrong_config.config_hash = CAS_CONFIG_HASH.into();
        assert!(!wrong_config.valid());
        let mut time_budget = pressure.clone();
        time_budget.budget.mode = TIME_BUDGET_MODE.into();
        time_budget.budget.max_millis = 1_000;
        assert!(!time_budget.valid(), "pressure-gated profile rejects time budget mode");

        let mut null_height = serde_json::to_value(&pressure).unwrap();
        null_height["leafConversionMaxHeight"] = Json::Null;
        assert!(!serde_json::from_value::<Profile>(null_height).unwrap().valid());
    }

    #[test]
    fn leaf_conversion_pressure_gated_scale_and_height_change_public_context_digest() {
        let selector = load_p5()["decisions"][0]["selector"].clone();
        let base = leaf_conversion_pressure_gated_profile(CONFIG_HASH);
        let mut changed_height = base.clone();
        changed_height.leaf_conversion_max_height = Some(Some("9".into()));
        let base_request = request_with_profile(selector.clone(), &base);
        let height_request = request_with_profile(selector, &changed_height);
        let base_digest = public_context_digest_for_request(&base_request, &base).unwrap();
        assert_ne!(
            base_digest,
            public_context_digest_for_request(&height_request, &changed_height).unwrap()
        );
        let state = composed_public_state(&base_request).unwrap();
        let document = public_context_document(&state, &base_request, &base);
        assert_eq!(document["profile"]["allocationMode"], "leaf-conversion-pressure-gated-v1");
        assert_eq!(document["profile"]["leafConversionScale"], "0.25");
        assert_eq!(document["profile"]["leafConversionMaxHeight"], "8");
    }

    #[test]
    fn gated_b2b_charge_profile_requires_canonical_nonnegative_scale_and_selection_budget() {
        let charge = leaf_conversion_gated_b2b_charge_profile(CONFIG_HASH);
        assert!(charge.valid());
        assert!(charge.is_public_amount() && charge.uses_core_decision());
        assert_eq!(charge.leaf_conversion_scale_f64(), Some(0.25));
        assert_eq!(charge.leaf_conversion_max_height_u32(), Some(8));
        assert_eq!(charge.b2b_charge_scale_f32(), Some(0.5));
        assert_eq!(
            charge.decision_stage().legacy_selector_options().final_order_policy,
            FinalOrderPolicy::Cc2RankOrder
        );

        let mut missing = charge.clone();
        missing.b2b_charge_scale = None;
        assert!(!missing.valid());
        for value in ["NaN", "Infinity", "-0.5", "+0.5", "01", "0.50", "1e-1", "0.0"] {
            let mut invalid = charge.clone();
            invalid.b2b_charge_scale = Some(Some(value.into()));
            assert!(!invalid.valid(), "reject B2B charge scale {value:?}");
        }
        let mut null_scale = serde_json::to_value(&charge).unwrap();
        null_scale["b2bChargeScale"] = Json::Null;
        let parsed: Profile = serde_json::from_value(null_scale).unwrap();
        assert_eq!(parsed.b2b_charge_scale, Some(None));
        assert!(!parsed.valid());

        let mut time_budget = charge.clone();
        time_budget.budget.mode = TIME_BUDGET_MODE.into();
        time_budget.budget.max_millis = 1_000;
        assert!(!time_budget.valid());

        let mut composed_a = profile();
        composed_a.profile_id = COMPOSED_A.into();
        let mut root_value = core_allspin_profile(CAS_CONFIG_HASH);
        root_value.profile_id = ROOT_VALUE_PROFILE.into();
        let mut other_profiles = vec![
            profile(),
            public_b_profile(),
            composed_a,
            composed_b_profile(),
            core_allspin_profile(CONFIG_HASH),
            root_value,
            root_value_mix_profile(CONFIG_HASH),
            root_value_tiebreak_profile(CONFIG_HASH),
            leaf_conversion_profile(CONFIG_HASH),
            leaf_conversion_gated_profile(CONFIG_HASH),
            leaf_conversion_pressure_gated_profile(CONFIG_HASH),
            root_profile(),
            rank_order_profile(CONFIG_HASH),
        ];
        for other in &mut other_profiles {
            other.b2b_charge_scale = Some(Some("0.5".into()));
            assert!(!other.valid(), "{} rejects b2bChargeScale", other.profile_id);
            let mut null_field = serde_json::to_value(other.clone()).unwrap();
            null_field["b2bChargeScale"] = Json::Null;
            let parsed: Profile = serde_json::from_value(null_field).unwrap();
            assert_eq!(parsed.b2b_charge_scale, Some(None));
            assert!(!parsed.valid(), "{} rejects explicit null", other.profile_id);
        }
    }

    #[test]
    fn gated_b2b_charge_config_applies_exact_overrides_and_leaves_gated_profile_unchanged() {
        let charge = leaf_conversion_gated_b2b_charge_profile(CONFIG_HASH);
        let configured = charge.search_bot_config().unwrap();
        assert!(configured.enable_s2_b2b_surge);
        assert_eq!(configured.freestyle_weights.s2_b2b_surge, 1.0);
        assert_eq!(configured.freestyle_weights.s2_b2b_charge, 0.5);
        assert_eq!(configured.freestyle_weights.s2_b2b_charge_cap_rows, 12);

        let mut r_only = charge.clone();
        r_only.b2b_charge_scale = Some(Some("0".into()));
        let r_only_config = r_only.search_bot_config().unwrap();
        assert!(r_only_config.enable_s2_b2b_surge);
        assert_eq!(r_only_config.freestyle_weights.s2_b2b_surge, 1.0);
        assert_eq!(r_only_config.freestyle_weights.s2_b2b_charge, 0.0);
        assert_eq!(r_only_config.freestyle_weights.s2_b2b_charge_cap_rows, 12);

        let gated = leaf_conversion_gated_profile(CONFIG_HASH);
        let gated_config = gated.search_bot_config().unwrap();
        let champion: BotConfig = serde_json::from_str(CONFIG).unwrap();
        assert_eq!(gated_config.enable_s2_b2b_surge, champion.enable_s2_b2b_surge);
        assert_eq!(
            gated_config.freestyle_weights.s2_b2b_surge,
            champion.freestyle_weights.s2_b2b_surge
        );
        assert_eq!(
            gated_config.freestyle_weights.s2_b2b_charge,
            champion.freestyle_weights.s2_b2b_charge
        );
        assert_eq!(
            gated_config.freestyle_weights.s2_b2b_charge_cap_rows,
            champion.freestyle_weights.s2_b2b_charge_cap_rows
        );
        assert!(!gated_config.enable_s2_b2b_surge);
    }

    #[test]
    fn gated_b2b_charge_scale_changes_public_context_digest() {
        let selector = load_p5()["decisions"][0]["selector"].clone();
        let base = leaf_conversion_gated_b2b_charge_profile(CONFIG_HASH);
        let mut changed = base.clone();
        changed.b2b_charge_scale = Some(Some("0.75".into()));
        let base_request = request_with_profile(selector.clone(), &base);
        let changed_request = request_with_profile(selector, &changed);
        let base_digest = public_context_digest_for_request(&base_request, &base).unwrap();
        assert_ne!(
            base_digest,
            public_context_digest_for_request(&changed_request, &changed).unwrap()
        );
        let state = composed_public_state(&base_request).unwrap();
        let document = public_context_document(&state, &base_request, &base);
        assert_eq!(document["profile"]["allocationMode"], "leaf-conversion-gated-b2b-charge-v1");
        assert_eq!(document["profile"]["b2bChargeScale"], "0.5");
    }

    #[test]
    fn root_value_tiebreak_public_context_binds_its_mode_without_a_scale() {
        let selector = load_p5()["decisions"][0]["selector"].clone();
        let tie = root_value_tiebreak_profile(CONFIG_HASH);
        let request = request_with_profile(selector, &tie);
        let digest = public_context_digest_for_request(&request, &tie).unwrap();
        let state = composed_public_state(&request).unwrap();
        let document = public_context_document(&state, &request, &tie);

        assert_eq!(document["profile"]["profileId"], ROOT_VALUE_TIEBREAK_PROFILE);
        assert_eq!(document["profile"]["allocationMode"], "root-value-tiebreak-v1");
        assert!(document["profile"].get("rootValueScale").is_none());
        let public = public_b_profile();
        let public_request = request_with_profile(
            load_p5()["decisions"][0]["selector"].clone(),
            &public);
        assert_ne!(
            digest,
            public_context_digest_for_request(&public_request, &public).unwrap(),
            "allocationMode/profile identity is included in the public context"
        );
    }

    #[test]
    fn context_serializer_golden_preserves_legacy_and_binds_root_mode() {
        let selector = load_p5()["decisions"][0]["selector"].clone();
        let legacy = profile();
        let legacy_request = request_with_profile(selector.clone(), &legacy);
        let legacy_digest = public_context_digest_for_request(&legacy_request, &legacy).unwrap();
        let champion = public_b_profile();
        let champion_request = request_with_profile(selector.clone(), &champion);
        let champion_state = composed_public_state(&champion_request).unwrap();
        let champion_document = public_context_document(&champion_state, &champion_request, &champion);
        assert!(champion_document["profile"].get("rootValueScale").is_none());
        let root = {
            let mut value = legacy.clone();
            value.profile_id = ROOT_OBJECTIVE_PROFILE.into();
            value.seed = "5994928009864282113".into();
            value.allocation_mode = Some("off".into());
            value
        };
        let root_request = request_with_profile(selector, &root);
        let root_digest = public_context_digest_for_request(&root_request, &root).unwrap();
        assert_ne!(legacy_digest, root_digest);
        assert_eq!(
            legacy_digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            "e47bfceca54907fdc70ba019721a018957fcb81132b434ca81061aa4e5f74246"
        );
        assert_eq!(
            root_digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            "1d54056f9bfd9800636fade93c091e8fd4c9186cd96956b1923b357325008d10"
        );
    }

    #[test]
    fn root_value_mix_scale_changes_public_context_digest() {
        let selector = load_p5()["decisions"][0]["selector"].clone();
        let mut scale_zero = root_value_mix_profile(CONFIG_HASH);
        scale_zero.root_value_scale = Some(Some("0".into()));
        let mut scale_three_tenths = scale_zero.clone();
        scale_three_tenths.root_value_scale = Some(Some("0.3".into()));
        let request_zero = request_with_profile(selector.clone(), &scale_zero);
        let request_three_tenths = request_with_profile(selector, &scale_three_tenths);

        assert!(scale_zero.valid() && scale_three_tenths.valid());
        assert_ne!(
            public_context_digest_for_request(&request_zero, &scale_zero).unwrap(),
            public_context_digest_for_request(&request_three_tenths, &scale_three_tenths).unwrap(),
        );
        let state = composed_public_state(&request_three_tenths).unwrap();
        let document = public_context_document(&state, &request_three_tenths, &scale_three_tenths);
        assert_eq!(document["profile"]["rootValueScale"], "0.3");
    }

    #[test]
    fn champion_profile_rejects_present_null_conversion_scale_fields() {
        let champion = public_b_profile();
        assert!(champion.valid());

        for field in ["leafConversionScale", "leafConversionMaxHeight", "rootValueScale"] {
            let mut document = serde_json::to_value(&champion).unwrap();
            document[field] = Json::Null;
            let parsed: Profile = serde_json::from_value(document).unwrap();
            assert!(
                if field == "leafConversionScale" {
                    parsed.leaf_conversion_scale == Some(None)
                } else if field == "leafConversionMaxHeight" {
                    parsed.leaf_conversion_max_height == Some(None)
                } else {
                    parsed.root_value_scale == Some(None)
                },
                "{field} must retain present-null"
            );
            assert!(!parsed.valid(), "champion profile rejects {field}: null");
        }
    }

    #[test]
    fn leaf_conversion_scale_changes_public_context_digest() {
        let selector = load_p5()["decisions"][0]["selector"].clone();
        let mut scale_zero = leaf_conversion_profile(CONFIG_HASH);
        scale_zero.leaf_conversion_scale = Some(Some("0".into()));
        let mut scale_three_tenths = scale_zero.clone();
        scale_three_tenths.leaf_conversion_scale = Some(Some("0.3".into()));
        let request_zero = request_with_profile(selector.clone(), &scale_zero);
        let request_three_tenths = request_with_profile(selector, &scale_three_tenths);

        assert!(scale_zero.valid() && scale_three_tenths.valid());
        assert_ne!(
            public_context_digest_for_request(&request_zero, &scale_zero).unwrap(),
            public_context_digest_for_request(&request_three_tenths, &scale_three_tenths).unwrap(),
        );
        let state = composed_public_state(&request_three_tenths).unwrap();
        let document = public_context_document(&state, &request_three_tenths, &scale_three_tenths);
        assert_eq!(document["profile"]["leafConversionScale"], "0.3");
        let champion = public_b_profile();
        let champion_request =
            request_with_profile(load_p5()["decisions"][0]["selector"].clone(), &champion);
        let champion_state = composed_public_state(&champion_request).unwrap();
        assert!(
            public_context_document(&champion_state, &champion_request, &champion)["profile"]
                .get("leafConversionScale")
                .is_none()
        );
    }

    #[test]
    fn rejects_root_amounts_and_fail_open_selector_inputs() {
        let p = profile();
        let stats = SearchStats {
            nodes: 0,
            selections: 0,
        };
        let with_amounts = json!({"type":"f14_decide","rootAmounts":{}});
        assert_eq!(
            decide(with_amounts, &p, &[], stats)["reason"],
            "invalid-input"
        );

        let mut numeric = load_p5()["decisions"][0]["selector"].clone();
        numeric["incoming"]["pendingRows"] = json!(5);
        numeric["incoming"]["dueThisLockRows"] = json!(5);
        assert_eq!(
            decide(request_with_selector(numeric), &p, &[dummy_move()], stats)["reason"],
            "unsupported-incoming-profile"
        );

        let mut as_string = load_p5()["decisions"][0]["selector"].clone();
        as_string["incoming"]["pendingRows"] = json!("5");
        as_string["incoming"]["dueThisLockRows"] = json!("5");
        assert_eq!(
            decide(request_with_selector(as_string), &p, &[dummy_move()], stats)["reason"],
            "invalid-input"
        );

        let mut typo = load_p5()["decisions"][0]["selector"].clone();
        let due = typo["incoming"]["dueThisLockRows"].clone();
        typo["incoming"]
            .as_object_mut()
            .unwrap()
            .remove("pendingRows");
        typo["incoming"]["pendingRow"] = json!(5);
        typo["incoming"]["dueThisLockRows"] = due;
        assert_eq!(
            decide(request_with_selector(typo), &p, &[dummy_move()], stats)["reason"],
            "invalid-input"
        );

        let mut omitted = load_p5()["decisions"][0]["selector"].clone();
        omitted.as_object_mut().unwrap().remove("incoming");
        assert_eq!(
            decide(request_with_selector(omitted), &p, &[dummy_move()], stats)["reason"],
            "invalid-input"
        );

        let mut hold = load_p5()["decisions"][0]["selector"].clone();
        hold["pieces"]["holdAvailable"] = json!("false");
        assert_eq!(
            decide(request_with_selector(hold), &p, &[dummy_move()], stats)["reason"],
            "invalid-input"
        );
    }

    #[test]
    fn decide_success_path_matches_js_selected_identity() {
        let p5 = load_p5();
        let decision = &p5["decisions"][0];
        let moves: Vec<Placement> = serde_json::from_value(decision["moves"].clone()).unwrap();
        let response = decide_limited_with_legacy_selector(
            request_with_selector(decision["selector"].clone()),
            &profile(),
            &moves,
            SearchStats {
                nodes: 0,
                selections: 512,
            },
            None,
            None,
            0,
        );
        assert_eq!(response["status"], "move");
        assert_eq!(response["reason"], "selection-budget");
        assert_eq!(
            response["selectedIdentity"].as_str().unwrap(),
            decision["selectedIdentity"].as_str().unwrap()
        );
        assert_eq!(
            response["ranking"]["selectedCc2Rank"],
            decision["selectedCc2Rank"]
        );
        assert_eq!(
            response["ranking"]["rescueApplied"],
            decision["rescueApplied"]
        );
        let identities = response["ranking"]["identities"].as_array().unwrap();
        assert!(identities
            .iter()
            .any(|value| value == &response["selectedIdentity"]));
        assert_eq!(response["search"]["actualSelections"], 512);
        assert_eq!(response["execution"], json!(profile()));
        let placement = &response["selectedPlacement"];
        assert_eq!(
            placement["piece"],
            decision["selectedMove"]["location"]["type"]
        );
        assert!(placement["rotation"].as_str().is_some());
        assert!(placement["rotationEvidence"].is_object());
        assert!(placement["rotationEvidence"]["lastInputWasRotation"].is_boolean());
    }

    #[test]
    fn empty_or_unverifiable_candidates_are_errors_not_root_no_move() {
        let p = profile();
        let stats = SearchStats {
            nodes: 0,
            selections: 512,
        };
        let empty = decide(
            request_with_selector(load_p5()["decisions"][0]["selector"].clone()),
            &p,
            &[],
            stats,
        );
        assert_eq!(empty["status"], "error");
        assert_eq!(empty["reason"], "empty-candidates");
        assert!(empty["selectedMove"].is_null());
        assert_ne!(empty["status"], "root-no-move");
    }

    #[test]
    fn mismatched_start_and_selector_are_rejected_before_selection() {
        let p = profile();
        let stats = SearchStats {
            nodes: 0,
            selections: 512,
        };
        let mut request = request_with_selector(load_p5()["decisions"][0]["selector"].clone());
        request["start"]["b2b"] = json!(0);
        request["selector"]["chain"]["b2b"] = json!(10);
        let response = decide(request, &p, &[dummy_move()], stats);
        assert_eq!(response["status"], "error");
        assert_eq!(response["reason"], "start-selector-mismatch");
        assert!(response["selectedMove"].is_null());
    }

    #[test]
    fn foreign_ruleset_is_unsupported_before_selection() {
        let p = profile();
        let stats = SearchStats {
            nodes: 0,
            selections: 512,
        };
        let mut selector = load_p5()["decisions"][0]["selector"].clone();
        selector["rulesetId"] = json!("tetrio-s2-v19-other-beta-1-5-0");
        let response = decide(request_with_selector(selector), &p, &[dummy_move()], stats);
        assert_eq!(response["status"], "unsupported");
        assert_eq!(response["reason"], "unsupported-ruleset");
    }

    #[test]
    fn past_deadline_does_not_return_a_move() {
        let p = profile();
        let stats = SearchStats {
            nodes: 0,
            selections: 512,
        };
        let response = decide_limited(
            request_with_selector(load_p5()["decisions"][0]["selector"].clone()),
            &p,
            &[dummy_move()],
            stats,
            Some(&F14RuntimeLimits {
                deadline: Instant::now() - std::time::Duration::from_secs(1),
                cancel: Arc::new(AtomicBool::new(false)),
            }),
            None,
            0,
        );
        assert_eq!(response["status"], "incomplete");
        assert_eq!(response["reason"], "deadline");
        assert!(response["selectedMove"].is_null());
    }

    #[test]
    fn cancelled_generation_cannot_start_after_invalidate() {
        let gate = Mutex::new(F14StartGate::new());
        let cancel = AtomicBool::new(false);
        gate.lock().unwrap().begin(1);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker_gate = Arc::new(gate);
        let cancel = Arc::new(cancel);
        let worker_cancel = cancel.clone();
        let worker = std::thread::spawn({
            let worker_gate = worker_gate.clone();
            move || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                let guard = worker_gate.lock().unwrap();
                guard.allow_start(1, &worker_cancel)
            }
        });
        entered_rx.recv().unwrap();
        {
            let mut guard = worker_gate.lock().unwrap();
            guard.invalidate();
            cancel.store(true, Ordering::Release);
        }
        release_tx.send(()).unwrap();
        assert!(!worker.join().unwrap());
    }

    #[test]
    fn selector_cancel_after_enter_does_not_return_a_move() {
        let p5 = load_p5();
        let moves: Vec<Placement> =
            serde_json::from_value(p5["decisions"][0]["moves"].clone()).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let (park, hold) = F14Park::pair();
        let hook = F14CancelHook {
            after_flag_check: None,
            before_start: None,
            after_selector_enter: Some(park),
            after_budget_wait: None,
        };
        let request = request_with_selector(p5["decisions"][0]["selector"].clone());
        let profile = profile();
        let worker_cancel = cancel.clone();
        let worker = std::thread::spawn(move || {
            decide_limited(
                request,
                &profile,
                &moves,
                SearchStats {
                    nodes: 0,
                    selections: 512,
                },
                Some(&F14RuntimeLimits {
                    deadline: Instant::now() + std::time::Duration::from_secs(30),
                    cancel: worker_cancel,
                }),
                Some(&hook),
                0,
            )
        });
        hold.wait_entered(Duration::from_secs(2));
        cancel.store(true, Ordering::Release);
        hold.release();
        let response = worker.join().unwrap();
        assert_eq!(response["status"], "incomplete");
        assert_eq!(response["reason"], "cancelled");
        assert!(response["selectedMove"].is_null());
    }

    fn composed_b_profile() -> Profile {
        let mut extra = profile();
        extra.profile_id = COMPOSED_B.into();
        extra.seed = "5994928009864282113".into();
        extra
    }

    fn public_b_profile() -> Profile {
        let mut extra = profile();
        extra.profile_id = PUBLIC_PROFILE.into();
        extra.seed = "5994928009864282113".into();
        extra
    }

    fn root_profile() -> Profile {
        let mut root = profile();
        root.profile_id = ROOT_OBJECTIVE_PROFILE.into();
        root.seed = "5994928009864282113".into();
        root.budget.selections = 512;
        root.allocation_mode = Some("off".into());
        root
    }

    fn request_with_profile(selector: Json, profile: &Profile) -> Json {
        json!({
            "type": "f14_decide",
            "schemaVersion": 1,
            "requestId": "f14-test",
            "positionId": "f14-test-position",
            "generation": 1,
            "execution": profile,
            "start": opening_start(),
            "selector": selector,
        })
    }

    fn rescue_fixture_request(profile: &Profile) -> (Json, Vec<Placement>) {
        let fixture: Json = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-rescue.json"
        ))
        .unwrap();
        let selector = fixture["selector"].clone();
        let mut request = request_with_profile(selector.clone(), profile);
        let known = selector["pieces"]["known"].as_array().unwrap();
        let mut queue = vec![selector["pieces"]["current"].clone()];
        queue.extend(known.iter().take(QUEUE_LIMIT - 1).cloned());
        request["start"] = json!({
            "board": tbp_board_from_cells(selector["board"]["cells"].as_str().unwrap()),
            "queue": queue,
            "hold": selector["pieces"]["hold"].clone(),
            "combo": selector["chain"]["combo"].clone(),
            "back_to_back": selector["chain"]["b2b"].as_u64().unwrap() != 0,
            "b2b": selector["chain"]["b2b"].clone(),
            "randomizer": {"type": "seven_bag", "bag_state": []},
        });
        let moves = serde_json::from_value(fixture["moves"].clone()).unwrap();
        (request, moves)
    }

    fn composed_core_decision(
        profile: &Profile,
        epoch: u64,
    ) -> (Json, Vec<Placement>, F14RuntimeLimits, FinishedRootDecision) {
        let (request, moves) = rescue_fixture_request(profile);
        let state = public_state_from_json(&request["selector"]).unwrap();
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let session = RootObjectiveSession::new_with_allocation_mode(
            PublicRootLockContext::for_profile(&state, &limits, profile.is_public_amount())
                .unwrap(),
            profile.decision_stage(),
            profile.budget.selections,
            epoch,
            public_context_digest_for_request(&request, profile).unwrap(),
            crate::f14_compat::select::AllocationMode::Off,
        );
        session
            .complete_work(
                &crate::bot::Statistics {
                    nodes: 42,
                    selections: profile.budget.selections,
                    ..Default::default()
                },
                || {
                    moves
                        .iter()
                        .copied()
                        .map(|placement| (placement, 1.0))
                        .collect()
                },
            )
            .unwrap();
        let decision = match session.take_outcome().unwrap().unwrap() {
            FinishedRootOutcome::Decided(decision) => decision,
            other => panic!("unexpected composed outcome: {other:?}"),
        };
        (request, moves, limits, decision)
    }

    fn normal_core_decision(
        profile: &Profile,
        epoch: u64,
    ) -> (Json, Vec<Placement>, F14RuntimeLimits, FinishedRootDecision) {
        let p5 = load_p5();
        let request = request_with_profile(p5["decisions"][0]["selector"].clone(), profile);
        let moves: Vec<Placement> =
            serde_json::from_value(p5["decisions"][0]["moves"].clone()).unwrap();
        let state = public_state_from_json(&request["selector"]).unwrap();
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let session = RootObjectiveSession::new_with_allocation_mode(
            PublicRootLockContext::for_profile(&state, &limits, profile.is_public_amount())
                .unwrap(),
            profile.decision_stage(),
            profile.budget.selections,
            epoch,
            public_context_digest_for_request(&request, profile).unwrap(),
            crate::f14_compat::select::AllocationMode::Off,
        );
        session
            .complete_work(
                &crate::bot::Statistics {
                    nodes: 42,
                    selections: profile.budget.selections,
                    ..Default::default()
                },
                || {
                    moves
                        .iter()
                        .copied()
                        .map(|placement| (placement, 1.0))
                        .collect()
                },
            )
            .unwrap();
        let decision = match session.take_outcome().unwrap().unwrap() {
            FinishedRootOutcome::Decided(decision) => decision,
            other => panic!("unexpected normal outcome: {other:?}"),
        };
        (request, moves, limits, decision)
    }

    fn sorted_response_bytes(response: &Json) -> Vec<u8> {
        super::super::select::sorted_compact_json(response)
    }

    fn placements_from_identity_list(values: &Json) -> Vec<Placement> {
        values
            .as_array()
            .unwrap()
            .iter()
            .map(|value| serde_json::from_str(value.as_str().unwrap()).unwrap())
            .collect()
    }

    #[test]
    fn composed_route_rejects_missing_stale_and_mismatched_core_decisions() {
        let profile = composed_b_profile();
        let (request, moves, limits, decision) = composed_core_decision(&profile, 1);
        let stats = SearchStats {
            nodes: 42,
            selections: profile.budget.selections,
        };
        let missing = decide_limited_with_core(
            request.clone(),
            &profile,
            &moves,
            stats,
            None,
            None,
            1,
            None,
        );
        assert_eq!(missing["reason"], "missing-core-ranking");
        let stale = decide_limited_with_core(
            request.clone(),
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            2,
            Some(decision.clone()),
        );
        assert_eq!(stale["reason"], "stale-ranking-epoch");
        let ok = decide_limited_with_core(
            request.clone(),
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            1,
            Some(decision.clone()),
        );
        assert_eq!(ok["status"], "move");
        assert_eq!(ok["diagnostics"]["postStageConversionComputeCalls"], 0);
        assert_eq!(ok["diagnostics"]["postStageConversionAddCalls"], 0);
        assert_eq!(ok["diagnostics"]["postStageRerankCalls"], 0);

        let mut context_mismatch = decision.clone();
        context_mismatch.binding.public_context_digest[0] ^= 1;
        let mismatch = decide_limited_with_core(
            request.clone(),
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            1,
            Some(context_mismatch),
        );
        assert_eq!(mismatch["reason"], "ranking-binding-mismatch");

        let mut identity_mismatch = decision.clone();
        identity_mismatch.binding.returned_identity_digest[0] ^= 1;
        let mismatch = decide_limited_with_core(
            request.clone(),
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            1,
            Some(identity_mismatch),
        );
        assert_eq!(mismatch["reason"], "ranking-binding-mismatch");

        let mut count_mismatch = decision.clone();
        count_mismatch.binding.returned_count += 1;
        let mismatch = decide_limited_with_core(
            request.clone(),
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            1,
            Some(count_mismatch),
        );
        assert_eq!(mismatch["reason"], "ranking-binding-mismatch");

        if moves.len() >= 2 {
            let mut permuted = moves.clone();
            permuted.swap(0, 1);
            let mismatch = decide_limited_with_core(
                request,
                &profile,
                &permuted,
                stats,
                Some(&limits),
                None,
                1,
                Some(decision),
            );
            assert_eq!(mismatch["reason"], "ranking-binding-mismatch");
        }
    }

    #[test]
    fn composed_a_core_decision_is_byte_identical_to_legacy_route_on_zero_incoming_fixture() {
        let mut profile = profile();
        profile.profile_id = COMPOSED_A.into();
        let p5 = load_p5();
        let request = request_with_profile(p5["decisions"][0]["selector"].clone(), &profile);
        let moves: Vec<Placement> =
            serde_json::from_value(p5["decisions"][0]["moves"].clone()).unwrap();
        let state = public_state_from_json(&request["selector"]).unwrap();
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let session = RootObjectiveSession::new_with_allocation_mode(
            PublicRootLockContext::for_profile(&state, &limits, false).unwrap(),
            profile.decision_stage(),
            profile.budget.selections,
            7,
            public_context_digest_for_request(&request, &profile).unwrap(),
            crate::f14_compat::select::AllocationMode::Off,
        );
        assert!(session
            .complete_work(
                &crate::bot::Statistics {
                    nodes: 42,
                    selections: profile.budget.selections,
                    ..Default::default()
                },
                || moves
                    .iter()
                    .copied()
                    .map(|placement| (placement, 1.0))
                    .collect(),
            )
            .is_ok());
        let decision = match session.take_outcome().unwrap().unwrap() {
            FinishedRootOutcome::Decided(decision) => decision,
            other => panic!("unexpected composed A outcome: {other:?}"),
        };
        let stats = SearchStats {
            nodes: decision.nodes,
            selections: decision.completed_selections,
        };
        let legacy_snapshot = snapshot_composed_ranking(
            &PublicRootLockContext::for_profile(&state, &limits, false).unwrap(),
            &profile,
            &moves,
            7,
            &request,
        )
        .unwrap();
        let legacy = decide_limited_with_snapshot(
            request.clone(),
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            Some(legacy_snapshot),
            7,
        );
        let current = decide_limited_with_core(
            request,
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            7,
            Some(decision),
        );
        assert_eq!(
            serde_json::to_vec(&current).unwrap(),
            serde_json::to_vec(&legacy).unwrap(),
            "composed A wire changed"
        );
    }

    #[test]
    fn composed_b_core_decision_is_byte_identical_to_legacy_rescue_route() {
        let profile = composed_b_profile();
        let (request, moves, limits, decision) = composed_core_decision(&profile, 7);
        assert_eq!(decision.selection.selected.cc2_rank, 1);
        assert!(decision.selection.rescued);
        let stats = SearchStats {
            nodes: decision.nodes,
            selections: decision.completed_selections,
        };
        let state = public_state_from_json(&request["selector"]).unwrap();
        let legacy_snapshot = snapshot_composed_ranking(
            &PublicRootLockContext::for_profile(&state, &limits, true).unwrap(),
            &profile,
            &moves,
            7,
            &request,
        )
        .unwrap();
        let legacy = decide_limited_with_snapshot(
            request.clone(),
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            Some(legacy_snapshot),
            7,
        );
        let current = decide_limited_with_core(
            request,
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            7,
            Some(decision),
        );
        assert_eq!(
            serde_json::to_vec(&current).unwrap(),
            serde_json::to_vec(&legacy).unwrap(),
            "composed B wire changed"
        );
        let diagnostics = current["diagnostics"].as_object().unwrap();
        assert_eq!(diagnostics.len(), 3);
        assert!(!diagnostics.contains_key("coreRankingComposeCalls"));
        assert_eq!(current["boundaryAudit"]["legacyF14SelectionCalls"], 0);
        assert_eq!(current["boundaryAudit"]["legacyF14RescueCalls"], 0);
    }

    fn timed_public_profile(selections: u64) -> Profile {
        let mut timed = public_b_profile();
        timed.budget.mode = TIME_BUDGET_MODE.into();
        timed.budget.max_millis = 250;
        timed.budget.selections = selections;
        timed
    }

    fn timed_gated_leaf_conversion_profile(selections: u64) -> Profile {
        let mut timed = leaf_conversion_gated_profile(CONFIG_HASH);
        timed.budget.mode = TIME_BUDGET_MODE.into();
        timed.budget.max_millis = 250;
        timed.budget.selections = selections;
        timed
    }

    #[test]
    fn time_budget_is_public_or_gated_host_clocked_and_capped() {
        let timed = timed_public_profile(512);
        assert!(timed.valid());
        let gated = timed_gated_leaf_conversion_profile(512);
        assert!(gated.valid());
        let mut long = timed.clone();
        long.budget.max_millis = 30_000;
        assert!(!long.valid());
        let mut long_gated = gated.clone();
        long_gated.budget.max_millis = 30_000;
        assert!(!long_gated.valid());
        let mut profile_a = timed.clone();
        profile_a.profile_id = A_PROFILE.into();
        profile_a.seed = "1395802947".into();
        assert!(!profile_a.valid());
        let mut other_profile = core_allspin_profile(CONFIG_HASH);
        assert!(other_profile.valid());
        other_profile.budget.mode = TIME_BUDGET_MODE.into();
        other_profile.budget.max_millis = 250;
        assert!(!other_profile.valid());
        assert!(timed.budget_met(1) && timed.budget_met(512));
        assert!(!timed.budget_met(0) && !timed.budget_met(513));
        assert!(public_b_profile().budget_met(public_b_profile().budget.selections));
        assert!(!public_b_profile().budget_met(1));
        // The native job has no host clock to stop it early.
        let (request, _) = rescue_fixture_request(&timed);
        let config: crate::bot::BotConfig = serde_json::from_str(timed.config_bytes()).unwrap();
        let rejected = match crate::f14_compat::inproc::prepare_after_admit_with_cancel(
            request,
            &timed,
            Arc::new(config),
            1,
            None,
            Arc::new(AtomicBool::new(false)),
        ) {
            Ok(_) => panic!("native job admitted a time budget"),
            Err(response) => response,
        };
        assert_eq!(rejected["status"], "unsupported");
    }

    fn long_queue_request(profile: &Profile, length: usize) -> Json {
        let (mut request, _) = rescue_fixture_request(profile);
        let bag = ["T", "I", "O", "L", "J", "S", "Z"];
        let known: Vec<Json> = (0..30).map(|index| json!(bag[index % 7])).collect();
        request["selector"]["pieces"]["known"] = json!(known);
        let mut queue = vec![request["selector"]["pieces"]["current"].clone()];
        queue.extend(known.iter().take(length - 1).cloned());
        request["start"]["queue"] = json!(queue);
        request
    }

    #[test]
    fn public_profile_admits_a_queue_up_to_28_as_a_prefix_of_known() {
        let public = public_b_profile();
        for length in [14, 15, 28] {
            assert!(admit(&long_queue_request(&public, length), &public).is_ok(), "{length}");
        }
        assert!(admit(&long_queue_request(&public, 29), &public).is_err());
        // Shorter than the 14-piece truncation while more is known stays a mismatch.
        assert!(admit(&long_queue_request(&public, 10), &public).is_err());
        let mut reordered = long_queue_request(&public, 20);
        reordered["start"]["queue"][19] = json!("T");
        reordered["selector"]["pieces"]["known"][18] = json!("Z");
        assert!(admit(&reordered, &public).is_err());
        let gated = leaf_conversion_gated_profile(CONFIG_HASH);
        assert!(admit(&long_queue_request(&gated, 28), &gated).is_ok());
        assert!(admit(&long_queue_request(&gated, 29), &gated).is_err());
        // Other profiles keep the 14-piece contract.
        let composed = composed_b_profile();
        assert!(admit(&long_queue_request(&composed, 14), &composed).is_ok());
        assert!(admit(&long_queue_request(&composed, 20), &composed).is_err());

        let mut driver = F14Driver::start(public.clone(), long_queue_request(&public, 28)).expect("long queue start");
        while !driver.work(8).complete {}
        let response = driver.finish();
        assert_eq!(response["status"], "move", "{response}");
        assert_eq!(response["search"]["queueLength"], 28);
        let mut driver = F14Driver::start(public.clone(), long_queue_request(&public, 14)).expect("default queue start");
        while !driver.work(8).complete {}
        assert!(driver.finish()["search"].get("queueLength").is_none());
    }

    #[test]
    fn time_budget_early_finish_equals_a_selection_budget_of_the_same_count() {
        let timed = timed_public_profile(512);
        let (request, _) = rescue_fixture_request(&timed);
        let mut driver = F14Driver::start(timed.clone(), request).expect("timed driver start");
        driver.work(16);
        let early = driver.finish_early();
        assert_eq!(early["status"], "move", "{early}");
        assert_eq!(early["reason"], "time-budget");
        assert_eq!(early["search"]["termination"], "time-budget");
        let actual = early["search"]["actualSelections"].as_u64().unwrap();
        assert!((1..512).contains(&actual), "{actual}");

        // Stopping the host clock after `actual` selections decides exactly
        // what a selection budget of `actual` decides.
        let mut counted = public_b_profile();
        counted.budget.selections = actual;
        let (request, _) = rescue_fixture_request(&counted);
        let mut driver = F14Driver::start(counted, request).expect("counted driver start");
        while !driver.work(8).complete {}
        let fixed = driver.finish();
        assert_eq!(fixed["status"], "move", "{fixed}");
        assert_eq!(early["selectedIdentity"], fixed["selectedIdentity"]);
        assert_eq!(early["ranking"], fixed["ranking"]);

        // A search that reaches its cap first finishes like a selection budget.
        let capped = timed_public_profile(8);
        let (request, _) = rescue_fixture_request(&capped);
        let mut driver = F14Driver::start(capped, request).expect("capped driver start");
        while !driver.work(8).complete {}
        let complete = driver.finish_early();
        assert_eq!(complete["status"], "move", "{complete}");
        assert_eq!(complete["search"]["actualSelections"], 8);
    }

    #[test]
    fn public_b_core_decision_is_byte_identical_to_legacy_rescue_route() {
        let profile = public_b_profile();
        let (request, moves, limits, decision) = composed_core_decision(&profile, 7);
        assert!(decision.selection.rescued);
        assert_eq!(decision.selection.selected.cc2_rank, 1);
        assert!(decision.post_stage_counters.conversion_compute_calls > 0);
        assert!(decision.post_stage_counters.conversion_add_calls > 0);
        assert_eq!(decision.post_stage_counters.rerank_calls, 1);
        let stats = SearchStats {
            nodes: decision.nodes,
            selections: decision.completed_selections,
        };
        let legacy = decide_limited_with_legacy_selector(
            request.clone(),
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            7,
        );
        let current = crate::s2_audit::with_legacy_selector_guard(true, || {
            decide_limited_with_core(
                request,
                &profile,
                &moves,
                stats,
                Some(&limits),
                None,
                7,
                Some(decision),
            )
        });
        assert_eq!(
            sorted_response_bytes(&current),
            sorted_response_bytes(&legacy)
        );
        assert_eq!(current["status"], "move");
        assert_eq!(current["ranking"]["rescueApplied"], true);
        assert_eq!(current["ranking"]["selectedCc2Rank"], 1);
        let diagnostics = current["diagnostics"].as_object().unwrap();
        assert_eq!(diagnostics.len(), 3);
        assert!(
            diagnostics["postStageConversionComputeCalls"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert!(diagnostics["postStageConversionAddCalls"].as_u64().unwrap() > 0);
        assert_eq!(diagnostics["postStageRerankCalls"], 1);
        assert_eq!(current["diagnostics"], legacy["diagnostics"]);
        assert_eq!(
            current["boundaryAudit"],
            json!(crate::s2_audit::Audit::default())
        );
    }

    #[test]
    fn amount_only_a_core_decision_is_byte_identical_to_legacy_route() {
        let profile = profile();
        let (request, moves, limits, decision) = normal_core_decision(&profile, 7);
        let stats = SearchStats {
            nodes: decision.nodes,
            selections: decision.completed_selections,
        };
        let legacy = decide_limited_with_legacy_selector(
            request.clone(),
            &profile,
            &moves,
            stats,
            Some(&limits),
            None,
            7,
        );
        let current = crate::s2_audit::with_legacy_selector_guard(true, || {
            decide_limited_with_core(
                request,
                &profile,
                &moves,
                stats,
                Some(&limits),
                None,
                7,
                Some(decision),
            )
        });
        assert_eq!(current["status"], "move");
        assert_eq!(current["diagnostics"], json!({}));
        assert_eq!(
            sorted_response_bytes(&current),
            sorted_response_bytes(&legacy)
        );
        assert_eq!(
            current["boundaryAudit"],
            json!(crate::s2_audit::Audit::default())
        );
    }

    #[test]
    fn amount_only_a_production_job_is_byte_identical_to_legacy_route() {
        let profile = profile();
        let p5 = load_p5();
        let request = request_with_profile(p5["decisions"][0]["selector"].clone(), &profile);
        let response = run_production_job(&profile, request.clone());
        assert_eq!(response["status"], "move");
        assert_eq!(response["diagnostics"], json!({}));
        assert_eq!(
            response["boundaryAudit"],
            json!(crate::s2_audit::Audit::default())
        );
        let moves = placements_from_identity_list(&response["ranking"]["identities"]);
        let legacy = decide_limited_with_legacy_selector(
            request,
            &profile,
            &moves,
            SearchStats {
                nodes: response["search"]["nodes"].as_u64().unwrap(),
                selections: response["search"]["actualSelections"].as_u64().unwrap(),
            },
            None,
            None,
            1,
        );
        assert_eq!(
            sorted_response_bytes(&response),
            sorted_response_bytes(&legacy)
        );
    }

    #[test]
    fn public_b_production_job_rescue_is_byte_identical_to_legacy_route() {
        let request: Json = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-search-rescue-request.json"
        ))
        .expect("public B search rescue fixture");
        let profile: Profile = serde_json::from_value(request["execution"].clone())
            .expect("public B profile from fixture");
        let response = run_production_job(&profile, request.clone());

        assert_eq!(response["status"], "move");
        assert_eq!(response["ranking"]["rescueApplied"], true);
        assert_eq!(response["ranking"]["selectedCc2Rank"], 3);
        assert_eq!(
            response["diagnostics"],
            json!({
                "postStageConversionAddCalls": 16,
                "postStageConversionComputeCalls": 16,
                "postStageRerankCalls": 1,
            })
        );
        assert_eq!(
            response["boundaryAudit"],
            json!(crate::s2_audit::Audit::default())
        );

        let moves = placements_from_identity_list(&response["ranking"]["returnedIdentities"]);
        let legacy = decide_limited_with_legacy_selector(
            request,
            &profile,
            &moves,
            SearchStats {
                nodes: response["search"]["nodes"].as_u64().unwrap(),
                selections: response["search"]["actualSelections"].as_u64().unwrap(),
            },
            None,
            None,
            1,
        );
        assert_eq!(
            sorted_response_bytes(&response),
            sorted_response_bytes(&legacy)
        );
    }

    #[test]
    fn public_b_rerank_matches_fresh_search_for_time_and_incoming_variants() {
        let source: Json = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-search-rescue-request.json"
        ))
        .expect("public B search rescue fixture");
        let profile: Profile = serde_json::from_value(source["execution"].clone()).unwrap();
        let cases = [
            ("time-at-margin", 10_799, 10_800, (0, 0), (0, 0)),
            ("time-above-margin", 10_799, 10_801, (0, 0), (0, 0)),
            ("time-accumulator", 10_799, 12_300, (0, 0), (0, 0)),
            ("large-time", 10_799, 36_000, (0, 0), (0, 0)),
            ("incoming-only", 10_799, 10_799, (0, 0), (19, 0)),
            ("incoming-reverse", 10_799, 10_799, (19, 0), (0, 0)),
            ("due-incoming-only", 10_799, 10_799, (4, 0), (4, 4)),
            ("time-and-incoming", 10_799, 36_000, (0, 0), (19, 0)),
        ];
        let mut rescue_flipped = false;
        let mut result_changed_from_a = false;
        for (name, frame_a, frame_b, incoming_a, incoming_b) in cases {
            let mut original = source.clone();
            original["requestId"] = json!(format!("rerank-a-{name}"));
            original["positionId"] = json!(format!("rerank-position-a-{name}"));
            original["generation"] = json!(2);
            original["selector"]["time"]["logicalFrame"] = json!(frame_a);
            original["selector"]["incoming"] = json!({
                "pendingRows": incoming_a.0,
                "dueThisLockRows": incoming_a.1,
            });
            let (baseline, retained) = run_f14_driver_with_retained(&profile, original.clone());
            assert_eq!(
                baseline["status"], "move",
                "baseline case {name}: {baseline}"
            );
            let retained = retained.expect("public Profile B decision retained its root result");

            let mut target = original.clone();
            target["requestId"] = json!(format!("rerank-b-{name}"));
            target["positionId"] = json!(format!("rerank-position-b-{name}"));
            target["generation"] = json!(3);
            target["selector"]["time"]["logicalFrame"] = json!(frame_b);
            target["selector"]["incoming"] = json!({
                "pendingRows": incoming_b.0,
                "dueThisLockRows": incoming_b.1,
            });
            let reranked = rerank_retained(
                target.clone(),
                &retained.request,
                &retained.profile,
                &retained.outcome,
                false,
            );
            let fresh = run_f14_driver(&profile, target.clone());
            let mut actual = reranked.clone();
            let mut expected = fresh.clone();
            without_timing_fields(&mut actual);
            without_timing_fields(&mut expected);
            assert_eq!(actual, expected, "rerank case {name}");
            if baseline["ranking"]["rescueApplied"] != reranked["ranking"]["rescueApplied"] {
                rescue_flipped = true;
            }
            if baseline["selectedIdentity"] != reranked["selectedIdentity"] {
                result_changed_from_a = true;
            }
        }
        assert!(
            rescue_flipped,
            "the saved rescue request must cover an incoming-sensitive rescue flip"
        );
        assert!(
            result_changed_from_a,
            "at least one time/incoming rerank must differ from request A's selected identity"
        );
    }

    #[test]
    fn gated_leaf_conversion_rerank_matches_fresh_for_normal_and_rescue_positions() {
        let mut original: Json = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-search-rescue-request.json"
        ))
        .expect("saved F14 search rescue fixture");
        let profile = leaf_conversion_gated_profile(CONFIG_HASH);
        original["execution"] = json!(profile);
        original["requestId"] = json!("gated-rerank-source");
        original["positionId"] = json!("gated-rerank-source-position");
        original["generation"] = json!(2);
        original["selector"]["incoming"] = json!({ "pendingRows": 0, "dueThisLockRows": 0 });
        let (baseline, retained) = run_f14_driver_with_retained(&profile, original.clone());
        assert_eq!(baseline["status"], "move", "{baseline}");
        let retained = retained.expect("gated search retained its root result");

        for (name, pending_rows, rescue_applied) in [("normal", 0, false), ("rescue", 19, true)] {
            let mut target = original.clone();
            target["requestId"] = json!(format!("gated-rerank-{name}"));
            target["positionId"] = json!(format!("gated-rerank-{name}-position"));
            target["generation"] = json!(3);
            target["selector"]["incoming"] =
                json!({ "pendingRows": pending_rows, "dueThisLockRows": 0 });
            let reranked = rerank_retained(
                target.clone(),
                &retained.request,
                &retained.profile,
                &retained.outcome,
                false,
            );
            let fresh = run_f14_driver(&profile, target);
            assert_eq!(
                reranked["ranking"]["rescueApplied"], rescue_applied,
                "{name}: {reranked}"
            );
            let mut actual = reranked;
            let mut expected = fresh;
            without_timing_fields(&mut actual);
            without_timing_fields(&mut expected);
            assert_eq!(actual, expected, "gated rerank case {name}");
        }
    }

    #[test]
    fn input_prefix_rerank_reports_the_retained_queue_length_and_requires_opt_in() {
        let source: Json = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-search-rescue-request.json"
        ))
        .expect("saved F14 search rescue fixture");
        let profile = leaf_conversion_gated_profile(CONFIG_HASH);
        let mut real = source;
        real["execution"] = json!(profile);
        real["requestId"] = json!("input-prefix-real");
        real["positionId"] = json!("input-prefix-real-position");
        real["generation"] = json!(3);
        real["selector"]["incoming"] = json!({ "pendingRows": 0, "dueThisLockRows": 0 });
        let queue = real["start"]["queue"].as_array().unwrap().clone();
        assert_eq!(queue.len(), 14);
        real["selector"]["pieces"]["known"] = json!(queue[1..]);

        let mut prefix = real.clone();
        prefix["requestId"] = json!("input-prefix-speculation");
        prefix["positionId"] = json!("input-prefix-speculation-position");
        prefix["generation"] = json!(2);
        prefix["start"]["queue"] = json!(queue[..13]);
        prefix["selector"]["pieces"]["known"] = json!(queue[1..13]);
        prefix["start"]["randomizer"] = json!({ "type": "seven_bag", "bag_state": [] });

        let mut driver =
            F14Driver::start_input_speculation(profile.clone(), prefix.clone()).unwrap();
        while !driver.work(64).complete {}
        let (speculated, retained) = driver.finish_with_retained();
        assert_eq!(speculated["status"], "move", "{speculated}");
        let retained = retained.expect("INPUT prefix search retained its result");
        assert!(retained.input_speculation);

        let reranked = rerank_retained(
            real.clone(),
            &retained.request,
            &retained.profile,
            &retained.outcome,
            retained.input_speculation,
        );
        assert_eq!(reranked["status"], "move", "{reranked}");
        assert_eq!(reranked["search"]["queueLength"], 13);
        assert_eq!(reranked["search"]["searchedQueueLength"], 13);

        let without_opt_in = rerank_retained(
            real,
            &retained.request,
            &retained.profile,
            &retained.outcome,
            false,
        );
        assert_eq!(
            without_opt_in["reason"], "rerank-mismatch",
            "{without_opt_in}"
        );
    }

    #[test]
    fn public_b_rerank_matches_fresh_search_when_a_next_piece_is_revealed() {
        let source: Json = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-search-rescue-request.json"
        ))
        .expect("public B search rescue fixture");
        let profile: Profile = serde_json::from_value(source["execution"].clone()).unwrap();
        let known = source["selector"]["pieces"]["known"].as_array().unwrap().clone();
        // The speculative request knows only the 13 pieces its 14-piece queue
        // needs; the real one has since seen more. `start` is the same.
        let mut original = source.clone();
        original["requestId"] = json!("rerank-next-a");
        original["selector"]["pieces"]["known"] = json!(known[..13]);
        original["selector"]["incoming"] = json!({ "pendingRows": 0, "dueThisLockRows": 0 });
        let (baseline, retained) = run_f14_driver_with_retained(&profile, original.clone());
        assert_eq!(baseline["status"], "move", "{baseline}");
        let retained = retained.expect("public Profile B decision retained its root result");
        for (name, revealed, incoming) in [("one-more", 14, (0, 0)), ("all", known.len(), (19, 0))] {
            let mut target = source.clone();
            target["requestId"] = json!(format!("rerank-next-b-{name}"));
            target["generation"] = json!(3);
            target["selector"]["pieces"]["known"] = json!(known[..revealed]);
            target["selector"]["incoming"] = json!({ "pendingRows": incoming.0, "dueThisLockRows": incoming.1 });
            let reranked = rerank_retained(target.clone(), &retained.request, &retained.profile, &retained.outcome, false,
            );
            let mut actual = reranked.clone();
            let mut expected = run_f14_driver(&profile, target);
            without_timing_fields(&mut actual);
            without_timing_fields(&mut expected);
            assert_eq!(actual, expected, "rerank case {name}");
        }
        // A different `start` is still refused.
        let mut changed = source.clone();
        changed["requestId"] = json!("rerank-next-start");
        changed["start"]["hold"] = json!("T");
        changed["selector"]["pieces"]["hold"] = json!("T");
        let refused = rerank_retained(changed, &retained.request, &retained.profile, &retained.outcome, false,
        );
        assert_eq!(refused["reason"], "rerank-mismatch", "{refused}");
    }

    #[test]
    fn public_b_rerank_rejects_changed_board_after_normal_admission() {
        let mut request: Json = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-search-rescue-request.json"
        ))
        .expect("public B search rescue fixture");
        let profile: Profile = serde_json::from_value(request["execution"].clone()).unwrap();
        request["selector"]["incoming"] = json!({ "pendingRows": 0, "dueThisLockRows": 0 });
        let (_, retained) = run_f14_driver_with_retained(&profile, request.clone());
        let retained = retained.expect("public Profile B decision retained its root result");
        let mut changed = request;
        changed["requestId"] = json!("rerank-board-mismatch");
        changed["positionId"] = json!("rerank-board-mismatch-position");
        changed["generation"] = json!(4);
        changed["selector"]["incoming"] = json!({ "pendingRows": 4, "dueThisLockRows": 0 });
        changed["selector"]["board"]["visibleHeight"] = json!(21);
        changed["selector"]["board"]["bufferHeight"] = json!(19);
        let response = rerank_retained(
            changed,
            &retained.request,
            &retained.profile,
            &retained.outcome, false,
        );
        assert_eq!(response["status"], "error");
        assert_eq!(response["reason"], "rerank-mismatch");
    }

    #[test]
    fn public_b_time_budget_rerank_keeps_the_completed_selection_count() {
        let profile = timed_public_profile(512);
        let (mut original, _) = rescue_fixture_request(&profile);
        original["requestId"] = json!("timed-rerank-a");
        original["positionId"] = json!("timed-rerank-position-a");
        original["generation"] = json!(2);
        original["selector"]["incoming"] = json!({
            "pendingRows": 0,
            "dueThisLockRows": 0,
        });
        let mut first = F14Driver::start(profile.clone(), original.clone()).unwrap();
        first.work(16);
        let (baseline, retained) = first.finish_early_with_retained();
        let retained = retained.expect("timed public decision retained its root result");
        let completed = baseline["search"]["actualSelections"].as_u64().unwrap();
        assert!(completed > 0 && completed < profile.budget.selections);

        let mut target = original.clone();
        target["requestId"] = json!("timed-rerank-b");
        target["positionId"] = json!("timed-rerank-position-b");
        target["generation"] = json!(3);
        target["selector"]["incoming"] = json!({
            "pendingRows": 19,
            "dueThisLockRows": 0,
        });
        let reranked = rerank_retained(
            target.clone(),
            &retained.request,
            &retained.profile,
            &retained.outcome, false,
        );
        let mut fresh_driver = F14Driver::start(profile.clone(), target.clone()).unwrap();
        fresh_driver.work(16);
        let fresh = fresh_driver.finish_early();
        let mut actual = reranked.clone();
        let mut expected = fresh.clone();
        without_timing_fields(&mut actual);
        without_timing_fields(&mut expected);
        assert_eq!(actual, expected);
        assert_eq!(reranked["reason"], "time-budget");
        assert_eq!(reranked["search"]["actualSelections"], completed);
    }

    #[test]
    fn core_allspin_production_job_rescue_is_byte_identical_to_legacy_route() {
        let request: Json = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-core-allspin-rescue-request.json"
        ))
        .expect("core-allspin rescue fixture");
        let profile: Profile = serde_json::from_value(request["execution"].clone())
            .expect("core-allspin profile from fixture");
        let response = run_production_job(&profile, request.clone());

        assert_eq!(response["status"], "move");
        assert_eq!(response["ranking"]["rescueApplied"], true);
        assert_eq!(response["ranking"]["selectedCc2Rank"], 8);
        assert_eq!(
            response["diagnostics"],
            json!({
                "nonTSetupBonusApplied": 0,
                "nonTSetupWitnessCalls": 0,
                "postSpinPolicyId": POST_SPIN_POLICY_OFF,
            })
        );
        assert_eq!(
            response["boundaryAudit"],
            json!(crate::s2_audit::Audit::default())
        );

        let moves = placements_from_identity_list(&response["ranking"]["returnedIdentities"]);
        let legacy = decide_limited_with_legacy_selector(
            request,
            &profile,
            &moves,
            SearchStats {
                nodes: response["search"]["nodes"].as_u64().unwrap(),
                selections: response["search"]["actualSelections"].as_u64().unwrap(),
            },
            None,
            None,
            1,
        );
        assert_eq!(
            sorted_response_bytes(&response),
            sorted_response_bytes(&legacy)
        );
    }

    #[test]
    fn rank_order_production_job_rescue_uses_lowest_rank_solvent_candidate() {
        let mut request: Json = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-search-rescue-request.json"
        ))
        .expect("public rescue fixture");
        let profile = rank_order_profile(CONFIG_HASH);
        request["execution"] = serde_json::to_value(&profile).unwrap();
        let response = run_production_job(&profile, request);

        assert_eq!(response["status"], "move");
        assert_eq!(response["ranking"]["rescueApplied"], true);
        let lowest_solvent_rank = response["ranking"]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|candidate| candidate["solvent"].as_bool() == Some(true))
            .map(|candidate| candidate["cc2Rank"].as_i64().unwrap())
            .min()
            .expect("rescue fixture has a solvent candidate");
        assert_eq!(response["ranking"]["selectedCc2Rank"], lowest_solvent_rank);
        assert_eq!(
            response["diagnostics"],
            json!({
                "finalOrderPolicyId": FINAL_ORDER_POLICY_CC2,
                "postStageConversionAddCalls": 16,
                "postStageConversionComputeCalls": 16,
                "postStageRerankCalls": 1,
            })
        );
    }

    #[test]
    fn amount_and_public_core_boundaries_match_composed_pattern() {
        for (profile, request, moves, limits, decision) in [
            {
                let profile = profile();
                let (request, moves, limits, decision) = normal_core_decision(&profile, 7);
                (profile, request, moves, limits, decision)
            },
            {
                let profile = public_b_profile();
                let (request, moves, limits, decision) = composed_core_decision(&profile, 7);
                (profile, request, moves, limits, decision)
            },
            {
                let profile = core_allspin_profile(CAS_CONFIG_HASH);
                let (request, moves, limits, decision) = composed_core_decision(&profile, 7);
                (profile, request, moves, limits, decision)
            },
        ] {
            let stats = SearchStats {
                nodes: decision.nodes,
                selections: decision.completed_selections,
            };
            let missing = decide_limited_with_core(
                request.clone(),
                &profile,
                &moves,
                stats,
                None,
                None,
                7,
                None,
            );
            assert_eq!(missing["reason"], "missing-core-ranking");
            let mut stale = decision.clone();
            stale.binding.request_epoch = 8;
            let stale_response = decide_limited_with_core(
                request.clone(),
                &profile,
                &moves,
                stats,
                Some(&limits),
                None,
                7,
                Some(stale),
            );
            assert_eq!(stale_response["reason"], "stale-ranking-epoch");
            let mut mismatch = decision;
            mismatch.binding.public_context_digest[0] ^= 1;
            let mismatch_response = decide_limited_with_core(
                request,
                &profile,
                &moves,
                stats,
                Some(&limits),
                None,
                7,
                Some(mismatch),
            );
            assert_eq!(mismatch_response["reason"], "ranking-binding-mismatch");
            let empty = decide_limited(
                request_with_profile(load_p5()["decisions"][0]["selector"].clone(), &profile),
                &profile,
                &[],
                stats,
                None,
                None,
                7,
            );
            assert_eq!(empty["status"], "error");
            assert_eq!(empty["reason"], "empty-candidates");
        }
    }

    #[test]
    fn composed_a_rescue_fixture_is_rejected_at_production_admission() {
        let mut profile = profile();
        profile.profile_id = COMPOSED_A.into();
        let (request, moves) = rescue_fixture_request(&profile);
        let response = decide(
            request,
            &profile,
            &moves,
            SearchStats {
                nodes: 42,
                selections: profile.budget.selections,
            },
        );
        assert_eq!(response["status"], "unsupported");
        assert_eq!(response["reason"], "unsupported-incoming-profile");
    }

    #[test]
    fn root_route_uses_core_owned_rescue_and_keeps_composed_wire_payload() {
        let root = root_profile();
        let (request, moves) = rescue_fixture_request(&root);
        let state = public_state_from_json(&request["selector"]).unwrap();
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let move_values: Vec<Json> = moves
            .iter()
            .map(|placement| serde_json::to_value(placement).unwrap())
            .collect();
        let session = RootObjectiveSession::new(
            PublicRootLockContext::for_profile(&state, &limits, true).unwrap(),
            root.decision_stage(),
            512,
            7,
            public_context_digest_for_request(&request, &root).unwrap(),
        );
        session
            .complete_work(
                &crate::bot::Statistics {
                    nodes: 42,
                    selections: 512,
                    ..Default::default()
                },
                || {
                    moves
                        .iter()
                        .copied()
                        .map(|placement| (placement, 1.0))
                        .collect()
                },
            )
            .unwrap();
        let decision = match session.take_outcome().unwrap().unwrap() {
            FinishedRootOutcome::Decided(decision) => decision,
            other => panic!("unexpected root outcome: {other:?}"),
        };
        let old_context = PublicRootLockContext::for_profile(&state, &limits, true).unwrap();
        let expected_selection = apply_residual_rescue(
            root.decision_stage()
                .compose_returned_prefix(&old_context, &move_values)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(decision.selection, expected_selection);
        assert!(decision.selection.rescued);
        assert_eq!(decision.selection.selected.cc2_rank, 1);
        let stats = SearchStats {
            nodes: 42,
            selections: 512,
        };
        let root_response = decide_limited_with_core(
            request.clone(),
            &root,
            &moves,
            stats,
            Some(&limits),
            None,
            7,
            Some(decision.clone()),
        );
        assert_eq!(root_response["status"], "move");
        assert_eq!(root_response["ranking"]["rescueApplied"], true);
        assert_eq!(root_response["ranking"]["selectedCc2Rank"], 1);
        assert_eq!(root_response["boundaryAudit"]["legacyF14SelectionCalls"], 0);
        assert_eq!(root_response["boundaryAudit"]["legacyF14RescueCalls"], 0);

        let composed = composed_b_profile();
        let mut composed_request = request_with_profile(request["selector"].clone(), &composed);
        composed_request["start"] = request["start"].clone();
        let composed_snapshot =
            snapshot_composed_ranking(&old_context, &composed, &moves, 7, &composed_request)
                .unwrap();
        let composed_response = decide_limited_with_snapshot(
            composed_request,
            &composed,
            &moves,
            stats,
            Some(&limits),
            None,
            Some(composed_snapshot),
            7,
        );
        for key in [
            "selectedIdentity",
            "selectedMove",
            "selectedPlacement",
            "ranking",
            "search",
        ] {
            assert_eq!(
                root_response[key], composed_response[key],
                "wire field {key}"
            );
        }
        let mut root_diagnostics = root_response["diagnostics"].clone();
        for key in [
            "coreRankingComposeCalls",
            "coreRerankCalls",
            "coreConversionComputeCalls",
            "rootObjectiveUsedForSelect",
            "deepAllocationAttempts",
            "signatureComparisons",
            "signatureChanges",
            "nativeSnapshotReads",
            "revisionRebinds",
            "objectiveRebuilds",
            "permutationMaterializations",
            "factsCacheMisses",
            "factsCacheHits",
            "identityCanonicalizations",
            "witnessLookups",
            "factsCacheEntries",
            "distinctEntrants",
            "rawActionsSeen",
            "cacheBytesEstimate",
            "rootDraws",
        ] {
            root_diagnostics.as_object_mut().unwrap().remove(key);
        }
        assert_eq!(
            root_diagnostics, composed_response["diagnostics"],
            "diagnostics"
        );
        assert_eq!(
            root_response["boundaryAudit"], composed_response["boundaryAudit"],
            "boundary audit"
        );
    }

    #[test]
    fn root_route_rejects_missing_stale_and_mismatched_core_decisions() {
        let root = root_profile();
        let (request, moves) = rescue_fixture_request(&root);
        let state = public_state_from_json(&request["selector"]).unwrap();
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let context = PublicRootLockContext::for_profile(&state, &limits, true).unwrap();
        let move_values: Vec<Json> = moves
            .iter()
            .map(|placement| serde_json::to_value(placement).unwrap())
            .collect();
        let identities = placement_identities(&move_values).unwrap();
        let selection = apply_residual_rescue(
            root.decision_stage()
                .compose_returned_prefix(&context, &move_values)
                .unwrap(),
        )
        .unwrap();
        let decision = FinishedRootDecision {
            binding: snapshot_binding(
                7,
                &public_context_document(&state, &request, &root),
                &identities,
            ),
            root_revision: 512,
            completed_selections: 512,
            nodes: 42,
            native_moves: moves.clone(),
            native_values: vec![1.0; moves.len()],
            selection,
            counters: Default::default(),
            post_stage_counters: Default::default(),
        };
        let stats = SearchStats {
            nodes: 42,
            selections: 512,
        };
        let missing = decide_limited_with_core(
            request.clone(),
            &root,
            &moves,
            stats,
            Some(&limits),
            None,
            7,
            None,
        );
        assert_eq!(missing["reason"], "missing-core-ranking");
        let stale = decide_limited_with_core(
            request.clone(),
            &root,
            &moves,
            stats,
            Some(&limits),
            None,
            7,
            Some(FinishedRootDecision {
                binding: SnapshotBinding {
                    request_epoch: 8,
                    ..decision.binding.clone()
                },
                ..decision.clone()
            }),
        );
        assert_eq!(stale["reason"], "stale-ranking-epoch");
        let mut binding = decision.binding.clone();
        binding.public_context_digest[0] ^= 1;
        let mismatch = decide_limited_with_core(
            request,
            &root,
            &moves,
            stats,
            Some(&limits),
            None,
            7,
            Some(FinishedRootDecision {
                binding,
                ..decision
            }),
        );
        assert_eq!(mismatch["reason"], "ranking-binding-mismatch");
    }

    #[test]
    fn old_paths_do_not_require_snapshots() {
        let p5 = load_p5();
        let moves: Vec<Placement> =
            serde_json::from_value(p5["decisions"][0]["moves"].clone()).unwrap();
        let a = profile();
        let b = public_b_profile();
        let stats = SearchStats {
            nodes: 0,
            selections: 512,
        };
        let a_response = decide_limited_with_legacy_selector(
            request_with_profile(p5["decisions"][0]["selector"].clone(), &a),
            &a,
            &moves,
            stats,
            None,
            None,
            0,
        );
        let b_response = decide_limited_with_legacy_selector(
            request_with_profile(p5["decisions"][0]["selector"].clone(), &b),
            &b,
            &moves,
            stats,
            None,
            None,
            0,
        );
        assert_eq!(a_response["status"], "move");
        assert_eq!(b_response["status"], "move");
        assert_ne!(a_response["reason"], "missing-core-ranking");
        assert_ne!(b_response["reason"], "missing-core-ranking");
    }

    #[test]
    fn empty_candidates_is_not_a_compose_or_native_search_failure() {
        let p = composed_b_profile();
        let stats = SearchStats {
            nodes: 0,
            selections: 512,
        };
        let empty = decide_limited(
            request_with_profile(load_p5()["decisions"][0]["selector"].clone(), &p),
            &p,
            &[],
            stats,
            None,
            None,
            1,
        );
        assert_eq!(empty["status"], "error");
        assert_eq!(empty["reason"], "empty-candidates");
        assert_ne!(empty["reason"], "missing-core-ranking");
        assert_ne!(empty["reason"], "error");
        let missing = decide_limited(
            request_with_profile(load_p5()["decisions"][0]["selector"].clone(), &p),
            &p,
            &[dummy_move()],
            stats,
            None,
            None,
            1,
        );
        assert_eq!(missing["reason"], "missing-core-ranking");
        assert_ne!(missing["reason"], "empty-candidates");
    }

    #[test]
    fn old_public_path_emits_nonzero_post_stage_diagnostics() {
        let p5 = load_p5();
        let moves: Vec<Placement> =
            serde_json::from_value(p5["decisions"][0]["moves"].clone()).unwrap();
        let profile = public_b_profile();
        let response = decide_limited_with_legacy_selector(
            request_with_profile(p5["decisions"][0]["selector"].clone(), &profile),
            &profile,
            &moves,
            SearchStats {
                nodes: 0,
                selections: 512,
            },
            None,
            None,
            0,
        );
        assert_eq!(response["status"], "move");
        assert!(
            response["diagnostics"]["postStageConversionComputeCalls"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert!(
            response["diagnostics"]["postStageConversionAddCalls"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert!(
            response["diagnostics"]["postStageRerankCalls"]
                .as_u64()
                .unwrap()
                > 0
        );
    }
}
