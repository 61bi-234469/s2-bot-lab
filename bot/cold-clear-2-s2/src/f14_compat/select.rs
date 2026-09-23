//! In-process F14 amount-only selector. Public input only; no ADR-063 rootAmounts.

use super::prefix::{
    build_f14_prefix, final_pose_key, spin_rank, AcceptedCandidate, CanonicalPlacement,
    PrefixOptions, UnverifiablePolicy,
};
use super::reach::{
    generate_public_reachable, generate_reachable_a, is_fin_or_tst, kick_tables_from_json,
    tetromino_cells_from_json, KickTables, ReachPieceState, ReachPlacement,
};
use super::{
    advance_f14_amount_only, advance_f14_chain, advance_f14_pieces, apply_f14_lock_blocks,
    calculate_f14_surge, choose_rescue, classify_conversion_for_policy,
    extract_amount_only_decision_features, non_t_all_spin_clear, occupied_height,
    rank_candidates_with_policy,
    score_evaluation_features, CompatError, Conversion, ConversionBranch, F14Incoming,
    F14LockPublic, F14Pieces, FeatureProjection, FinalOrderPolicy, LockBoardView, PostSpinPolicy,
    RankedCandidate,
    F14_RULESET_ID,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use crate::time::Instant;
use parking_lot::Mutex;
use crate::bot::Statistics;
use crate::data::Placement;
use crate::dag::{LegacyRootSnapshot, RootSelectionMapper};
use super::root_allocation::{PrefixViewSignature, RootCandidateFacts, RootCandidateFactsCache,
    RootLocalAblation, RootPrefixView, RootRejectedFacts, RootSnapshotBinding, ALLOCATION_MODE,
    ROOT_VALUE_MODE, PREFIX_LIMIT};

const TABLES_JSON: &str = include_str!("tables.json");
const VISIBLE_HEIGHT: i32 = 20;
const PC_B2B_BONUS: u32 = 1;
const CHARGING_AT: u32 = 4;
const CHARGING_BASE: u32 = 3;
const MULTIPLIER_BASE: f64 = 1.0;
const MULTIPLIER_INCREASE: f64 = 0.008;
const MULTIPLIER_MARGIN: u32 = 10800;

static GEOMETRY: Lazy<(KickTables, HashMap<(String, String), Vec<(i32, i32)>>)> = Lazy::new(|| {
    let value: Value = serde_json::from_str(TABLES_JSON).expect("f14 tables json");
    (
        kick_tables_from_json(&value["srs"]),
        tetromino_cells_from_json(&value["tetrominoCells"]),
    )
});

pub fn geometry() -> &'static (KickTables, HashMap<(String, String), Vec<(i32, i32)>>) {
    &GEOMETRY
}

/// sparse-s2 overlay on the depth-1 baseline, `Object.entries` / FEATURE_NAMES order.
pub const EFFECTIVE_WEIGHTS: [f64; 19] = [
    -0.1,
    -0.4,
    -1.0,
    -0.05,
    -1_000_000.0,
    0.0,
    -0.8,
    0.0,
    0.0,
    0.0,
    -0.25,
    0.0,
    0.0,
    1.0,
    0.8,
    0.0,
    0.6,
    0.0,
    0.25,
];

#[derive(Clone, Debug, PartialEq)]
pub struct F14SelectorTime {
    pub logical_frame: u32,
    pub fidelity: String,
    pub frame_semantics: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct F14PublicState {
    pub board_cells: String,
    pub width: i32,
    pub height: i32,
    pub visible_height: i32,
    pub pieces: F14Pieces,
    pub combo: u32,
    pub b2b: u32,
    pub time: F14SelectorTime,
    pub incoming: F14Incoming,
}

#[derive(Clone, Debug, PartialEq)]
pub struct F14SelectOptions {
    pub candidate_limit: i32,
    pub allow_complete_returned_prefix: bool,
    pub unverifiable: UnverifiablePolicy,
    pub weights: [f64; 19],
    pub post_spin_policy: PostSpinPolicy,
    pub final_order_policy: FinalOrderPolicy,
}

impl Default for F14SelectOptions {
    fn default() -> Self {
        Self {
            candidate_limit: 16,
            allow_complete_returned_prefix: true,
            unverifiable: UnverifiablePolicy::RecordAndSkip,
            weights: EFFECTIVE_WEIGHTS,
            post_spin_policy: PostSpinPolicy::LegacyF14,
            final_order_policy: FinalOrderPolicy::S2Rerank,
        }
    }
}

#[derive(Clone, Debug)]
pub struct F14RuntimeLimits {
    pub deadline: Instant,
    pub cancel: Arc<AtomicBool>,
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

#[derive(Clone, Debug, PartialEq)]
pub struct F14SelectedCandidate {
    pub cc2_rank: i32,
    pub identity: String,
    pub move_value: Value,
    pub placement: CanonicalPlacement,
    pub last_rotation: bool,
    pub kick_index: Option<i32>,
    pub kick_id: Option<String>,
    pub kick_offset: Option<(i32, i32)>,
    pub spin: String,
    pub lines: u32,
    pub s2_score: f64,
    pub selection_score: f64,
    pub conversion: Conversion,
    pub solvency: f64,
    pub solvent: bool,
    pub ren_combat_gain: f64,
    pub release_value: f64,
    pub setup_witnessed: bool,
    pub combo_after: f64,
    pub b2b_after: f64,
    pub surge_sent: f64,
    pub cancelled: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ComposedRankingPrefix {
    pub ranked: Vec<RankedCandidate>,
    pub selected_meta: Vec<F14SelectedCandidate>,
    pub returned_candidate_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotBinding {
    pub request_epoch: u64,
    pub public_context_digest: [u8; 32],
    pub returned_count: usize,
    pub returned_identity_digest: [u8; 32],
}

#[derive(Debug, Default)]
pub(crate) struct CoreDecisionCounters {
    pub(crate) ranking_compose_calls: AtomicU64,
    pub(crate) rerank_calls: AtomicU64,
    pub(crate) conversion_compute_calls: AtomicU64,
    pub(crate) root_objective_used_for_select: AtomicU64,
    pub(crate) deep_allocation_attempts: AtomicU64,
    pub(crate) signature_comparisons: AtomicU64,
    pub(crate) signature_changes: AtomicU64,
    pub(crate) native_snapshot_reads: AtomicU64,
    pub(crate) revision_rebinds: AtomicU64,
    pub(crate) objective_rebuilds: AtomicU64,
    pub(crate) permutation_materializations: AtomicU64,
    pub(crate) facts_cache_misses: AtomicU64,
    pub(crate) facts_cache_hits: AtomicU64,
    pub(crate) identity_canonicalizations: AtomicU64,
    pub(crate) witness_lookups: AtomicU64,
    pub(crate) facts_cache_entries: AtomicU64,
    pub(crate) distinct_entrants: AtomicU64,
    pub(crate) raw_actions_seen: AtomicU64,
    pub(crate) cache_bytes_estimate: AtomicU64,
    pub(crate) root_draws: AtomicU64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CoreDecisionCountersSnapshot {
    pub(crate) ranking_compose_calls: u64,
    pub(crate) rerank_calls: u64,
    pub(crate) conversion_compute_calls: u64,
    pub(crate) root_objective_used_for_select: u64,
    pub(crate) deep_allocation_attempts: u64,
    pub(crate) signature_comparisons: u64,
    pub(crate) signature_changes: u64,
    pub(crate) native_snapshot_reads: u64,
    pub(crate) revision_rebinds: u64,
    pub(crate) objective_rebuilds: u64,
    pub(crate) permutation_materializations: u64,
    pub(crate) facts_cache_misses: u64,
    pub(crate) facts_cache_hits: u64,
    pub(crate) identity_canonicalizations: u64,
    pub(crate) witness_lookups: u64,
    pub(crate) facts_cache_entries: u64,
    pub(crate) distinct_entrants: u64,
    pub(crate) raw_actions_seen: u64,
    pub(crate) cache_bytes_estimate: u64,
    pub(crate) root_draws: u64,
}

/// Diagnostic-only observation sink for the native-shadow path.  The
/// production OFF path does not allocate one, so it remains byte-compatible
/// with O.  Rows are bounded by the caller's request budget and are kept out
/// of the production decision response.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RootAllocationTraceRow {
    pub(crate) work_index: u64,
    pub(crate) status: String,
    pub(crate) raw_count: usize,
    pub(crate) prefix_count: usize,
    pub(crate) accepted_count: usize,
    pub(crate) rejected_count: usize,
    pub(crate) signature_changed: bool,
    pub(crate) top1_rejected: bool,
    pub(crate) root_revision: u64,
    pub(crate) raw_native_top1: Option<String>,
    pub(crate) core_pre_rescue_top1: Option<String>,
    pub(crate) native_draw_index: Option<usize>,
    pub(crate) local_ablation: Option<RootLocalAblation>,
    pub(crate) detail_policy: String,
    pub(crate) detail_saved: bool,
    pub(crate) candidate_details: Vec<RootCandidateDetail>,
    pub(crate) rank_churn: usize,
    pub(crate) prefix_entrant_count: usize,
    pub(crate) visit_concentration: Option<f64>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RootCandidateDetail {
    pub(crate) raw_index: usize,
    pub(crate) identity: String,
    pub(crate) verification: String,
    pub(crate) canonical_pose: String,
    pub(crate) selection_score: String,
    pub(crate) conversion_units: String,
}

fn candidate_details(view: &RootPrefixView) -> Vec<RootCandidateDetail> {
    view.facts
        .iter()
        .map(|facts| RootCandidateDetail {
            raw_index: facts.raw_index,
            identity: facts.identity.to_string(),
            verification: "accepted".to_owned(),
            canonical_pose: format!("{:?}", facts.placement),
            selection_score: facts.ranked.selection_score.to_string(),
            conversion_units: facts.ranked.conversion.units.to_string(),
        })
        .collect()
}

fn detail_required(
    first_ready: bool,
    work_index: u64,
    signature_changed: bool,
    top1_rejected: bool,
    selection_limit: u64,
) -> bool {
    first_ready
        || work_index.saturating_add(1) >= selection_limit
        || signature_changed
        || top1_rejected
        || work_index % 64 == 0
}

#[derive(Debug, Default)]
pub(crate) struct RootAllocationTraceSink {
    rows: Mutex<Vec<RootAllocationTraceRow>>,
}

impl RootAllocationTraceSink {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub(crate) fn push(&self, row: RootAllocationTraceRow) {
        self.rows.lock().push(row);
    }

    pub(crate) fn rows(&self) -> Vec<RootAllocationTraceRow> {
        self.rows.lock().clone()
    }

    pub(crate) fn update_last_draw(
        &self,
        work_index: u64,
        draw_index: usize,
        ablation: RootLocalAblation,
        visit_concentration: f64,
        candidate_details: Option<Vec<RootCandidateDetail>>,
    ) {
        if let Some(row) = self.rows.lock().iter_mut().rev().find(|row| row.work_index == work_index) {
            row.native_draw_index = Some(draw_index);
            row.local_ablation = Some(ablation);
            row.visit_concentration = Some(visit_concentration);
            if let Some(details) = candidate_details {
                row.detail_saved = true;
                row.candidate_details = details;
            }
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RootObservation {
    shadow_each_work: bool,
    sink: Arc<RootAllocationTraceSink>,
}

impl RootObservation {
    pub(crate) fn native_shadow(sink: Arc<RootAllocationTraceSink>) -> Self {
        Self { shadow_each_work: true, sink }
    }

    pub(crate) fn sink(&self) -> &Arc<RootAllocationTraceSink> {
        &self.sink
    }

    pub(crate) fn enabled(&self) -> bool {
        self.shadow_each_work
    }
}

impl CoreDecisionCounters {
    pub(crate) fn snapshot(&self) -> CoreDecisionCountersSnapshot {
        CoreDecisionCountersSnapshot {
            ranking_compose_calls: self.ranking_compose_calls.load(Ordering::Acquire),
            rerank_calls: self.rerank_calls.load(Ordering::Acquire),
            conversion_compute_calls: self.conversion_compute_calls.load(Ordering::Acquire),
            root_objective_used_for_select: self.root_objective_used_for_select.load(Ordering::Acquire),
            deep_allocation_attempts: self.deep_allocation_attempts.load(Ordering::Acquire),
            signature_comparisons: self.signature_comparisons.load(Ordering::Acquire),
            signature_changes: self.signature_changes.load(Ordering::Acquire),
            native_snapshot_reads: self.native_snapshot_reads.load(Ordering::Acquire),
            revision_rebinds: self.revision_rebinds.load(Ordering::Acquire),
            objective_rebuilds: self.objective_rebuilds.load(Ordering::Acquire),
            permutation_materializations: self.permutation_materializations.load(Ordering::Acquire),
            facts_cache_misses: self.facts_cache_misses.load(Ordering::Acquire),
            facts_cache_hits: self.facts_cache_hits.load(Ordering::Acquire),
            identity_canonicalizations: self.identity_canonicalizations.load(Ordering::Acquire),
            witness_lookups: self.witness_lookups.load(Ordering::Acquire),
            facts_cache_entries: self.facts_cache_entries.load(Ordering::Acquire),
            distinct_entrants: self.distinct_entrants.load(Ordering::Acquire),
            raw_actions_seen: self.raw_actions_seen.load(Ordering::Acquire),
            cache_bytes_estimate: self.cache_bytes_estimate.load(Ordering::Acquire),
            root_draws: self.root_draws.load(Ordering::Acquire),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AllocationMode {
    Off,
    PermutationV1,
    RootValueV1,
}

impl AllocationMode {
    fn prefix_mode(self) -> &'static str {
        match self {
            Self::Off | Self::PermutationV1 => ALLOCATION_MODE,
            Self::RootValueV1 => ROOT_VALUE_MODE,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PostStageCountersSnapshot {
    pub(crate) non_t_setup_witness_calls: u64,
    pub(crate) non_t_setup_bonus_applied: u64,
    pub(crate) conversion_compute_calls: u64,
    pub(crate) conversion_add_calls: u64,
    pub(crate) rerank_calls: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FinishedRootDecision {
    pub(crate) binding: SnapshotBinding,
    pub(crate) root_revision: u64,
    pub(crate) completed_selections: u64,
    pub(crate) nodes: u64,
    pub(crate) native_moves: Vec<Placement>,
    pub(crate) native_values: Vec<f32>,
    pub(crate) selection: F14Selection,
    pub(crate) counters: CoreDecisionCountersSnapshot,
    pub(crate) post_stage_counters: PostStageCountersSnapshot,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum FinishedRootOutcome {
    Decided(FinishedRootDecision),
    NoCandidates { completed_selections: u64, nodes: u64 },
    Failed(CompatError),
}

enum OutcomeCell {
    Pending,
    Published(FinishedRootOutcome),
    Taken,
}

/// Engine-owned final decision stage for an F14 root result.
///
/// The stage keeps prefix composition, final ordering, and the rescue veto
/// together so callers provide only the returned move prefix.
#[derive(Clone, Debug)]
pub(crate) struct RootDecisionStage {
    options: F14SelectOptions,
}

impl RootDecisionStage {
    pub(crate) fn new(options: F14SelectOptions) -> Self {
        Self { options }
    }

    pub(crate) fn compose_returned_prefix(
        &self,
        context: &PublicRootLockContext,
        moves: &[Value],
    ) -> Result<ComposedRankingPrefix, CompatError> {
        context.compose_ranking(moves, &self.options)
    }

    pub(crate) fn decide(
        &self,
        context: &PublicRootLockContext,
        moves: &[Value],
    ) -> Result<(F14Selection, PostStageCountersSnapshot), CompatError> {
        let (selection_result, audit) = crate::s2_audit::run_native_f14_compat(|| {
            self.compose_returned_prefix(context, moves)
                .and_then(apply_residual_rescue)
        });
        let selection = selection_result?;
        let post_stage_counters = PostStageCountersSnapshot {
            non_t_setup_witness_calls: audit.non_t_setup_witness_calls,
            non_t_setup_bonus_applied: audit.non_t_setup_bonus_applied,
            conversion_compute_calls: audit.post_stage_conversion_compute_calls,
            conversion_add_calls: audit.post_stage_conversion_add_calls,
            rerank_calls: audit.post_stage_rerank_calls,
        };
        Ok((selection, post_stage_counters))
    }

    #[cfg(test)]
    pub(crate) fn legacy_selector_options(&self) -> &F14SelectOptions {
        &self.options
    }
}

pub(crate) struct RootObjectiveSession {
    context: PublicRootLockContext,
    decision_stage: RootDecisionStage,
    selection_limit: u64,
    request_epoch: u64,
    public_context_digest: [u8; 32],
    allocation_mode: AllocationMode,
    counters: Arc<CoreDecisionCounters>,
    completed_selections: AtomicU64,
    completed_nodes: AtomicU64,
    outcome: Mutex<OutcomeCell>,
    facts_cache: Mutex<RootCandidateFactsCache>,
    root_view: Mutex<Option<RootPrefixView>>,
    observation: Mutex<Option<RootObservation>>,
    pending_draw: Mutex<Option<PendingRootDraw>>,
    root_visits: Mutex<HashMap<usize, u64>>,
}

/// Typed adapter used only by the Legacy DAG root selector. Keeping the
/// session behind this trait prevents production callers from passing an
/// arbitrary S2/root mapper and gives the DAG a pre-RNG binding check.
pub(crate) struct RootSelectionBinding<'a> {
    session: &'a RootObjectiveSession,
}

impl<'a> RootSelectionBinding<'a> {
    pub(crate) fn new(session: &'a RootObjectiveSession) -> Self {
        Self { session }
    }
}

impl RootSelectionMapper for RootSelectionBinding<'_> {
    fn preflight(&self, raw_count: usize) -> Result<(), CompatError> {
        if self.session.allocation_mode != AllocationMode::PermutationV1 {
            return Err(CompatError::RootAllocationDomainRejected);
        }
        let pending = self.session.pending_draw.lock();
        let pending = pending.as_ref().ok_or(CompatError::RootAllocationBindingMismatch)?;
        if raw_count == 0 || pending.view.binding.raw_count != raw_count {
            return Err(CompatError::RootAllocationBindingMismatch);
        }
        Ok(())
    }

    fn map(&self, native_index: usize) -> Result<usize, CompatError> {
        self.session.root_index_for_select(native_index)
    }
}

struct PendingRootDraw {
    work_index: u64,
    view: RootPrefixView,
}

impl RootObjectiveSession {
    pub(crate) fn new(
        context: PublicRootLockContext,
        decision_stage: RootDecisionStage,
        selection_limit: u64,
        request_epoch: u64,
        public_context_digest: [u8; 32],
    ) -> Self {
        let counters = Arc::new(CoreDecisionCounters::default());
        Self {
            context: context.with_core_counters(Arc::clone(&counters)),
            decision_stage,
            selection_limit,
            request_epoch,
            public_context_digest,
            allocation_mode: AllocationMode::Off,
            counters,
            completed_selections: AtomicU64::new(0),
            completed_nodes: AtomicU64::new(0),
            outcome: Mutex::new(OutcomeCell::Pending),
            facts_cache: Mutex::new(RootCandidateFactsCache::default()),
            root_view: Mutex::new(None),
            observation: Mutex::new(None),
            pending_draw: Mutex::new(None),
            root_visits: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn attach_observation(&self, observation: RootObservation) {
        *self.observation.lock() = Some(observation);
    }

    pub(crate) fn new_with_allocation_mode(
        context: PublicRootLockContext,
        decision_stage: RootDecisionStage,
        selection_limit: u64,
        request_epoch: u64,
        public_context_digest: [u8; 32],
        allocation_mode: AllocationMode,
    ) -> Self {
        let mut session = Self::new(
            context,
            decision_stage,
            selection_limit,
            request_epoch,
            public_context_digest,
        );
        session.allocation_mode = allocation_mode;
        session
    }

    pub(crate) fn trace_rows(&self) -> Vec<RootAllocationTraceRow> {
        self.observation
            .lock()
            .as_ref()
            .map_or_else(Vec::new, |observation| observation.sink().rows())
    }

    /// Observe one raw Legacy root before the next native work.  Observation
    /// is deliberately fail-soft: the OFF/native search remains authoritative,
    /// while the trace records that this snapshot was unavailable.
    pub(crate) fn observe_legacy_root(&self, snapshot: LegacyRootSnapshot) -> Result<(), CompatError> {
        let observation = self.observation.lock().clone();
        // Feedback production has no diagnostic sink, but it still needs the
        // same request-local view prepared before the root draw.  Keeping the
        // preparation here (rather than allocating another RNG or rebuilding
        // from a post-draw suggestion) preserves the native draw/index
        // binding while leaving OFF production completely untouched.
        if observation.as_ref().is_some_and(|value| !value.enabled() && !self.uses_root_values()) {
            return Ok(());
        }
        if observation.is_none() && self.allocation_mode == AllocationMode::Off {
            return Ok(());
        }
        let work_index = observation.as_ref().map_or(0, |value| value.sink().rows().len() as u64);
        let first_ready = observation.as_ref().map_or(true, |value| {
            !value.sink().rows().iter().any(|row| row.status == "ready")
        });
        let revision = self.completed_selections.load(Ordering::Acquire);
        let mut pending = None;
        let mut fail_closed = None;
        let row = match snapshot {
            LegacyRootSnapshot::Unexpanded => RootAllocationTraceRow {
                work_index,
                status: "unexpanded".to_owned(),
                raw_count: 0,
                prefix_count: 0,
                accepted_count: 0,
                rejected_count: 0,
                signature_changed: false,
                top1_rejected: false,
                root_revision: revision,
                raw_native_top1: None,
                core_pre_rescue_top1: None,
                native_draw_index: None,
                local_ablation: None,
                detail_policy: "none".to_owned(),
                detail_saved: false,
                candidate_details: Vec::new(),
                rank_churn: 0,
                prefix_entrant_count: 0,
                visit_concentration: None,
                error: None,
            },
            LegacyRootSnapshot::Expanded { actions } if actions.is_empty() => RootAllocationTraceRow {
                work_index,
                status: "empty".to_owned(),
                raw_count: 0,
                prefix_count: 0,
                accepted_count: 0,
                rejected_count: 0,
                signature_changed: false,
                top1_rejected: false,
                root_revision: revision,
                raw_native_top1: None,
                core_pre_rescue_top1: None,
                native_draw_index: None,
                local_ablation: None,
                detail_policy: "none".to_owned(),
                detail_saved: false,
                candidate_details: Vec::new(),
                rank_churn: 0,
                prefix_entrant_count: 0,
                visit_concentration: None,
                error: None,
            },
            LegacyRootSnapshot::Expanded { actions } => {
                self.counters.raw_actions_seen.fetch_add(actions.len() as u64, Ordering::AcqRel);
                let before = self.counters.snapshot();
                match self.prepare_root_view_from_native(&actions) {
                    Ok(Some(view)) => {
                        let after = self.counters.snapshot();
                        if self.allocation_mode == AllocationMode::PermutationV1 || observation.is_some() {
                            pending = Some(PendingRootDraw { work_index, view: view.clone() });
                        }
                        let signature_changed = after.signature_changes > before.signature_changes;
                        let top1_rejected = view.rejected_prefix_indices.contains(&0);
                        let detail_saved = detail_required(first_ready, work_index, signature_changed, top1_rejected, self.selection_limit);
                        RootAllocationTraceRow {
                            work_index,
                            status: "ready".to_owned(),
                            raw_count: view.binding.raw_count,
                            prefix_count: view.signature.k,
                            accepted_count: view.ranked_prefix_indices.len(),
                            rejected_count: view.rejected_prefix_indices.len(),
                            signature_changed,
                            top1_rejected,
                            root_revision: view.binding.root_revision,
                            raw_native_top1: view.signature.prefix_identities.first().map(|identity| identity.to_string()),
                            core_pre_rescue_top1: view.facts.first().map(|facts| facts.identity.to_string()),
                            native_draw_index: None,
                            local_ablation: None,
                            detail_policy: "detail-rows/v1".to_owned(),
                            detail_saved,
                            candidate_details: if detail_saved { candidate_details(&view) } else { Vec::new() },
                            rank_churn: view.permutation[..view.signature.k]
                                .iter()
                                .enumerate()
                                .filter(|(index, mapped)| *index != **mapped as usize)
                                .count(),
                            prefix_entrant_count: after.facts_cache_misses.saturating_sub(before.facts_cache_misses) as usize,
                            visit_concentration: None,
                            error: None,
                        }
                    }
                    Ok(None) => RootAllocationTraceRow {
                        work_index,
                        status: "empty".to_owned(),
                        raw_count: 0,
                        prefix_count: 0,
                        accepted_count: 0,
                        rejected_count: 0,
                        signature_changed: false,
                        top1_rejected: false,
                        root_revision: revision,
                        raw_native_top1: None,
                        core_pre_rescue_top1: None,
                        native_draw_index: None,
                        local_ablation: None,
                        detail_policy: "none".to_owned(),
                        detail_saved: false,
                        candidate_details: Vec::new(),
                        rank_churn: 0,
                        prefix_entrant_count: 0,
                        visit_concentration: None,
                        error: None,
                    },
                    Err(error) if matches!(error, CompatError::NoVerifiableCandidate) => {
                        if self.uses_root_values() { fail_closed = Some(error); }
                        RootAllocationTraceRow {
                            work_index,
                            status: "ready".to_owned(),
                            raw_count: actions.len(),
                            prefix_count: actions.len().min(PREFIX_LIMIT),
                            accepted_count: 0,
                            rejected_count: actions.len().min(PREFIX_LIMIT),
                            signature_changed: true,
                            top1_rejected: true,
                            root_revision: revision,
                            raw_native_top1: None,
                            core_pre_rescue_top1: None,
                            native_draw_index: None,
                            local_ablation: Some(RootLocalAblation {
                                status: "unavailable-all-rejected".to_owned(),
                                native_index: None,
                                accepted_first_index: None,
                                c_zero_index: None,
                                full_index: None,
                                prefix_outside_identity: false,
                                prefix_outside_violation: false,
                                acceptance_changed: false,
                                generic_changed: false,
                                conversion_changed: false,
                                composed_route_changed: false,
                            }),
                            detail_policy: "detail-rows/v1".to_owned(),
                            detail_saved: false,
                            candidate_details: Vec::new(),
                            rank_churn: 0,
                            prefix_entrant_count: 0,
                            visit_concentration: None,
                            error: None,
                        }
                    }
                    Err(error) => {
                        if self.uses_root_values() { fail_closed = Some(error); }
                        RootAllocationTraceRow {
                            work_index,
                            status: "invalid".to_owned(),
                            raw_count: actions.len(),
                            prefix_count: actions.len().min(PREFIX_LIMIT),
                            accepted_count: 0,
                            rejected_count: 0,
                            signature_changed: false,
                            top1_rejected: false,
                            root_revision: revision,
                            raw_native_top1: None,
                            core_pre_rescue_top1: None,
                            native_draw_index: None,
                            local_ablation: None,
                            detail_policy: "none".to_owned(),
                            detail_saved: false,
                            candidate_details: Vec::new(),
                            rank_churn: 0,
                            prefix_entrant_count: 0,
                            visit_concentration: None,
                            error: Some(format!("{error:?}")),
                        }
                    }
                }
            }
        };
        if let Some(observation) = observation {
            observation.sink().push(row);
        }
        *self.pending_draw.lock() = pending;
        if let Some(error) = fail_closed {
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn record_native_draw(&self, draw_index: usize) {
        let pending = self.pending_draw.lock().take();
        let Some(pending) = pending else { return; };
        let ablation = pending.view.local_ablation(draw_index);
        let details = (ablation.acceptance_changed
            || ablation.generic_changed
            || ablation.conversion_changed
            || ablation.composed_route_changed)
            .then(|| candidate_details(&pending.view));
        self.counters.root_draws.fetch_add(1, Ordering::AcqRel);
        let mut visits = self.root_visits.lock();
        let count = visits.entry(draw_index).or_insert(0);
        *count = count.saturating_add(1);
        let total = self.counters.root_draws.load(Ordering::Acquire);
        let concentration = visits.values().copied().max().unwrap_or(0) as f64 / total.max(1) as f64;
        if let Some(observation) = self.observation.lock().as_ref() {
            observation.sink().update_last_draw(
                pending.work_index,
                draw_index,
                ablation,
                concentration,
                details,
            );
        }
    }

    pub(crate) fn root_index_for_select(&self, native_index: usize) -> Result<usize, CompatError> {
        if self.allocation_mode != AllocationMode::PermutationV1 {
            return Ok(native_index);
        }
        let pending = self.pending_draw.lock();
        let pending = pending.as_ref().ok_or(CompatError::RootAllocationBindingMismatch)?;
        let mapped = pending
            .view
            .selected_index(native_index)
            .ok_or(CompatError::RootAllocationBindingMismatch)?;
        self.counters.root_objective_used_for_select.fetch_add(1, Ordering::AcqRel);
        Ok(mapped)
    }

    pub(crate) fn context(&self) -> &PublicRootLockContext {
        &self.context
    }

    pub(crate) fn allocation_mode(&self) -> AllocationMode {
        self.allocation_mode
    }

    pub(crate) fn uses_root_values(&self) -> bool {
        self.allocation_mode == AllocationMode::RootValueV1
    }

    pub(crate) fn root_value_assignments(&self) -> Result<Vec<(Placement, f64, i32)>, CompatError> {
        if !self.uses_root_values() {
            return Ok(Vec::new());
        }
        let view = self.root_view.lock();
        let Some(view) = view.as_ref() else { return Ok(Vec::new()); };
        view.facts
            .iter()
            .map(|facts| {
                let score = facts.ranked.selection_score;
                score.is_finite()
                    .then_some((facts.action, score, facts.ranked.cc2_rank))
                    .ok_or(CompatError::NonFiniteFeature)
            })
            .collect()
    }

    /// Build or refresh the request-local root view without touching the DAG.
    /// OFF callers may use this seam for shadow/measurement, while the root
    /// draw remains native.
    pub(crate) fn prepare_root_view_from_native(
        &self,
        native: &[(Placement, f32)],
    ) -> Result<Option<RootPrefixView>, CompatError> {
        if native.is_empty() {
            return Ok(None);
        }
        let actions: Vec<Placement> = native.iter().map(|(action, _)| *action).collect();
        let k = actions.len().min(PREFIX_LIMIT);
        let revision = self.completed_selections.load(Ordering::Acquire);
        self.counters.native_snapshot_reads.fetch_add(1, Ordering::AcqRel);
        let mut cache = self.facts_cache.lock();
        let mut identities = Vec::with_capacity(k);
        for action in actions.iter().take(k) {
            if let Some(identity) = cache.identity(action) {
                identities.push(Arc::clone(identity));
                self.counters.facts_cache_hits.fetch_add(1, Ordering::AcqRel);
            } else {
                let value = serde_json::to_value(action).map_err(|_| CompatError::Cs1)?;
                let identity = Arc::<str>::from(super::canonicalize(&value).map_err(|_| CompatError::Cs1)?);
                cache.remember_identity(*action, Arc::clone(&identity));
                identities.push(identity);
                self.counters.identity_canonicalizations.fetch_add(1, Ordering::AcqRel);
            }
        }
        let binding = RootSnapshotBinding::new(
            self.request_epoch,
            self.public_context_digest,
            revision,
            &actions,
        );
        let signature = PrefixViewSignature::new_with_mode(&binding, &identities, self.allocation_mode.prefix_mode());
        let mut current = self.root_view.lock();
        self.counters.signature_comparisons.fetch_add(1, Ordering::AcqRel);
        if let Some(view) = current.as_mut() {
            if view.signature == signature {
                if view.rebind(binding.clone()).is_ok() {
                    self.counters.revision_rebinds.fetch_add(1, Ordering::AcqRel);
                    return Ok(Some(view.clone()));
                }
                // The exact binding guard rejects a stale prefix even when the
                // identity signature collides.  Drop only that reusable view
                // and rebuild from the current snapshot; never carry it into a
                // root draw.
                current.take();
            }
        }
        self.counters.signature_changes.fetch_add(1, Ordering::AcqRel);
        let options = &self.decision_stage.options;
        if !self.context.public_profile
            && (self.context.state.incoming.pending_rows != 0
                || self.context.state.incoming.due_this_lock_rows != 0)
        {
            return Err(CompatError::InvalidIncoming);
        }
        let move_values: Vec<Value> = actions
            .iter()
            .take(k)
            .map(|action| serde_json::to_value(action).map_err(|_| CompatError::Cs1))
            .collect::<Result<_, _>>()?;
        let current_piece = self
            .context
            .state
            .pieces
            .current
            .as_deref()
            .ok_or(CompatError::PieceUnavailable)?;
        let interrupt = Cell::new(None::<CompatError>);
        let prefix = build_f14_prefix(
            &move_values,
            current_piece,
            &PrefixOptions {
                candidate_limit: options.candidate_limit,
                allow_complete_returned_prefix: options.allow_complete_returned_prefix,
                unverifiable: options.unverifiable,
            },
            |rank, _, requested| {
                if let Err(error) = interrupted(Some(&self.context.limits)) {
                    interrupt.set(Some(error));
                    return Err("interrupted".into());
                }
                let action = actions[rank];
                if let Some(facts) = cache.get(&action) {
                    self.counters.facts_cache_hits.fetch_add(1, Ordering::AcqRel);
                    return Ok(facts.placement.clone());
                }
                if let Some(rejected) = cache.get_rejected(&action) {
                    self.counters.facts_cache_hits.fetch_add(1, Ordering::AcqRel);
                    return Err(rejected.reason.clone());
                }
                let witnessed = self.context.index.get(&final_pose_key(requested));
                let (placement, last_rotation, kick_id, kick_offset) = if let Some(witness) = witnessed {
                    (
                        witness.placement.clone(),
                        witness.last_rotation,
                        witness.kick_id.clone(),
                        witness.kick_offset,
                    )
                } else {
                    (requested.clone(), false, None, None)
                };
                match project_lock(
                    &self.context.state,
                    &placement,
                    last_rotation,
                    kick_id.as_deref(),
                    kick_offset,
                    self.context.state.combo,
                    self.context.state.b2b,
                    self.context.multiplier,
                ) {
                    Ok(_) => Ok(placement),
                    Err(error) => {
                        cache.insert_rejected(RootRejectedFacts {
                            raw_index: rank,
                            action,
                            identity: Arc::clone(&identities[rank]),
                            reason: format!("{error:?}"),
                        });
                        self.counters.distinct_entrants.fetch_add(1, Ordering::AcqRel);
                        self.counters.facts_cache_misses.fetch_add(1, Ordering::AcqRel);
                        Err(format!("{error:?}"))
                    }
                }
            },
        )?;
        if let Some(error) = interrupt.take() {
            return Err(error);
        }
        let candidate_context = CandidateContext {
            state: &self.context.state,
            options,
            multiplier: self.context.multiplier,
            limits: Some(&self.context.limits),
            public_profile: self.context.public_profile,
            post_spin_policy: options.post_spin_policy,
        };
        let mut accepted = Vec::with_capacity(prefix.accepted.len());
        for candidate in &prefix.accepted {
            let index = candidate.cc2_rank as usize;
            if index >= k {
                return Err(CompatError::RootAllocationBindingMismatch);
            }
            let identity = Arc::clone(&identities[index]);
            let resolved = if let Some(cached) = cache.get(&actions[index]).cloned() {
                self.counters.facts_cache_hits.fetch_add(1, Ordering::AcqRel);
                let mut rebased = cached;
                rebased.rebase_snapshot(index, actions[index], identity);
                rebased
            } else {
                self.counters.facts_cache_misses.fetch_add(1, Ordering::AcqRel);
                self.counters.witness_lookups.fetch_add(1, Ordering::AcqRel);
                let witnessed = self.context.index.get(&final_pose_key(&candidate.placement));
                let evaluation = evaluate_f14_candidate(&candidate_context, candidate, witnessed)?;
                self.counters.conversion_compute_calls.fetch_add(1, Ordering::AcqRel);
                let mut ranked = evaluation.ranked_input;
                ranked.selection_score = super::selection_score(
                    ranked.s2_score,
                    ranked.conversion.units,
                    index as i32,
                );
                let facts = RootCandidateFacts {
                    raw_index: index,
                    action: actions[index],
                    identity,
                    placement: evaluation.witness.placement.clone(),
                    ranked,
                };
                cache.insert(facts.clone());
                self.counters.distinct_entrants.fetch_add(1, Ordering::AcqRel);
                facts
            };
            accepted.push(resolved);
        }
        let rejected: Vec<u32> = prefix
            .rejected
            .iter()
            .map(|candidate| candidate.cc2_rank as u32)
            .collect();
        let view = RootPrefixView::build_with_mode(
            binding,
            identities,
            accepted,
            rejected,
            self.allocation_mode.prefix_mode(),
        )?;
        self.counters.objective_rebuilds.fetch_add(1, Ordering::AcqRel);
        self.counters.permutation_materializations.fetch_add(1, Ordering::AcqRel);
        *current = Some(view.clone());
        self.counters.facts_cache_entries.store(cache.len() as u64, Ordering::Release);
        self.counters.cache_bytes_estimate.store(cache.estimated_bytes() as u64, Ordering::Release);
        Ok(Some(view))
    }

    pub(crate) fn complete_work<F>(
        &self,
        stats: &Statistics,
        build_native: F,
    ) -> Result<(), CompatError>
    where
        F: FnOnce() -> Vec<(Placement, f32)>,
    {
        let completed_selections = self
            .completed_selections
            .fetch_add(stats.selections, Ordering::AcqRel)
            .saturating_add(stats.selections);
        let nodes = self
            .completed_nodes
            .fetch_add(stats.nodes, Ordering::AcqRel)
            .saturating_add(stats.nodes);
        if completed_selections < self.selection_limit {
            return Ok(());
        }
        self.publish_decision(completed_selections, nodes, build_native)
    }

    /// Publish the decision for the selections completed so far. A time budget
    /// ends here when its host deadline passes before the selection cap.
    pub(crate) fn complete_early<F>(&self, build_native: F) -> Result<(), CompatError>
    where
        F: FnOnce() -> Vec<(Placement, f32)>,
    {
        if !matches!(*self.outcome.lock(), OutcomeCell::Pending) {
            return Ok(());
        }
        let completed_selections = self.completed_selections.load(Ordering::Acquire);
        let nodes = self.completed_nodes.load(Ordering::Acquire);
        self.publish_decision(completed_selections, nodes, build_native)
    }

    fn publish_decision<F>(
        &self,
        completed_selections: u64,
        nodes: u64,
        build_native: F,
    ) -> Result<(), CompatError>
    where
        F: FnOnce() -> Vec<(Placement, f32)>,
    {
        let native = build_native();
        if native.is_empty() {
            self.publish(FinishedRootOutcome::NoCandidates {
                completed_selections,
                nodes,
            });
            return Ok(());
        }
        let (native_moves, native_values): (Vec<_>, Vec<_>) = native.into_iter().unzip();
        let move_values = match native_moves
            .iter()
            .map(|placement| serde_json::to_value(placement).map_err(|_| CompatError::Cs1))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(values) => values,
            Err(error) => {
                self.publish(FinishedRootOutcome::Failed(error));
                return Err(error);
            }
        };
        let (selection, post_stage_counters) = match self
            .decision_stage
            .decide(&self.context, &move_values)
        {
            Ok(result) => result,
            Err(error) => {
                self.publish(FinishedRootOutcome::Failed(error));
                return Err(error);
            }
        };
        let identities = match move_values
            .iter()
            .map(|value| super::canonicalize(value).map_err(|_| CompatError::Cs1))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(identities) => identities,
            Err(error) => {
                self.publish(FinishedRootOutcome::Failed(error));
                return Err(error);
            }
        };
        self.publish(FinishedRootOutcome::Decided(FinishedRootDecision {
            binding: SnapshotBinding {
                request_epoch: self.request_epoch,
                public_context_digest: self.public_context_digest,
                returned_count: identities.len(),
                returned_identity_digest: returned_identity_digest(&identities),
            },
            root_revision: completed_selections,
            completed_selections,
            nodes,
            native_moves,
            native_values,
            selection,
            counters: self.counters.snapshot(),
            post_stage_counters,
        }));
        Ok(())
    }

    pub(crate) fn publish_root_failure(&self, error: CompatError) {
        self.publish(FinishedRootOutcome::Failed(error));
    }

    fn publish(&self, outcome: FinishedRootOutcome) {
        let mut slot = self.outcome.lock();
        if matches!(*slot, OutcomeCell::Pending) {
            *slot = OutcomeCell::Published(outcome);
        }
    }

    pub(crate) fn take_outcome(&self) -> Result<Option<FinishedRootOutcome>, CompatError> {
        let mut slot = self.outcome.lock();
        match std::mem::replace(&mut *slot, OutcomeCell::Taken) {
            OutcomeCell::Pending => {
                *slot = OutcomeCell::Pending;
                Ok(None)
            }
            OutcomeCell::Published(outcome) => Ok(Some(outcome)),
            OutcomeCell::Taken => Err(CompatError::RootOutcomeAlreadyTaken),
        }
    }

    pub(crate) fn counters_snapshot(&self) -> CoreDecisionCountersSnapshot {
        self.counters.snapshot()
    }
}

// Kept only for the byte-compatibility test that reproduces the removed
// job/transport snapshot handoff; production consumes FinishedRootDecision.
#[cfg(test)]
#[derive(Clone, Debug, PartialEq)]
pub struct CoreRankedSnapshot {
    pub binding: SnapshotBinding,
    pub prefix: ComposedRankingPrefix,
}

#[cfg(test)]
impl CoreRankedSnapshot {
    pub fn epoch(&self) -> u64 {
        self.binding.request_epoch
    }
}

pub const RETURNED_IDENTITIES_TAG: &[u8] = b"f14-returned-identities/v1\0";
pub const PUBLIC_CONTEXT_TAG: &[u8] = b"f14-public-context/v1\0";

pub fn returned_identity_digest(identities: &[String]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(RETURNED_IDENTITIES_TAG);
    hasher.update((identities.len() as u64).to_le_bytes());
    for identity in identities {
        let bytes = identity.as_bytes();
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    hasher.finalize().into()
}

pub fn write_sorted_compact(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_writer(&mut *out, value).expect("serde_json scalar");
        }
        Value::Array(items) => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_sorted_compact(item, out);
            }
            out.push(b']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&str, &Value)> = map
                .iter()
                .map(|(key, value)| (key.as_str(), value))
                .collect();
            write_sorted_object_entries(&mut entries, out);
        }
    }
}

pub fn write_sorted_object_entries(entries: &mut [(&str, &Value)], out: &mut Vec<u8>) {
    entries.sort_by(|left, right| left.0.cmp(right.0));
    out.push(b'{');
    for (index, (key, value)) in entries.iter().enumerate() {
        if index > 0 {
            out.push(b',');
        }
        serde_json::to_writer(&mut *out, key).expect("json key");
        out.push(b':');
        write_sorted_compact(value, out);
    }
    out.push(b'}');
}

pub fn sorted_compact_json(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    write_sorted_compact(value, &mut out);
    out
}

pub fn public_context_digest(document: &Value) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(PUBLIC_CONTEXT_TAG);
    hasher.update(sorted_compact_json(document));
    hasher.finalize().into()
}

pub fn snapshot_binding(
    request_epoch: u64,
    public_context: &Value,
    identities: &[String],
) -> SnapshotBinding {
    SnapshotBinding {
        request_epoch,
        public_context_digest: public_context_digest(public_context),
        returned_count: identities.len(),
        returned_identity_digest: returned_identity_digest(identities),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct F14Selection {
    pub ranked: Vec<RankedCandidate>,
    pub selected: F14SelectedCandidate,
    pub rescued: bool,
    pub returned_candidate_count: usize,
    pub generated_candidates: usize,
    pub prefix_facts: Vec<F14SelectedCandidate>,
}

#[derive(Clone, Debug, PartialEq)]
struct EvaluatedLock {
    cells: String,
    lines: u32,
    spin: &'static str,
    perfect_clear: bool,
}

pub fn resolve_f14_multiplier(time: &F14SelectorTime) -> Result<f64, CompatError> {
    if time.fidelity != "exact" {
        return Err(CompatError::InvalidTime);
    }
    if MULTIPLIER_INCREASE != 0.0 && time.frame_semantics != "engine-frame" {
        return Err(CompatError::InvalidTime);
    }
    if MULTIPLIER_INCREASE == 0.0 {
        return Ok(MULTIPLIER_BASE);
    }
    let mut value = MULTIPLIER_BASE;
    for step in 1..=time.logical_frame {
        if step > MULTIPLIER_MARGIN {
            value += MULTIPLIER_INCREASE / 60.0;
        }
    }
    Ok(value)
}

fn occupied(cells: &str, width: i32, height: i32, x: i32, y: i32) -> bool {
    if x < 0 || y < 0 || x >= width || y >= height {
        return true;
    }
    cells.as_bytes()[(y * width + x) as usize] != b'_'
}

fn blocks_of(
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    piece: &str,
    rotation: &str,
    x: i32,
    y: i32,
) -> Result<Vec<(i32, i32)>, CompatError> {
    cells_table
        .get(&(piece.to_string(), rotation.to_string()))
        .map(|blocks| blocks.iter().map(|(bx, by)| (bx + x, by + y)).collect())
        .ok_or(CompatError::UnsupportedOrientation)
}

fn detect_t_corner(
    cells: &str,
    width: i32,
    height: i32,
    placement: &CanonicalPlacement,
) -> &'static str {
    let pivot_x = placement.x + 1;
    let pivot_y = placement.y + 1;
    let top_left = occupied(cells, width, height, pivot_x - 1, pivot_y + 1);
    let top_right = occupied(cells, width, height, pivot_x + 1, pivot_y + 1);
    let bottom_left = occupied(cells, width, height, pivot_x - 1, pivot_y - 1);
    let bottom_right = occupied(cells, width, height, pivot_x + 1, pivot_y - 1);
    let count = [top_left, top_right, bottom_left, bottom_right]
        .into_iter()
        .filter(|corner| *corner)
        .count();
    if count < 3 {
        return "none";
    }
    let front = match placement.rotation.as_str() {
        "spawn" => [top_left, top_right],
        "right" => [top_right, bottom_right],
        "reverse" => [bottom_left, bottom_right],
        "left" => [top_left, bottom_left],
        _ => return "none",
    };
    let front_count = front.into_iter().filter(|corner| *corner).count();
    if front_count == 2 {
        "normal"
    } else {
        "mini"
    }
}

fn is_all_spin(cells: &str, width: i32, height: i32, blocks: &[(i32, i32)]) -> bool {
    [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().all(|&(dx, dy)| {
        blocks
            .iter()
            .any(|&(x, y)| occupied(cells, width, height, x + dx, y + dy))
    })
}

pub fn detect_f14_spin(
    cells: &str,
    width: i32,
    height: i32,
    placement: &CanonicalPlacement,
    last_rotation: bool,
    kick_id: Option<&str>,
    kick_offset: Option<(i32, i32)>,
    blocks: &[(i32, i32)],
) -> &'static str {
    if !last_rotation {
        return "none";
    }
    let t_spin = if placement.piece == "T" {
        let corner = detect_t_corner(cells, width, height, placement);
        if corner == "mini" && is_fin_or_tst(kick_id, kick_offset) {
            "normal"
        } else {
            corner
        }
    } else {
        "none"
    };
    let all = if is_all_spin(cells, width, height, blocks) {
        "mini"
    } else {
        "none"
    };
    if spin_rank(t_spin) >= spin_rank(all) {
        t_spin
    } else {
        all
    }
}

fn evaluate_f14_lock(
    cells: &str,
    width: i32,
    height: i32,
    placement: &CanonicalPlacement,
    last_rotation: bool,
    kick_id: Option<&str>,
    kick_offset: Option<(i32, i32)>,
) -> Result<EvaluatedLock, CompatError> {
    let cells_table = &geometry().1;
    let blocks = blocks_of(
        cells_table,
        &placement.piece,
        &placement.rotation,
        placement.x,
        placement.y,
    )?;
    if blocks
        .iter()
        .any(|&(x, y)| occupied(cells, width, height, x, y))
    {
        return Err(CompatError::IllegalPlacement);
    }
    if !blocks
        .iter()
        .any(|&(x, y)| occupied(cells, width, height, x, y - 1))
    {
        return Err(CompatError::IllegalPlacement);
    }
    let spin = detect_f14_spin(
        cells,
        width,
        height,
        placement,
        last_rotation,
        kick_id,
        kick_offset,
        &blocks,
    );
    let colored: Vec<(i32, i32, char)> = blocks
        .iter()
        .map(|&(x, y)| (x, y, placement.piece.chars().next().unwrap()))
        .collect();
    let (after, lines, perfect_clear) = apply_f14_lock_blocks(cells, width, height, &colored)?;
    Ok(EvaluatedLock {
        cells: after,
        lines,
        spin,
        perfect_clear,
    })
}

fn available_piece(pieces: &F14Pieces, used_hold: bool) -> Result<String, CompatError> {
    if used_hold && !pieces.hold_available {
        return Err(CompatError::HoldUnavailable);
    }
    let piece = if !used_hold {
        pieces.current.clone()
    } else {
        pieces
            .hold
            .clone()
            .or_else(|| pieces.known.first().cloned())
    };
    piece.ok_or(CompatError::PieceUnavailable)
}

fn reach_pieces(pieces: &F14Pieces) -> ReachPieceState {
    ReachPieceState {
        current: pieces.current.clone(),
        hold: pieces.hold.clone(),
        known: pieces.known.clone(),
        hold_available: pieces.hold_available,
    }
}

fn spin_index(
    cells: &str,
    width: i32,
    height: i32,
    pieces: &F14Pieces,
    limits: Option<&F14RuntimeLimits>,
    public_profile: bool,
) -> Result<HashMap<String, ReachPlacement>, CompatError> {
    interrupted(limits)?;
    let (tables, cells_table) = geometry();
    let generate = if public_profile {
        generate_public_reachable
    } else {
        generate_reachable_a
    };
    let reachable = generate(
        cells,
        width,
        height,
        &reach_pieces(pieces),
        cells_table,
        tables,
    )?;
    let mut by_pose: HashMap<String, (i32, ReachPlacement)> = HashMap::new();
    for candidate in reachable {
        interrupted(limits)?;
        if !candidate.last_rotation {
            continue;
        }
        let Ok(eval) = evaluate_f14_lock(
            cells,
            width,
            height,
            &candidate.placement,
            candidate.last_rotation,
            candidate.kick_id.as_deref(),
            candidate.kick_offset,
        ) else {
            continue;
        };
        if eval.spin == "none" {
            continue;
        }
        let pose = final_pose_key(&candidate.placement);
        let rank = spin_rank(eval.spin);
        match by_pose.get(&pose) {
            Some((best, _)) if *best >= rank => {}
            _ => {
                by_pose.insert(pose, (rank, candidate));
            }
        }
    }
    Ok(by_pose
        .into_iter()
        .map(|(pose, (_, placement))| (pose, placement))
        .collect())
}

fn witness_tsd(
    lock_cells: &str,
    width: i32,
    height: i32,
    pieces: &F14Pieces,
    limits: Option<&F14RuntimeLimits>,
    public_profile: bool,
) -> Result<super::TsdResult, CompatError> {
    interrupted(limits)?;
    if pieces.current.as_deref() != Some("T")
        && !(pieces.hold_available && pieces.hold.as_deref() == Some("T"))
    {
        return Ok(super::TsdResult {
            t_available: false,
            scanned: 0,
            witnessed: false,
        });
    }
    let (tables, cells_table) = geometry();
    let generate = if public_profile {
        generate_public_reachable
    } else {
        generate_reachable_a
    };
    let reachable = generate(
        lock_cells,
        width,
        height,
        &reach_pieces(pieces),
        cells_table,
        tables,
    )?;
    let t_placements: Vec<_> = reachable
        .into_iter()
        .filter(|placement| placement.placement.piece == "T")
        .take(64)
        .collect();
    let mut scanned = 0u32;
    for candidate in &t_placements {
        interrupted(limits)?;
        scanned += 1;
        let Ok(eval) = evaluate_f14_lock(
            lock_cells,
            width,
            height,
            &candidate.placement,
            candidate.last_rotation,
            candidate.kick_id.as_deref(),
            candidate.kick_offset,
        ) else {
            continue;
        };
        if eval.spin == "normal" && eval.lines == 2 {
            return Ok(super::TsdResult {
                t_available: true,
                scanned,
                witnessed: true,
            });
        }
    }
    Ok(super::TsdResult {
        t_available: true,
        scanned,
        witnessed: false,
    })
}

fn project_lock(
    state: &F14PublicState,
    placement: &CanonicalPlacement,
    last_rotation: bool,
    kick_id: Option<&str>,
    kick_offset: Option<(i32, i32)>,
    combo: u32,
    b2b: u32,
    multiplier: f64,
) -> Result<(EvaluatedLock, F14Pieces, FeatureProjection, f64), CompatError> {
    available_piece(&state.pieces, placement.used_hold).and_then(|piece| {
        if piece != placement.piece {
            Err(CompatError::PieceUnavailable)
        } else {
            Ok(())
        }
    })?;
    let eval = evaluate_f14_lock(
        &state.board_cells,
        state.width,
        state.height,
        placement,
        last_rotation,
        kick_id,
        kick_offset,
    )?;
    let pieces_after = advance_f14_pieces(&state.pieces, placement.used_hold)?;
    let chain = advance_f14_chain(
        combo,
        b2b,
        eval.lines,
        eval.spin,
        eval.perfect_clear,
        PC_B2B_BONUS,
    )?;
    let surge = calculate_f14_surge(
        chain.broken_b2b_count,
        Some((CHARGING_AT, CHARGING_BASE)),
        multiplier,
    )?;
    let amount = advance_f14_amount_only(
        state.incoming,
        &F14LockPublic {
            lines: eval.lines,
            spin: eval.spin.to_string(),
            perfect_clear: eval.perfect_clear,
            combo_after: chain.combo_after,
            b2b_after: chain.b2b_after,
            b2b_before: b2b,
        },
    )?;
    let board = LockBoardView {
        fidelity: "exact",
        width: state.width,
        height: state.height,
        cells: &eval.cells,
    };
    let occupied = occupied_height(board)?;
    let visible_margin = f64::from(state.visible_height) - f64::from(occupied);
    let tank = f64::from(amount.tank_rows);
    let remaining = f64::from(amount.remaining_rows);
    let topped = occupied as i32 + i32::from(amount.tank_rows) > state.visible_height;
    let projection = FeatureProjection {
        amount_topped_out: topped,
        remaining_rows: remaining,
        tank_rows: tank,
        visible_margin_after_lock: visible_margin,
        outgoing_before_cancel: f64::from(amount.outgoing_before_cancel),
        outgoing_after_cancel: f64::from(amount.outgoing_after_cancel),
        cancelled_rows: f64::from(amount.cancelled_rows),
        combo_after: f64::from(chain.combo_after),
        b2b_after: f64::from(chain.b2b_after),
        surge_sent: f64::from(surge.amount),
    };
    let solvency = visible_margin - tank - remaining;
    Ok((eval, pieces_after, projection, solvency))
}

// Test-only reference entries: reproduce the earlier transport route for byte comparison.
#[cfg(test)]
pub fn select_f14_amount_only(
    state: &F14PublicState,
    moves: &[Value],
    options: &F14SelectOptions,
) -> Result<F14Selection, CompatError> {
    select_f14_amount_only_limited(state, moves, options, None)
}

// Test-only reference entry: reproduce the earlier transport route for byte comparison.
#[cfg(test)]
pub fn select_f14_amount_only_limited(
    state: &F14PublicState,
    moves: &[Value],
    options: &F14SelectOptions,
    limits: Option<&F14RuntimeLimits>,
) -> Result<F14Selection, CompatError> {
    select_f14_profile_limited(state, moves, options, limits, false)
}

/// Test-only reference entry for the pre-section-22 transport route.
/// It is retained solely for byte comparison against the core-owned decision.
#[cfg(test)]
pub fn select_f14_public_limited(
    state: &F14PublicState,
    moves: &[Value],
    options: &F14SelectOptions,
    limits: Option<&F14RuntimeLimits>,
) -> Result<F14Selection, CompatError> {
    select_f14_profile_limited(state, moves, options, limits, true)
}

/// The root priority uses only the public one-lock pressure projection, without ranking,
/// conversion counterfactuals or rescue. This is still the F14 amount model.
pub(crate) struct PublicRootLockContext {
    state: Arc<F14PublicState>,
    multiplier: f64,
    index: HashMap<String, ReachPlacement>,
    limits: F14RuntimeLimits,
    public_profile: bool,
    core_counters: Option<Arc<CoreDecisionCounters>>,
}

impl PublicRootLockContext {
    pub(crate) fn new(
        state: &F14PublicState,
        limits: &F14RuntimeLimits,
    ) -> Result<Self, CompatError> {
        interrupted(Some(limits))?;
        if state.width != 10 || state.height != 40 || state.visible_height != VISIBLE_HEIGHT {
            return Err(CompatError::InvalidLockBoard);
        }
        if state.pieces.current.is_none() || !state.pieces.hold_available {
            return Err(CompatError::PieceUnavailable);
        }
        Self::from_checked(Arc::new(state.clone()), limits.clone(), true)
    }

    /// Ranking-owned public context. Built before search; `new()` stays public-only.
    pub(crate) fn for_profile(
        state: &F14PublicState,
        limits: &F14RuntimeLimits,
        public_profile: bool,
    ) -> Result<Self, CompatError> {
        interrupted(Some(limits))?;
        if state.width != 10 || state.height != 40 || state.visible_height != VISIBLE_HEIGHT {
            return Err(CompatError::InvalidLockBoard);
        }
        if state.pieces.current.is_none() {
            return Err(CompatError::PieceUnavailable);
        }
        Self::from_checked(Arc::new(state.clone()), limits.clone(), public_profile)
    }

    pub(crate) fn owned(
        state: Arc<F14PublicState>,
        limits: F14RuntimeLimits,
        public_profile: bool,
    ) -> Result<Self, CompatError> {
        interrupted(Some(&limits))?;
        if state.width != 10 || state.height != 40 || state.visible_height != VISIBLE_HEIGHT {
            return Err(CompatError::InvalidLockBoard);
        }
        if state.pieces.current.is_none() {
            return Err(CompatError::PieceUnavailable);
        }
        Self::from_checked(state, limits, public_profile)
    }

    fn from_checked(
        state: Arc<F14PublicState>,
        limits: F14RuntimeLimits,
        public_profile: bool,
    ) -> Result<Self, CompatError> {
        let multiplier = resolve_f14_multiplier(&state.time)?;
        let index = spin_index(
            &state.board_cells,
            state.width,
            state.height,
            &state.pieces,
            Some(&limits),
            public_profile,
        )?;
        Ok(Self {
            state,
            multiplier,
            index,
            limits,
            public_profile,
            core_counters: None,
        })
    }

    pub(crate) fn with_core_counters(mut self, counters: Arc<CoreDecisionCounters>) -> Self {
        self.core_counters = Some(counters);
        self
    }

    pub(crate) fn state(&self) -> &F14PublicState {
        self.state.as_ref()
    }

    pub(crate) fn compose_ranking(
        &self,
        moves: &[Value],
        options: &F14SelectOptions,
    ) -> Result<ComposedRankingPrefix, CompatError> {
        compose_f14_ranking_with_index(
            self.state.as_ref(),
            moves,
            options,
            Some(&self.limits),
            self.public_profile,
            self.multiplier,
            &self.index,
            self.core_counters.as_deref(),
        )
    }

    pub(crate) fn inside_margin(&self, mv: crate::data::Placement) -> Result<bool, CompatError> {
        interrupted(Some(&self.limits))?;
        // Reuse the established CC2 origin/HOLD mapping at the typed boundary.
        let raw = serde_json::to_value(mv).map_err(|_| CompatError::Cs1)?;
        let placement = super::prefix::cc2_move_to_canonical_placement(
            self.state
                .as_ref()
                .pieces
                .current
                .as_deref()
                .ok_or(CompatError::PieceUnavailable)?,
            &super::prefix::gui_location_from_value(&raw)?,
        )?;
        let witness = self.index.get(&final_pose_key(&placement));
        let (_, _, amount, margin) = project_lock(
            self.state.as_ref(),
            witness.map_or(&placement, |w| &w.placement),
            witness.is_some_and(|w| w.last_rotation),
            witness.and_then(|w| w.kick_id.as_deref()),
            witness.and_then(|w| w.kick_offset),
            self.state.combo,
            self.state.b2b,
            self.multiplier,
        )?;
        // project_lock's margin is exactly 20 - h - t - r (no virtual holes).
        if !margin.is_finite() {
            return Err(CompatError::InvalidSolvency);
        }
        Ok(!amount.amount_topped_out && margin >= 0.0)
    }
}

// Keep candidate arithmetic typed and ordered independently of prefix/rank/rescue.
// A and B share this function but retain their distinct witness enumeration.
struct CandidateContext<'a> {
    state: &'a F14PublicState,
    options: &'a F14SelectOptions,
    multiplier: f64,
    limits: Option<&'a F14RuntimeLimits>,
    public_profile: bool,
    post_spin_policy: PostSpinPolicy,
}

struct CandidateEvaluation {
    ranked_input: RankedCandidate,
    witness: ReachPlacement,
    spin: &'static str,
    lines: u32,
    ren_combat_gain: f64,
    release_value: f64,
    setup_witnessed: bool,
    combo_after: f64,
    b2b_after: f64,
    surge_sent: f64,
    cancelled: f64,
}

pub struct ConversionLockFacts {
    pub conversion: Conversion,
    pub ren_combat_gain: f64,
    pub release_value: f64,
    pub setup_witnessed: bool,
    pub spin: &'static str,
    pub lines: u32,
    pub cells: String,
    pub pieces_after: super::F14Pieces,
    pub actual: FeatureProjection,
    pub solvency: f64,
    pub placement: CanonicalPlacement,
    pub last_rotation: bool,
    pub kick_index: Option<i32>,
    pub kick_id: Option<String>,
    pub kick_offset: Option<(i32, i32)>,
}

/// Three-projection conversion facts. Does not rank, rescue, or count a selector dispatch.
pub fn conversion_facts_for_lock(
    state: &F14PublicState,
    accepted_placement: &CanonicalPlacement,
    witnessed: Option<&ReachPlacement>,
    limits: Option<&F14RuntimeLimits>,
    public_profile: bool,
    post_spin_policy: PostSpinPolicy,
    multiplier: f64,
) -> Result<ConversionLockFacts, CompatError> {
    let (placement, last_rotation, kick_index, kick_id, kick_offset) =
        if let Some(witness) = witnessed {
            (
                witness.placement.clone(),
                witness.last_rotation,
                witness.kick_index,
                witness.kick_id.clone(),
                witness.kick_offset,
            )
        } else {
            (accepted_placement.clone(), false, None, None, None)
        };
    crate::s2_audit::post_stage_conversion_compute();
    let (eval, pieces_after, actual, solvency) = project_lock(
        state,
        &placement,
        last_rotation,
        kick_id.as_deref(),
        kick_offset,
        state.combo,
        state.b2b,
        multiplier,
    )?;
    let (_, _, no_ren, _) = project_lock(
        state,
        &placement,
        last_rotation,
        kick_id.as_deref(),
        kick_offset,
        0,
        state.b2b,
        multiplier,
    )?;
    let (_, _, withheld, _) = project_lock(
        state,
        &placement,
        last_rotation,
        kick_id.as_deref(),
        kick_offset,
        state.combo,
        0,
        multiplier,
    )?;
    let realised = |projection: &FeatureProjection| {
        projection.outgoing_after_cancel + projection.cancelled_rows
    };
    let ren_combat_gain = realised(&actual) - realised(&no_ren);
    let release_value = realised(&actual) - realised(&withheld);
    let setup_clear =
        (eval.spin == "mini" && eval.lines >= 1) || (eval.spin == "normal" && eval.lines == 1);
    let target = non_t_all_spin_clear(&placement.piece, eval.spin, eval.lines);
    let skip_non_t_witness = post_spin_policy == PostSpinPolicy::NonTSpinPriorOff && target;
    let setup_witnessed = if setup_clear && !skip_non_t_witness {
        if target {
            crate::s2_audit::non_t_setup_witness();
        }
        witness_tsd(
            &eval.cells,
            state.width,
            state.height,
            &pieces_after,
            limits,
            public_profile,
        )?
        .witnessed
    } else {
        false
    };
    let conversion = classify_conversion_for_policy(
        post_spin_policy,
        &placement.piece,
        state.combo,
        actual.combo_after as u32,
        state.b2b,
        actual.b2b_after as u32,
        eval.lines,
        eval.spin,
        actual.cancelled_rows,
        ren_combat_gain,
        setup_witnessed,
        actual.surge_sent as u32,
        release_value,
    )
    .ok_or(CompatError::InvalidSpin)?;
    if target && conversion.branch == ConversionBranch::MiniToTsdB2bBridge {
        crate::s2_audit::non_t_setup_bonus();
    }
    Ok(ConversionLockFacts {
        conversion,
        ren_combat_gain,
        release_value,
        setup_witnessed,
        spin: eval.spin,
        lines: eval.lines,
        cells: eval.cells,
        pieces_after,
        actual,
        solvency,
        placement,
        last_rotation,
        kick_index,
        kick_id,
        kick_offset,
    })
}

/// Teacher-identity shadow. Does not search, rank, or rescue.
pub fn shadow_conversion_facts(
    state: &F14PublicState,
    identities: &[Value],
    limits: Option<&F14RuntimeLimits>,
    public_profile: bool,
) -> Result<Vec<Value>, CompatError> {
    interrupted(limits)?;
    if state.pieces.current.is_none() || !state.pieces.hold_available {
        return Err(CompatError::PieceUnavailable);
    }
    let multiplier = resolve_f14_multiplier(&state.time)?;
    let index = spin_index(
        &state.board_cells,
        state.width,
        state.height,
        &state.pieces,
        limits,
        public_profile,
    )?;
    let current = state
        .pieces
        .current
        .as_deref()
        .ok_or(CompatError::PieceUnavailable)?;
    let mut rows = Vec::with_capacity(identities.len());
    for (order, identity) in identities.iter().enumerate() {
        interrupted(limits)?;
        let identity_value = if identity.is_string() {
            serde_json::from_str(identity.as_str().unwrap()).map_err(|_| CompatError::Cs1)?
        } else {
            identity.clone()
        };
        let location = super::prefix::gui_location_from_value(&identity_value)?;
        let placement = super::prefix::cc2_move_to_canonical_placement(current, &location)?;
        let identity_text = identity
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| identity_value.to_string());
        let witnessed = index.get(&final_pose_key(&placement));
        match conversion_facts_for_lock(
            state,
            &placement,
            witnessed,
            limits,
            public_profile,
            PostSpinPolicy::LegacyF14,
            multiplier,
        ) {
            Ok(facts) => rows.push(serde_json::json!({
                "order": order,
                "identity": identity_text,
                "branch": facts.conversion.branch.as_str(),
                "units": facts.conversion.units,
                "qualifies": facts.conversion.qualifies,
                "renCombatGain": facts.ren_combat_gain,
                "releaseValue": facts.release_value,
                "setupWitnessed": facts.setup_witnessed,
                "comboAfter": facts.actual.combo_after,
                "b2bAfter": facts.actual.b2b_after,
                "lines": facts.lines,
                "spin": facts.spin,
                "cancelled": facts.actual.cancelled_rows,
                "surgeSent": facts.actual.surge_sent,
                "c": crate::f14_compat::ADJUSTMENT_SCALE * facts.conversion.units,
            })),
            Err(error) => rows.push(serde_json::json!({
                "order": order,
                "identity": identity_text,
                "error": format!("{error:?}"),
            })),
        }
    }
    Ok(rows)
}

fn evaluate_f14_candidate(
    context: &CandidateContext<'_>,
    accepted: &AcceptedCandidate,
    witnessed: Option<&ReachPlacement>,
) -> Result<CandidateEvaluation, CompatError> {
    let CandidateContext {
        state,
        options,
        multiplier,
        limits,
        public_profile,
        post_spin_policy,
    } = *context;
    let facts = conversion_facts_for_lock(
        state,
        &accepted.placement,
        witnessed,
        limits,
        public_profile,
        post_spin_policy,
        multiplier,
    )?;
    let board = LockBoardView {
        fidelity: "exact",
        width: state.width,
        height: state.height,
        cells: &facts.cells,
    };
    let features = extract_amount_only_decision_features(board, facts.actual)?;
    let s2_score = score_evaluation_features(&features, &options.weights)?;
    // Keep InvalidSolvency after scoring, matching the pre-extraction order.
    // solvency is an integer-derived f64 difference and is not observed non-finite.
    if !facts.solvency.is_finite() {
        return Err(CompatError::InvalidSolvency);
    }
    let solvent = !facts.actual.amount_topped_out && facts.solvency >= 0.0;
    let ranked_input = RankedCandidate {
        cc2_rank: accepted.cc2_rank,
        identity: accepted.identity.clone(),
        s2_score,
        conversion: facts.conversion,
        solvency: facts.solvency,
        solvent,
        selection_score: 0.0,
    };
    Ok(CandidateEvaluation {
        ranked_input,
        witness: ReachPlacement {
            placement: facts.placement,
            last_rotation: facts.last_rotation,
            kick_index: facts.kick_index,
            kick_id: facts.kick_id,
            kick_offset: facts.kick_offset,
        },
        spin: facts.spin,
        lines: facts.lines,
        ren_combat_gain: facts.ren_combat_gain,
        release_value: facts.release_value,
        setup_witnessed: facts.setup_witnessed,
        combo_after: facts.actual.combo_after,
        b2b_after: facts.actual.b2b_after,
        surge_sent: facts.actual.surge_sent,
        cancelled: facts.actual.cancelled_rows,
    })
}

/// Budget-complete F14 ranking composer. Does not count a legacy selector dispatch or rescue.
pub fn compose_f14_ranking(
    state: &F14PublicState,
    moves: &[Value],
    options: &F14SelectOptions,
    limits: Option<&F14RuntimeLimits>,
    public_profile: bool,
) -> Result<ComposedRankingPrefix, CompatError> {
    interrupted(limits)?;
    if state.width != 10 || state.height != 40 || state.visible_height != VISIBLE_HEIGHT {
        return Err(CompatError::InvalidLockBoard);
    }
    if state.pieces.current.is_none() {
        return Err(CompatError::PieceUnavailable);
    }
    let multiplier = resolve_f14_multiplier(&state.time)?;
    let index = spin_index(
        &state.board_cells,
        state.width,
        state.height,
        &state.pieces,
        limits,
        public_profile,
    )?;
    compose_f14_ranking_with_index(
        state,
        moves,
        options,
        limits,
        public_profile,
        multiplier,
        &index,
        None,
    )
}

fn compose_f14_ranking_with_index(
    state: &F14PublicState,
    moves: &[Value],
    options: &F14SelectOptions,
    limits: Option<&F14RuntimeLimits>,
    public_profile: bool,
    multiplier: f64,
    index: &HashMap<String, ReachPlacement>,
    core_counters: Option<&CoreDecisionCounters>,
) -> Result<ComposedRankingPrefix, CompatError> {
    interrupted(limits)?;
    if let Some(counters) = core_counters {
        counters.ranking_compose_calls.fetch_add(1, Ordering::AcqRel);
    }
    if !public_profile
        && (state.incoming.pending_rows != 0 || state.incoming.due_this_lock_rows != 0)
    {
        // Profile A only. Non-zero incoming is a different oracle.
        return Err(CompatError::InvalidIncoming);
    }
    let current = state
        .pieces
        .current
        .as_deref()
        .ok_or(CompatError::PieceUnavailable)?;
    let interrupt = Cell::new(None::<CompatError>);
    let prefix = match build_f14_prefix(
        moves,
        current,
        &PrefixOptions {
            candidate_limit: options.candidate_limit,
            allow_complete_returned_prefix: options.allow_complete_returned_prefix,
            unverifiable: options.unverifiable,
        },
        |_, _, requested| {
            if let Err(error) = interrupted(limits) {
                interrupt.set(Some(error));
                return Err("interrupted".into());
            }
            let witnessed = index.get(&final_pose_key(requested));
            let (placement, last_rotation, kick_id, kick_offset) = if let Some(witness) = witnessed
            {
                (
                    witness.placement.clone(),
                    witness.last_rotation,
                    witness.kick_id.clone(),
                    witness.kick_offset,
                )
            } else {
                (requested.clone(), false, None, None)
            };
            match project_lock(
                state,
                &placement,
                last_rotation,
                kick_id.as_deref(),
                kick_offset,
                state.combo,
                state.b2b,
                multiplier,
            ) {
                Ok(_) => Ok(placement),
                Err(_) => Err("illegal".into()),
            }
        },
    ) {
        Ok(prefix) => prefix,
        Err(error) => return Err(interrupt.take().unwrap_or(error)),
    };
    if let Some(error) = interrupt.take() {
        return Err(error);
    }

    let context = CandidateContext {
        state,
        options,
        multiplier,
        limits,
        public_profile,
        post_spin_policy: options.post_spin_policy,
    };
    let mut computed = Vec::with_capacity(prefix.accepted.len());
    let mut selected_meta = Vec::with_capacity(prefix.accepted.len());
    for accepted in &prefix.accepted {
        interrupted(limits)?;
        let witnessed = index.get(&final_pose_key(&accepted.placement));
        let evaluation = evaluate_f14_candidate(&context, accepted, witnessed)?;
        if let Some(counters) = core_counters {
            counters
                .conversion_compute_calls
                .fetch_add(1, Ordering::AcqRel);
        }
        let ranked = evaluation.ranked_input;
        let witness = evaluation.witness;
        selected_meta.push(F14SelectedCandidate {
            cc2_rank: ranked.cc2_rank,
            identity: ranked.identity.clone(),
            move_value: moves[accepted.cc2_rank as usize].clone(),
            placement: witness.placement,
            last_rotation: witness.last_rotation,
            kick_index: witness.kick_index,
            kick_id: witness.kick_id,
            kick_offset: witness.kick_offset,
            spin: evaluation.spin.to_string(),
            lines: evaluation.lines,
            s2_score: ranked.s2_score,
            selection_score: 0.0,
            conversion: ranked.conversion,
            solvency: ranked.solvency,
            solvent: ranked.solvent,
            ren_combat_gain: evaluation.ren_combat_gain,
            release_value: evaluation.release_value,
            setup_witnessed: evaluation.setup_witnessed,
            combo_after: evaluation.combo_after,
            b2b_after: evaluation.b2b_after,
            surge_sent: evaluation.surge_sent,
            cancelled: evaluation.cancelled,
        });
        computed.push(ranked);
    }

    if let Some(counters) = core_counters {
        counters.rerank_calls.fetch_add(1, Ordering::AcqRel);
    }
    Ok(ComposedRankingPrefix {
        ranked: rank_candidates_with_policy(computed, options.final_order_policy)?,
        selected_meta,
        returned_candidate_count: prefix.returned_candidate_count,
    })
}

pub fn apply_residual_rescue(prefix: ComposedRankingPrefix) -> Result<F14Selection, CompatError> {
    let ComposedRankingPrefix {
        ranked,
        selected_meta,
        returned_candidate_count,
    } = prefix;
    let (rescued, selected_index) = choose_rescue(&ranked)?;
    let selected_rank = ranked[selected_index].cc2_rank;
    let mut selected = selected_meta
        .iter()
        .find(|candidate| candidate.cc2_rank == selected_rank)
        .cloned()
        .ok_or(CompatError::NoVerifiableCandidate)?;
    selected.selection_score = ranked[selected_index].selection_score;
    selected.s2_score = ranked[selected_index].s2_score;
    Ok(F14Selection {
        generated_candidates: ranked.len(),
        returned_candidate_count,
        selected,
        rescued,
        ranked,
        prefix_facts: selected_meta,
    })
}

fn select_f14_profile_limited(
    state: &F14PublicState,
    moves: &[Value],
    options: &F14SelectOptions,
    limits: Option<&F14RuntimeLimits>,
    public_profile: bool,
) -> Result<F14Selection, CompatError> {
    crate::s2_audit::selection();
    apply_residual_rescue(compose_f14_ranking(
        state,
        moves,
        options,
        limits,
        public_profile,
    )?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectorEnvelope {
    ruleset_id: String,
    board: BoardEnvelope,
    pieces: PiecesEnvelope,
    chain: ChainEnvelope,
    time: TimeEnvelope,
    incoming: IncomingEnvelope,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoardEnvelope {
    fidelity: String,
    width: i32,
    height: i32,
    visible_height: i32,
    #[serde(default)]
    #[allow(dead_code)]
    buffer_height: Option<i32>,
    cells: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiecesEnvelope {
    current: Option<String>,
    hold: Option<String>,
    hold_available: bool,
    known: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChainEnvelope {
    combo: u32,
    b2b: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimeEnvelope {
    logical_frame: u32,
    #[allow(dead_code)]
    pieces_placed: u32,
    fidelity: String,
    frame_semantics: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IncomingEnvelope {
    pending_rows: u32,
    due_this_lock_rows: u32,
}

pub fn public_state_from_json(value: &Value) -> Result<F14PublicState, CompatError> {
    let envelope: SelectorEnvelope =
        serde_json::from_value(value.clone()).map_err(|_| CompatError::InvalidSelector)?;
    if envelope.ruleset_id != F14_RULESET_ID {
        return Err(CompatError::UnsupportedRuleset);
    }
    if envelope.board.fidelity != "exact" {
        return Err(CompatError::InvalidLockBoard);
    }
    Ok(F14PublicState {
        board_cells: envelope.board.cells,
        width: envelope.board.width,
        height: envelope.board.height,
        visible_height: envelope.board.visible_height,
        pieces: F14Pieces {
            current: envelope.pieces.current,
            hold: envelope.pieces.hold,
            known: envelope.pieces.known,
            hold_available: envelope.pieces.hold_available,
        },
        combo: envelope.chain.combo,
        b2b: envelope.chain.b2b,
        time: F14SelectorTime {
            logical_frame: envelope.time.logical_frame,
            fidelity: envelope.time.fidelity,
            frame_semantics: envelope.time.frame_semantics,
        },
        incoming: F14Incoming {
            pending_rows: envelope.incoming.pending_rows,
            due_this_lock_rows: envelope.incoming.due_this_lock_rows,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_profile_rescues_insolvent_control_without_changing_a() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-rescue.json"
        ))
        .unwrap();
        let state = public_state_from_json(&fixture["selector"]).unwrap();
        let moves = fixture["moves"].as_array().unwrap();
        assert_eq!(
            select_f14_amount_only(&state, moves, &F14SelectOptions::default()).unwrap_err(),
            CompatError::InvalidIncoming
        );
        let selected =
            select_f14_public_limited(&state, moves, &F14SelectOptions::default(), None).unwrap();
        assert!(selected.rescued);
        assert_eq!(selected.selected.cc2_rank, 1);
        assert_eq!(
            selected.selected.s2_score,
            fixture["expected"]["score"].as_f64().unwrap()
        );
        assert_eq!(selected.selected.placement.rotation, "spawn");
        assert_eq!(selected.selected.placement.y, -2);
        assert!(!selected.selected.last_rotation);
        assert_eq!(selected.ranked[0].solvency, -1.0);
        assert_eq!(selected.selected.solvency, 2.0);
        let identities: Vec<Value> = selected
            .ranked
            .iter()
            .map(|row| Value::String(row.identity.clone()))
            .collect();
        let shadow = shadow_conversion_facts(&state, &identities, None, true).unwrap();
        assert_eq!(shadow.len(), selected.ranked.len());
        for (row, ranked) in shadow.iter().zip(selected.ranked.iter()) {
            assert_eq!(row["branch"], ranked.conversion.branch.as_str());
            assert_eq!(row["units"], ranked.conversion.units);
            assert_eq!(row["qualifies"], ranked.conversion.qualifies);
        }
        let composed = apply_residual_rescue(
            compose_f14_ranking(&state, moves, &F14SelectOptions::default(), None, true).unwrap(),
        )
        .unwrap();
        assert_eq!(composed.rescued, selected.rescued);
        assert_eq!(composed.selected.cc2_rank, selected.selected.cc2_rank);
        assert_eq!(composed.ranked.len(), selected.ranked.len());
        for (left, right) in composed.ranked.iter().zip(selected.ranked.iter()) {
            assert_eq!(left.cc2_rank, right.cc2_rank);
            assert_eq!(left.s2_score, right.s2_score);
            assert_eq!(left.selection_score, right.selection_score);
            assert_eq!(left.conversion, right.conversion);
        }
    }

    #[test]
    fn compose_f14_ranking_does_not_count_legacy_selector_dispatch() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-rescue.json"
        ))
        .unwrap();
        let state = public_state_from_json(&fixture["selector"]).unwrap();
        let moves = fixture["moves"].as_array().unwrap();
        let (_, audit) = crate::s2_audit::run(|| {
            compose_f14_ranking(&state, moves, &F14SelectOptions::default(), None, true).unwrap()
        });
        assert_eq!(audit.legacy_f14_selection_calls, 0);
        let (_, audit) = crate::s2_audit::run(|| {
            apply_residual_rescue(
                compose_f14_ranking(&state, moves, &F14SelectOptions::default(), None, true)
                    .unwrap(),
            )
            .unwrap()
        });
        assert_eq!(audit.legacy_f14_selection_calls, 0);
        assert_eq!(audit.legacy_f14_rescue_calls, 1);
        let (_, audit) = crate::s2_audit::run(|| {
            select_f14_public_limited(&state, moves, &F14SelectOptions::default(), None).unwrap()
        });
        assert_eq!(audit.legacy_f14_selection_calls, 1);
        assert_eq!(audit.legacy_f14_rescue_calls, 1);
    }

    #[test]
    fn public_context_compose_ranking_matches_composer_and_skips_legacy_selection() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-rescue.json"
        ))
        .unwrap();
        let state = public_state_from_json(&fixture["selector"]).unwrap();
        let moves = fixture["moves"].as_array().unwrap();
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + std::time::Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let context = PublicRootLockContext::for_profile(&state, &limits, true).unwrap();
        let (_, audit) = crate::s2_audit::run(|| {
            context
                .compose_ranking(moves, &F14SelectOptions::default())
                .unwrap()
        });
        assert_eq!(audit.legacy_f14_selection_calls, 0);
        let from_context = apply_residual_rescue(
            context
                .compose_ranking(moves, &F14SelectOptions::default())
                .unwrap(),
        )
        .unwrap();
        let from_fn = apply_residual_rescue(
            compose_f14_ranking(
                &state,
                moves,
                &F14SelectOptions::default(),
                Some(&limits),
                true,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(from_context.selected.cc2_rank, from_fn.selected.cc2_rank);
        assert_eq!(from_context.ranked, from_fn.ranked);
        let identities: Vec<String> = moves
            .iter()
            .map(|value| crate::f14_compat::canonicalize(value).unwrap())
            .collect();
        let snapshot = CoreRankedSnapshot {
            binding: snapshot_binding(7, &serde_json::json!({"fixture": true}), &identities),
            prefix: context
                .compose_ranking(moves, &F14SelectOptions::default())
                .unwrap(),
        };
        assert_eq!(snapshot.epoch(), 7);
        assert_eq!(snapshot.prefix.ranked.len(), from_fn.ranked.len());
    }

    #[test]
    fn root_session_publishes_after_final_work_and_getter_is_single_use() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-rescue.json"
        ))
        .unwrap();
        let state = public_state_from_json(&fixture["selector"]).unwrap();
        let moves = fixture["moves"].as_array().unwrap();
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + std::time::Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let context = PublicRootLockContext::for_profile(&state, &limits, true).unwrap();
        let session = RootObjectiveSession::new(
            context,
            RootDecisionStage::new(F14SelectOptions::default()),
            2,
            7,
            public_context_digest(&serde_json::json!({"fixture": true})),
        );
        let native_move: Placement = serde_json::from_value(moves[0].clone()).unwrap();
        let stats = crate::bot::Statistics {
            selections: 1,
            nodes: 42,
            ..Default::default()
        };
        session
            .complete_work(&stats, || vec![(native_move, 1.25)])
            .unwrap();
        assert!(session.take_outcome().unwrap().is_none());
        session
            .complete_work(&stats, || vec![(native_move, 2.5)])
            .unwrap();
        let outcome = session.take_outcome().unwrap().unwrap();
        match outcome {
            FinishedRootOutcome::Decided(bundle) => {
                assert_eq!(bundle.root_revision, 2);
                assert_eq!(bundle.completed_selections, 2);
                assert_eq!(bundle.nodes, 84);
                assert_eq!(bundle.native_moves, vec![native_move]);
                assert_eq!(bundle.native_values, vec![2.5]);
                assert_eq!(bundle.selection.returned_candidate_count, 1);
                assert_eq!(bundle.selection.ranked.len(), 1);
                assert_eq!(bundle.counters.ranking_compose_calls, 1);
                assert_eq!(bundle.counters.rerank_calls, 1);
                assert_eq!(bundle.counters.conversion_compute_calls, 1);
            }
            other => panic!("unexpected root outcome: {other:?}"),
        }
        assert_eq!(
            session.take_outcome().unwrap_err(),
            CompatError::RootOutcomeAlreadyTaken
        );
    }
    #[test]
    fn root_session_a_side_matches_composed_native_payload_and_values() {
        let state = opening_state(empty_cells(), "T", 0);
        let move_values = reachable_moves(&state);
        let placements: Vec<Placement> = serde_json::from_value(Value::Array(move_values.clone())).unwrap();
        let native: Vec<(Placement, f32)> = placements.iter().copied().enumerate()
            .map(|(index, mv)| (mv, index as f32 + 1.0)).collect();
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + std::time::Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let options = F14SelectOptions::default();
        let a_context = PublicRootLockContext::for_profile(&state, &limits, false).unwrap();
        let expected = apply_residual_rescue(a_context.compose_ranking(&move_values, &options).unwrap()).unwrap();
        let session = RootObjectiveSession::new(
            a_context,
            RootDecisionStage::new(options),
            1,
            9,
            public_context_digest(&serde_json::json!({"a-side": true})),
        );
        let stats = crate::bot::Statistics {selections: 1, nodes: 17, ..Default::default()};
        session.complete_work(&stats, || native.clone()).unwrap();
        let outcome = session.take_outcome().unwrap().unwrap();
        match outcome {
            FinishedRootOutcome::Decided(bundle) => {
                assert_eq!(bundle.native_moves, placements);
                assert_eq!(bundle.native_values, native.iter().map(|(_, value)| *value).collect::<Vec<_>>());
                assert_eq!(bundle.selection, expected);
            }
            other => panic!("unexpected A-side outcome: {other:?}"),
        }
    }

    #[test]
    fn root_session_publishes_core_owned_rescue_selection_from_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/diagnostics/f14-public-rescue.json"
        ))
        .unwrap();
        let state = public_state_from_json(&fixture["selector"]).unwrap();
        let moves = fixture["moves"].as_array().unwrap();
        let placements: Vec<Placement> = serde_json::from_value(Value::Array(moves.clone())).unwrap();
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + std::time::Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let options = F14SelectOptions::default();
        let context = PublicRootLockContext::for_profile(&state, &limits, true).unwrap();
        let expected = apply_residual_rescue(
            compose_f14_ranking(&state, moves, &options, Some(&limits), true).unwrap(),
        )
        .unwrap();
        let session = RootObjectiveSession::new(
            context,
            RootDecisionStage::new(options),
            1,
            19,
            public_context_digest(&serde_json::json!({"fixture": "rescue"})),
        );
        let stats = crate::bot::Statistics {
            selections: 1,
            nodes: 42,
            ..Default::default()
        };
        session.complete_work(&stats, || {
            placements.iter().copied().map(|placement| (placement, 1.0)).collect()
        }).unwrap();
        let outcome = session.take_outcome().unwrap().unwrap();
        match outcome {
            FinishedRootOutcome::Decided(bundle) => {
                assert_eq!(bundle.selection, expected);
                assert!(bundle.selection.rescued);
                assert_eq!(bundle.selection.selected.cc2_rank, 1);
                assert!(bundle.post_stage_counters.conversion_compute_calls > 0);
                assert!(bundle.post_stage_counters.conversion_add_calls > 0);
                assert_eq!(bundle.post_stage_counters.rerank_calls, 1);
            }
            other => panic!("unexpected root outcome: {other:?}"),
        }
    }
    #[test]
    fn root_session_publishes_no_candidates_after_final_work() {
        let state = opening_state(empty_cells(), "T", 0);
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + std::time::Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let context = PublicRootLockContext::for_profile(&state, &limits, true).unwrap();
        let session = RootObjectiveSession::new(
            context,
            RootDecisionStage::new(F14SelectOptions::default()),
            1,
            11,
            public_context_digest(&serde_json::json!({"no-candidates": true})),
        );
        let stats = crate::bot::Statistics {selections: 1, nodes: 23, ..Default::default()};
        session.complete_work(&stats, Vec::new).unwrap();
        assert_eq!(
            session.take_outcome().unwrap(),
            Some(FinishedRootOutcome::NoCandidates {completed_selections: 1, nodes: 23}),
        );
    }

    #[test]
    fn root_session_publishes_native_failure_and_consumes_it_once() {
        let state = opening_state(empty_cells(), "T", 0);
        let limits = F14RuntimeLimits {
            deadline: Instant::now() + std::time::Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let context = PublicRootLockContext::for_profile(&state, &limits, true).unwrap();
        let session = RootObjectiveSession::new(
            context,
            RootDecisionStage::new(F14SelectOptions::default()),
            1,
            12,
            public_context_digest(&serde_json::json!({"failure": true})),
        );
        session.publish_root_failure(CompatError::ChainOverflow);
        assert_eq!(
            session.take_outcome().unwrap(),
            Some(FinishedRootOutcome::Failed(CompatError::ChainOverflow)),
        );
        assert_eq!(session.take_outcome().unwrap_err(), CompatError::RootOutcomeAlreadyTaken);
    }
    #[test]
    fn sorted_compact_json_is_independent_of_object_insert_order() {
        let golden = br#"{"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}"#;
        let forward = serde_json::json!({"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]});
        let nested_first = {
            let mut inner = serde_json::Map::new();
            inner.insert("d".into(), serde_json::json!(4));
            inner.insert("c".into(), serde_json::json!(3));
            let mut row = serde_json::Map::new();
            row.insert("b".into(), serde_json::json!(2));
            row.insert("a".into(), serde_json::json!(1));
            let mut root = serde_json::Map::new();
            root.insert("z".into(), Value::Array(vec![Value::Object(row)]));
            root.insert("a".into(), Value::Object(inner));
            Value::Object(root)
        };
        assert_eq!(sorted_compact_json(&forward), golden);
        assert_eq!(sorted_compact_json(&nested_first), golden);
        let z_value = serde_json::json!([{"a":1,"b":2}]);
        let a_value = serde_json::json!({"c":3,"d":4});
        let mut reverse_entries = [("z", &z_value), ("a", &a_value)];
        let mut from_index_order = Vec::new();
        write_sorted_object_entries(&mut reverse_entries, &mut from_index_order);
        assert_eq!(from_index_order, golden);
        let array_swapped = serde_json::json!({"a":{"c":3,"d":4},"z":[{"b":2,"a":1}]});
        assert_eq!(sorted_compact_json(&array_swapped), golden);
        let array_order_diff = serde_json::json!({"a":{"c":3,"d":4},"z":[{"a":1},{"b":2}]});
        assert_ne!(sorted_compact_json(&array_order_diff), golden);
        let seed = serde_json::json!({"seed":"5994928009864282113","exactU64":18446744073709551615_u64,"finite":1.5});
        let compact = sorted_compact_json(&seed);
        assert!(compact.starts_with(b"{"));
        assert!(!compact.ends_with(b"\n"));
        assert_eq!(
            std::str::from_utf8(&compact).unwrap().find('\u{feff}'),
            None
        );
        assert!(std::str::from_utf8(&compact)
            .unwrap()
            .contains("5994928009864282113"));
        assert!(std::str::from_utf8(&compact)
            .unwrap()
            .contains("18446744073709551615"));
    }

    #[test]
    fn returned_identity_digest_detects_permutation_and_substitution() {
        let a = "id-a".to_string();
        let b = "id-b".to_string();
        let c = "id-c".to_string();
        let original = returned_identity_digest(&[a.clone(), b.clone(), c.clone()]);
        assert_ne!(
            original,
            returned_identity_digest(&[b.clone(), a.clone(), c.clone()])
        );
        assert_ne!(
            original,
            returned_identity_digest(&[a.clone(), b.clone(), "id-d".into()])
        );
        assert_ne!(original, returned_identity_digest(&[a.clone(), b.clone()]));
        assert_ne!(
            original,
            returned_identity_digest(&[c.clone(), a.clone(), b.clone()])
        );
        assert_eq!(
            original,
            returned_identity_digest(&[a.clone(), b.clone(), c.clone()])
        );
        let newline_left = returned_identity_digest(&["a\nb".into(), "c".into()]);
        let newline_right = returned_identity_digest(&["a".into(), "b\nc".into()]);
        assert_ne!(newline_left, newline_right);
    }

    #[test]
    fn public_context_serializer_isolation_does_not_depend_on_preserve_order_feature() {
        let lock = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock"),
        )
        .unwrap();
        let serde_json_block = lock
            .split("[[package]]")
            .find(|block| block.contains("name = \"serde_json\""))
            .unwrap();
        assert!(serde_json_block.contains("version = \"1.0.69\""));
        assert!(!serde_json_block.contains("indexmap"));
        assert!(!serde_json_block.contains("preserve_order"));
        let golden =
            sorted_compact_json(&serde_json::json!({"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}));
        let digest = format!("{:x}", Sha256::digest(&golden));
        assert_eq!(
            digest,
            "931a753059c2c9caf76f585cf9ed94b9183f3a4211b25add8c2974e6a06db330"
        );
        let btree = serde_json::json!({"z":1,"a":2});
        let z_one = serde_json::json!(1);
        let a_two = serde_json::json!(2);
        let mut insert_order = [("z", &z_one), ("a", &a_two)];
        let mut isolated = Vec::new();
        write_sorted_object_entries(&mut insert_order, &mut isolated);
        assert_eq!(sorted_compact_json(&btree), isolated);
        assert_eq!(isolated, br#"{"a":2,"z":1}"#);
    }
    use super::{generate_reachable_a, reach_pieces, CanonicalPlacement, ReachPlacement};
    use crate::f14_compat::ConversionBranch;
    use std::path::Path;
    use std::sync::{atomic::AtomicBool, Arc};
    use std::time::Instant;

    fn bits(hex: &str) -> f64 {
        f64::from_bits(u64::from_str_radix(hex, 16).unwrap())
    }

    fn hex_bits(value: f64) -> String {
        format!("{:016x}", value.to_bits())
    }

    fn load_p5() -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/diagnostics/cc2-s2-f14-amount-only-native-compat-p5.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("p5 fixture")).expect("p5 json")
    }

    #[test]
    fn p5_effective_weights_match_fixture_bits() {
        let p5 = load_p5();
        for (index, expected) in p5["weightBits"].as_array().unwrap().iter().enumerate() {
            assert_eq!(
                hex_bits(EFFECTIVE_WEIGHTS[index]),
                expected.as_str().unwrap(),
                "weight {index}"
            );
        }
    }

    #[test]
    fn effective_weights_bind_sparse_s2_fixture_and_baseline_top_out() {
        let grid: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/tuning/cc2-s2-initial-weight-grid.json"
        ))
        .unwrap();
        let sparse = grid["weightProfiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|profile| profile["id"] == "sparse-s2")
            .expect("sparse-s2 profile");
        let names = [
            "aggregateHeight",
            "maxHeight",
            "holes",
            "bumpiness",
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
        let mut sparse_index = 0;
        for (index, name) in [
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
        ]
        .iter()
        .enumerate()
        {
            if *name == "toppedOut" {
                assert_eq!(EFFECTIVE_WEIGHTS[index], -1_000_000.0, "baseline toppedOut");
                continue;
            }
            assert_eq!(*name, names[sparse_index]);
            assert_eq!(
                EFFECTIVE_WEIGHTS[index].to_bits(),
                sparse["weights"][*name].as_f64().unwrap().to_bits(),
                "sparse-s2 weight {name}"
            );
            sparse_index += 1;
        }
        assert_eq!(sparse_index, names.len());
    }

    #[test]
    fn p5_spin_golden_matches_js() {
        let p5 = load_p5();
        for case in p5["spinCases"].as_array().unwrap() {
            if case["id"].as_str().unwrap() == "inconsistent-final-kick-evidence" {
                continue;
            }
            let cells = case["cells"].as_str().unwrap();
            let placement = CanonicalPlacement {
                piece: case["placement"]["piece"].as_str().unwrap().to_string(),
                rotation: case["placement"]["rotation"].as_str().unwrap().to_string(),
                x: case["placement"]["x"].as_i64().unwrap() as i32,
                y: case["placement"]["y"].as_i64().unwrap() as i32,
                used_hold: false,
            };
            let offset = case["placement"]["kickOffset"].as_array().map(|pair| {
                (
                    pair[0].as_i64().unwrap() as i32,
                    pair[1].as_i64().unwrap() as i32,
                )
            });
            let eval = evaluate_f14_lock(
                cells,
                10,
                40,
                &placement,
                true,
                case["placement"]["kickId"].as_str(),
                offset,
            )
            .unwrap_or_else(|error| panic!("{} {:?}", case["id"], error));
            assert_eq!(
                eval.spin,
                case["expectedSpin"].as_str().unwrap(),
                "{}",
                case["id"]
            );
            if let Some(lines) = case["expectedLines"].as_u64() {
                assert_eq!(eval.lines, lines as u32, "{}", case["id"]);
            }
        }
    }

    #[test]
    fn p5_synthetic_tsd_lock_eval_matches_js() {
        let p5 = load_p5();
        let tsd = &p5["syntheticTsd"];
        let pieces = F14Pieces {
            current: Some(tsd["pieces"]["current"].as_str().unwrap().to_string()),
            hold: Some(tsd["pieces"]["hold"].as_str().unwrap().to_string()),
            known: tsd["pieces"]["known"]
                .as_array()
                .unwrap()
                .iter()
                .map(|piece| piece.as_str().unwrap().to_string())
                .collect(),
            hold_available: true,
        };
        let result = witness_tsd(
            tsd["lockBoard"]["cells"].as_str().unwrap(),
            10,
            40,
            &pieces,
            None,
            false,
        )
        .unwrap();
        assert_eq!(
            result.t_available,
            tsd["result"]["tAvailable"].as_bool().unwrap()
        );
        assert_eq!(
            result.scanned,
            tsd["result"]["scanned"].as_u64().unwrap() as u32
        );
        assert_eq!(
            result.witnessed,
            tsd["result"]["witnessed"].as_bool().unwrap()
        );
        for entry in tsd["locks"].as_array().unwrap() {
            let placement = CanonicalPlacement {
                piece: entry["placement"]["piece"].as_str().unwrap().to_string(),
                rotation: entry["placement"]["rotation"].as_str().unwrap().to_string(),
                x: entry["placement"]["x"].as_i64().unwrap() as i32,
                y: entry["placement"]["y"].as_i64().unwrap() as i32,
                used_hold: entry["placement"]["usedHold"].as_bool().unwrap(),
            };
            let evidence = &entry["placement"]["rotationEvidence"];
            let offset = evidence["kickOffset"].as_array().map(|pair| {
                (
                    pair[0].as_i64().unwrap() as i32,
                    pair[1].as_i64().unwrap() as i32,
                )
            });
            let eval = evaluate_f14_lock(
                tsd["lockBoard"]["cells"].as_str().unwrap(),
                10,
                40,
                &placement,
                evidence["lastInputWasRotation"].as_bool().unwrap(),
                evidence["kickId"].as_str(),
                offset,
            );
            if entry["legal"].as_bool().unwrap() {
                let eval = eval.expect("legal lock");
                assert_eq!(eval.spin, entry["spin"].as_str().unwrap());
                assert_eq!(eval.lines, entry["lines"].as_u64().unwrap() as u32);
            } else {
                assert!(eval.is_err());
            }
        }
    }

    #[test]
    fn p5_opening_decisions_match_js_selected_scores_and_order() {
        let p5 = load_p5();
        for decision in p5["decisions"].as_array().unwrap() {
            let state = public_state_from_json(&decision["selector"]).unwrap();
            let moves = decision["moves"].as_array().unwrap();
            let selected = select_f14_amount_only(&state, moves, &F14SelectOptions::default())
                .unwrap_or_else(|error| panic!("{} {:?}", decision["id"], error));
            assert_eq!(
                crate::f14_compat::canonicalize(&selected.selected.move_value).unwrap(),
                decision["selectedIdentity"].as_str().unwrap(),
                "{}",
                decision["id"]
            );
            assert_eq!(
                selected.selected.cc2_rank,
                decision["selectedCc2Rank"].as_i64().unwrap() as i32
            );
            assert_eq!(
                selected.rescued,
                decision["rescueApplied"].as_bool().unwrap()
            );
            assert_eq!(
                selected.ranked.len(),
                decision["candidates"].as_array().unwrap().len()
            );
            for (index, candidate) in selected.ranked.iter().enumerate() {
                let expected = &decision["candidates"][index];
                assert_eq!(
                    candidate.cc2_rank,
                    expected["cc2Rank"].as_i64().unwrap() as i32
                );
                assert_eq!(candidate.identity, expected["identity"].as_str().unwrap());
                assert_eq!(
                    hex_bits(candidate.s2_score),
                    expected["s2ScoreBits"].as_str().unwrap()
                );
                assert_eq!(
                    hex_bits(candidate.selection_score),
                    expected["selectionScoreBits"].as_str().unwrap()
                );
                assert_eq!(
                    candidate.conversion.branch.as_str(),
                    expected["conversion"]["branch"].as_str().unwrap()
                );
                assert_eq!(candidate.solvent, expected["solvent"].as_bool().unwrap());
            }
            let _ = bits;
        }
    }

    fn p5_selector() -> Value {
        load_p5()["decisions"][0]["selector"].clone()
    }

    #[test]
    fn p5_selector_envelope_is_fail_closed_on_incoming_hold_and_unknown_keys() {
        let mut incoming_string = p5_selector();
        incoming_string["incoming"]["pendingRows"] = Value::String("5".into());
        incoming_string["incoming"]["dueThisLockRows"] = Value::String("5".into());
        assert_eq!(
            public_state_from_json(&incoming_string),
            Err(CompatError::InvalidSelector)
        );

        let mut typo = p5_selector();
        let incoming = typo["incoming"].as_object_mut().unwrap();
        let due = incoming.remove("dueThisLockRows").unwrap();
        incoming.remove("pendingRows");
        incoming.insert("pendingRow".into(), Value::from(5));
        incoming.insert("dueThisLockRows".into(), due);
        assert_eq!(
            public_state_from_json(&typo),
            Err(CompatError::InvalidSelector)
        );

        let mut omitted = p5_selector();
        omitted.as_object_mut().unwrap().remove("incoming");
        assert_eq!(
            public_state_from_json(&omitted),
            Err(CompatError::InvalidSelector)
        );

        let mut hold_string = p5_selector();
        hold_string["pieces"]["holdAvailable"] = Value::String("false".into());
        assert_eq!(
            public_state_from_json(&hold_string),
            Err(CompatError::InvalidSelector)
        );

        let mut hold_omitted = p5_selector();
        hold_omitted["pieces"]
            .as_object_mut()
            .unwrap()
            .remove("holdAvailable");
        assert_eq!(
            public_state_from_json(&hold_omitted),
            Err(CompatError::InvalidSelector)
        );

        let mut garbage = p5_selector();
        garbage["garbage"] = serde_json::json!({"packets":[]});
        assert_eq!(
            public_state_from_json(&garbage),
            Err(CompatError::InvalidSelector)
        );

        let ok = public_state_from_json(&p5_selector()).unwrap();
        assert_eq!(ok.incoming.pending_rows, 0);
        assert_eq!(ok.incoming.due_this_lock_rows, 0);
        assert!(ok.pieces.hold_available);

        let mut ruleset = p5_selector();
        ruleset["rulesetId"] = Value::String("tetrio-s2-v19-other-beta-1-5-0".into());
        assert_eq!(
            public_state_from_json(&ruleset),
            Err(CompatError::UnsupportedRuleset)
        );
    }

    fn empty_cells() -> String {
        "_".repeat(400)
    }
    #[test]
    fn integrated_audit_observes_the_real_f14_selector_entry() {
        let state = opening_state(empty_cells(), "T", 0);
        let (_, audit) = crate::s2_audit::run(|| {
            select_f14_amount_only(&state, &[], &F14SelectOptions::default())
        });
        assert_eq!(audit.legacy_f14_selection_calls, 1);
    }

    fn cells_with_bottom_six() -> String {
        let mut cells: Vec<u8> = vec![b'_'; 400];
        for x in 0..6 {
            cells[x] = b'G';
        }
        String::from_utf8(cells).unwrap()
    }

    fn cells_from_rows(rows: &[&str]) -> String {
        let mut cells = vec![b'_'; 400];
        for (y, row) in rows.iter().enumerate() {
            for (x, ch) in row.bytes().enumerate() {
                cells[y * 10 + x] = if ch == b' ' { b'_' } else { ch };
            }
        }
        String::from_utf8(cells).unwrap()
    }

    fn cells_height20_well() -> String {
        let mut cells = vec![b'_'; 400];
        for y in 0..20 {
            for x in 0..9 {
                cells[y * 10 + x] = b'G';
            }
        }
        String::from_utf8(cells).unwrap()
    }

    fn opening_state(cells: String, current: &str, combo: u32) -> F14PublicState {
        opening_state_with_hold(cells, current, None, combo)
    }

    fn opening_state_with_hold(
        cells: String,
        current: &str,
        hold: Option<&str>,
        combo: u32,
    ) -> F14PublicState {
        F14PublicState {
            board_cells: cells,
            width: 10,
            height: 40,
            visible_height: 20,
            pieces: F14Pieces {
                current: Some(current.to_string()),
                hold: hold.map(str::to_string),
                known: vec!["Z".into(); 20],
                hold_available: true,
            },
            combo,
            b2b: 0,
            time: F14SelectorTime {
                logical_frame: 0,
                fidelity: "exact".into(),
                frame_semantics: "engine-frame".into(),
            },
            incoming: F14Incoming {
                pending_rows: 0,
                due_this_lock_rows: 0,
            },
        }
    }

    fn canonical_to_cc2(placement: &CanonicalPlacement) -> Value {
        let orientation = match placement.rotation.as_str() {
            "spawn" => "north",
            "right" => "east",
            "reverse" => "south",
            "left" => "west",
            other => panic!("rotation {other}"),
        };
        let (ox, oy) = match (placement.piece.as_str(), orientation) {
            ("I", "north") => (-1, -2),
            ("I", "east") => (-2, -2),
            ("I", "south") => (-2, -1),
            ("I", "west") => (-1, -1),
            ("O", "north") => (0, 0),
            ("O", "east") => (0, -1),
            ("O", "south") => (-1, -1),
            ("O", "west") => (-1, 0),
            _ => (-1, -1),
        };
        serde_json::json!({
            "location": {
                "type": placement.piece,
                "orientation": orientation,
                "x": placement.x - ox,
                "y": placement.y - oy,
            },
            "spin": "none",
        })
    }

    fn reachable_moves(state: &F14PublicState) -> Vec<Value> {
        let (tables, cells_table) = geometry();
        let mut moves = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for candidate in generate_reachable_a(
            &state.board_cells,
            state.width,
            state.height,
            &reach_pieces(&state.pieces),
            cells_table,
            tables,
        )
        .unwrap()
        {
            let move_value = canonical_to_cc2(&candidate.placement);
            let identity = crate::f14_compat::canonicalize(&move_value).unwrap();
            if seen.insert(identity) {
                moves.push(move_value);
            }
            if moves.len() == 16 {
                break;
            }
        }
        moves
    }

    #[test]
    fn p5_wired_select_reaches_low_value_and_defensive_ren_on_a_profile() {
        let low = opening_state(cells_with_bottom_six(), "I", 1);
        let low_moves = reachable_moves(&low);
        assert!(!low_moves.is_empty());
        let selected =
            select_f14_amount_only(&low, &low_moves, &F14SelectOptions::default()).unwrap();
        assert!(
            selected
                .ranked
                .iter()
                .any(|candidate| candidate.conversion.branch
                    == ConversionBranch::UnconvertedLowValueRen),
            "expected unconverted-low-value-ren in {:?}",
            selected
                .ranked
                .iter()
                .map(|candidate| candidate.conversion.branch.as_str())
                .collect::<Vec<_>>()
        );

        let defensive = opening_state(cells_with_bottom_six(), "I", 5);
        let defensive_moves = reachable_moves(&defensive);
        let selected =
            select_f14_amount_only(&defensive, &defensive_moves, &F14SelectOptions::default())
                .unwrap();
        assert!(
            selected.ranked.iter().any(|candidate| {
                candidate.conversion.branch == ConversionBranch::HighOrDefensiveRen
                    && !candidate.conversion.qualifies
                    && candidate.conversion.units == 0.0
            }),
            "expected degenerate high-or-defensive-ren"
        );
    }

    #[test]
    fn p5_wired_select_height20_and_tss_setup_match_a_profile_contracts() {
        let height = opening_state(cells_height20_well(), "I", 0);
        let height_moves = reachable_moves(&height);
        let selected =
            select_f14_amount_only(&height, &height_moves, &F14SelectOptions::default()).unwrap();
        let insolvent = selected
            .ranked
            .iter()
            .filter(|candidate| candidate.solvency < 0.0)
            .count();
        assert!(
            insolvent > 0,
            "height-20 well should produce negative-margin candidates"
        );
        assert!(
            !selected.rescued,
            "A incoming0 does not rescue when ranking already prefers a solvent control, or when the prefix is all insolvent"
        );

        let tss = opening_state_with_hold(
            cells_from_rows(&["___G_G____", "GGG___GGGG", "___G_G____"]),
            "T",
            Some("T"),
            1,
        );
        let planted = canonical_to_cc2(&CanonicalPlacement {
            piece: "T".into(),
            rotation: "spawn".into(),
            x: 3,
            y: 0,
            used_hold: false,
        });
        let planted_id = crate::f14_compat::canonicalize(&planted).unwrap();
        let mut tss_moves = vec![planted];
        for move_value in reachable_moves(&tss) {
            if crate::f14_compat::canonicalize(&move_value).unwrap() == planted_id {
                continue;
            }
            tss_moves.push(move_value);
            if tss_moves.len() == 16 {
                break;
            }
        }
        let selected =
            select_f14_amount_only(&tss, &tss_moves, &F14SelectOptions::default()).unwrap();
        let branches: Vec<&str> = selected
            .ranked
            .iter()
            .map(|candidate| candidate.conversion.branch.as_str())
            .collect();
        assert!(
            branches.iter().any(|branch| {
                *branch == "mini-to-tsd-b2b-bridge" || *branch == "unconverted-low-value-ren"
            }),
            "TSS setup should reach mini-to-tsd or low-value REN, got {branches:?}"
        );
        assert!(!selected.rescued);
    }

    #[test]
    fn legal_public_state_reaches_mini_to_tsd_b2b_bridge() {
        // Partial roof gives the TSD three corners while remaining BFS-enterable.
        // Mini T is on the left of the same public state (combo 1, hold T).
        let state = opening_state_with_hold(
            cells_from_rows(&[
                "GGGGG_GGGG",
                "GGGG___GGG",
                "G_G_G_____",
                "___GGGGGGG",
                "G_________",
            ]),
            "T",
            Some("T"),
            1,
        );
        let (tables, cells_table) = geometry();
        let reachable = generate_public_reachable(
            &state.board_cells,
            state.width,
            state.height,
            &reach_pieces(&state.pieces),
            cells_table,
            tables,
        )
        .unwrap();
        let multiplier = resolve_f14_multiplier(&state.time).unwrap();
        let mut found = None;
        let mut samples = Vec::new();
        for witness in &reachable {
            let Ok(facts) = conversion_facts_for_lock(
                &state,
                &witness.placement,
                Some(witness),
                None,
                true,
                PostSpinPolicy::LegacyF14,
                multiplier,
            ) else {
                continue;
            };
            if samples.len() < 12 {
                samples.push((
                    facts.spin,
                    facts.lines,
                    witness.last_rotation,
                    facts.conversion.branch.as_str(),
                    facts.setup_witnessed,
                ));
            }
            if facts.conversion.branch == ConversionBranch::MiniToTsdB2bBridge {
                found = Some(facts);
                break;
            }
        }
        let facts = found.unwrap_or_else(|| {
            panic!("legal public TSS/TSD state should reach mini-to-tsd, samples={samples:?}")
        });
        assert_eq!(facts.conversion.units, 1.25);
        assert!(facts.setup_witnessed);
        assert!(facts.conversion.qualifies);
    }

    #[test]
    fn non_t_mini_setup_bridge_is_only_post_stage_policy_value() {
        let state = opening_state_with_hold(
            cells_from_rows(&[
                "GG_GGGGGGG",
                "GG_GGGGGGG",
                "GG_GG_GGGG",
                "GG_G___GGG",
                "GTG_G_____",
                "G_________",
            ]),
            "T",
            Some("I"),
            1,
        );
        let witness = ReachPlacement {
            placement: CanonicalPlacement {
                piece: "I".into(),
                rotation: "right".into(),
                x: 0,
                y: 0,
                used_hold: true,
            },
            last_rotation: true,
            kick_index: None,
            kick_id: None,
            kick_offset: None,
        };
        let placement = witness.placement.clone();
        let multiplier = resolve_f14_multiplier(&state.time).unwrap();
        let (legacy, legacy_audit) = crate::s2_audit::run_native_f14_compat(|| {
            conversion_facts_for_lock(
                &state,
                &placement,
                Some(&witness),
                None,
                true,
                PostSpinPolicy::LegacyF14,
                multiplier,
            )
        });
        let (off, off_audit) = crate::s2_audit::run_native_f14_compat(|| {
            conversion_facts_for_lock(
                &state,
                &placement,
                Some(&witness),
                None,
                true,
                PostSpinPolicy::NonTSpinPriorOff,
                multiplier,
            )
        });
        let legacy = legacy.expect("legacy non-T Mini setup witness");
        let off = off.expect("policy-off non-T Mini projection");
        assert_eq!(legacy.spin, "mini");
        assert_eq!(legacy.lines, 2);
        assert_eq!(legacy.conversion.branch, ConversionBranch::MiniToTsdB2bBridge);
        assert_eq!(legacy_audit.non_t_setup_witness_calls, 1);
        assert_eq!(legacy_audit.non_t_setup_bonus_applied, 1);
        assert_eq!(off.conversion.branch, ConversionBranch::UnconvertedLowValueRen);
        assert_eq!(off_audit.non_t_setup_witness_calls, 0);
        assert_eq!(off_audit.non_t_setup_bonus_applied, 0);
        assert_eq!(legacy.actual.outgoing_before_cancel, off.actual.outgoing_before_cancel);
        assert_eq!(legacy.actual.outgoing_after_cancel, off.actual.outgoing_after_cancel);
        assert_eq!(legacy.actual.cancelled_rows, off.actual.cancelled_rows);
        assert_eq!(legacy.actual.combo_after, off.actual.combo_after);
        assert_eq!(legacy.actual.b2b_after, off.actual.b2b_after);
        assert_eq!(legacy.actual.surge_sent, off.actual.surge_sent);
        assert_eq!(legacy.solvency, off.solvency);
    }

    #[test]
    fn legal_public_state_reaches_high_surge_finisher() {
        // Zero-incoming amount projection returns G=V=0, so high-surge is
        // unreachable without pending rows. A 1-line O break of b2b=6 then
        // yields surge 5 and V=5 on the public (profile B) path.
        let mut state = opening_state(cells_from_rows(&["IIIIIII__I"]), "O", 0);
        state.b2b = 6;
        state.incoming = F14Incoming {
            pending_rows: 8,
            due_this_lock_rows: 0,
        };
        let multiplier = resolve_f14_multiplier(&state.time).unwrap();
        let placement = CanonicalPlacement {
            piece: "O".into(),
            rotation: "spawn".into(),
            x: 7,
            y: 0,
            used_hold: false,
        };
        let facts = conversion_facts_for_lock(
            &state,
            &placement,
            None,
            None,
            true,
            PostSpinPolicy::LegacyF14,
            multiplier,
        )
        .expect("legal O lock on a nearly-full row with b2b=6 and pending incoming");
        assert_eq!(facts.conversion.branch, ConversionBranch::HighSurgeFinisher);
        assert_eq!(facts.lines, 1);
        assert_eq!(facts.spin, "none");
        assert!(facts.actual.surge_sent >= 5.0);
        assert!(facts.release_value >= 5.0);
        assert!(facts.conversion.units >= 1.25);
        assert!(facts.conversion.qualifies);
    }

    #[test]
    fn p5_wired_select_honors_cancel_and_past_deadline() {
        let state = opening_state(empty_cells(), "T", 0);
        let moves = reachable_moves(&state);
        let cancel = Arc::new(AtomicBool::new(true));
        assert_eq!(
            select_f14_amount_only_limited(
                &state,
                &moves,
                &F14SelectOptions::default(),
                Some(&F14RuntimeLimits {
                    deadline: Instant::now() + std::time::Duration::from_secs(30),
                    cancel,
                }),
            ),
            Err(CompatError::Cancelled)
        );
        assert_eq!(
            select_f14_amount_only_limited(
                &state,
                &moves,
                &F14SelectOptions::default(),
                Some(&F14RuntimeLimits {
                    deadline: Instant::now() - std::time::Duration::from_secs(1),
                    cancel: Arc::new(AtomicBool::new(false)),
                }),
            ),
            Err(CompatError::Deadline)
        );
    }
}
