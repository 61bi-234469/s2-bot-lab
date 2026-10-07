use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

use serde_json::Value as Json;

use crate::bot::{Bot, BotConfig, Statistics};
use crate::f14_compat::select::{
    AllocationMode, FinishedRootOutcome, RootObjectiveSession, RootObservation,
};
use crate::f14_compat::{CompatError, F14RuntimeLimits};
use crate::tbp::MoveInfo;
use crate::time::Instant;

use super::transport::{self as f14, Profile, SearchStats};

/// The part of a public F14 decision that does not require the native
/// synchronizer.  The optional Bot is consumed by the native synchronizer
/// after preparation, or retained by the WASM driver while it does work.
pub(crate) struct Prepared {
    pub(crate) request: Json,
    pub(crate) profile: Profile,
    pub(crate) bot: Option<Bot>,
    pub(crate) root_session: Option<Arc<RootObjectiveSession>>,
    pub(crate) limits: F14RuntimeLimits,
    pub(crate) token: u64,
    /// Tree reuse (`tree_reuse_floor`): what this request did with the
    /// previous tree; `None` when the key is absent.
    pub(crate) reuse: Option<ReuseReport>,
    /// A previous tree that could not be continued, for the host to retire.
    pub(crate) unusable_tree: Option<Bot>,
}

/// Reported as `search.reuse` on profiles with `tree_reuse_floor`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ReuseReport {
    pub(crate) reused: bool,
    /// Expanded nodes reachable from the continued root.
    pub(crate) inherited: u64,
    /// Selections credited against the budget: min(inherited, budget - floor).
    pub(crate) credited: u64,
    pub(crate) reason: &'static str,
    /// Wall time of the reuse attempt (matching, advance, counting), in µs.
    pub(crate) micros: u64,
}

impl ReuseReport {
    pub(crate) fn to_json(&self, budget: u64) -> Json {
        serde_json::json!({
            "reused": self.reused,
            "inherited": self.inherited,
            "credited": self.credited,
            "newSelections": budget - self.credited,
            "reason": self.reason,
            "micros": self.micros,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FinishEnd {
    Budget,
    Deadline,
    Cancelled,
    Stopped,
    Failed(&'static str),
}

fn allocation_mode_for(profile_id: &str, allocation_mode: Option<&str>) -> AllocationMode {
    if profile_id == f14::ROOT_VALUE_PROFILE {
        AllocationMode::RootValueV1
    } else if profile_id == f14::ROOT_VALUE_MIX_PROFILE {
        AllocationMode::RootValueMixV1
    } else if profile_id == f14::ROOT_VALUE_TIEBREAK_PROFILE {
        AllocationMode::RootValueTiebreakV1
    } else if profile_id == f14::LEAF_CONVERSION_PROFILE {
        AllocationMode::LeafConversionV1
    } else if profile_id == f14::LEAF_CONVERSION_GATED_PROFILE {
        AllocationMode::LeafConversionGatedV1
    } else if profile_id == f14::LEAF_CONVERSION_PRESSURE_GATED_PROFILE {
        AllocationMode::LeafConversionPressureGatedV1
    } else if profile_id == f14::LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE {
        AllocationMode::LeafConversionGatedB2bChargeV1
    } else if allocation_mode == Some("conversion-permutation-v1") {
        AllocationMode::PermutationV1
    } else {
        AllocationMode::Off
    }
}

/// Prepare the in-process decision with a fresh, never-cancelled runtime for a
/// request the WASM driver has already admitted with the same profile (the
/// driver's `admit` is the same first check, so it is not repeated here).
/// Native callers use the cancel-aware variant after preserving their gate and
/// cancellation checks.
pub(crate) fn prepare_admitted(
    request: Json,
    profile: &Profile,
    config: Arc<BotConfig>,
    token: u64,
    observation: Option<RootObservation>,
) -> Result<Prepared, Json> {
    prepare_admitted_reusing(request, profile, config, token, observation, None)
}

/// `prepare_admitted` that may continue `retained`, the previous request's
/// finished bot, when the profile carries `tree_reuse_floor`.
pub(crate) fn prepare_admitted_reusing(
    request: Json,
    profile: &Profile,
    config: Arc<BotConfig>,
    token: u64,
    observation: Option<RootObservation>,
    retained: Option<Bot>,
) -> Result<Prepared, Json> {
    prepare_inner(
        request,
        profile,
        config,
        token,
        observation,
        Arc::new(AtomicBool::new(false)),
        true,
        retained,
    )
}

/// Native-only lifecycle adapter. `admitted` is true because sync.rs must do
/// the admission check before its cancellation checks to preserve response
/// ordering exactly.
pub(crate) fn prepare_after_admit_with_cancel(
    request: Json,
    profile: &Profile,
    config: Arc<BotConfig>,
    token: u64,
    observation: Option<RootObservation>,
    cancel: Arc<AtomicBool>,
) -> Result<Prepared, Json> {
    // Time budgets rely on the WASM host's clock and early finish; the native
    // job has no such caller.
    if profile.is_time_budget() {
        return Err(f14::error(&request, "unsupported", "time-budget-requires-wasm-host"));
    }
    prepare_after_admit_with_cancel_reusing(request, profile, config, token, observation, cancel, None)
}

/// Native counterpart of `prepare_admitted_reusing`.
pub(crate) fn prepare_after_admit_with_cancel_reusing(
    request: Json,
    profile: &Profile,
    config: Arc<BotConfig>,
    token: u64,
    observation: Option<RootObservation>,
    cancel: Arc<AtomicBool>,
    retained: Option<Bot>,
) -> Result<Prepared, Json> {
    if profile.is_time_budget() {
        return Err(f14::error(&request, "unsupported", "time-budget-requires-wasm-host"));
    }
    prepare_inner(request, profile, config, token, observation, cancel, true, retained)
}

fn prepare_inner(
    request: Json,
    profile: &Profile,
    config: Arc<BotConfig>,
    token: u64,
    observation: Option<RootObservation>,
    cancel: Arc<AtomicBool>,
    admitted: bool,
    retained: Option<Bot>,
) -> Result<Prepared, Json> {
    if !admitted {
        f14::admit(&request, profile)?;
    }
    // A time budget is enforced by the host; the runtime deadline then only
    // bounds the ranking that follows the early finish.
    let hard_millis = if profile.is_time_budget() {
        profile.budget.max_millis + 30_000
    } else {
        profile.budget.max_millis
    };
    let limits = F14RuntimeLimits {
        deadline: Instant::now() + Duration::from_millis(hard_millis),
        cancel,
    };
    let start: crate::tbp::Start = match request.get("start").cloned() {
        Some(value) => match serde_json::from_value(value) {
            Ok(start) => start,
            Err(_) => return Err(f14::error(&request, "error", "invalid-input")),
        },
        None => return Err(f14::error(&request, "error", "invalid-input")),
    };
    let reuse_floor = config.tree_reuse_floor;
    let bag_unknown = matches!(start.randomizer, crate::tbp::Randomizer::SevenBag { bag_state } if bag_state.is_empty());
    let mut bot = match crate::create_bot(start, config) {
        Ok(bot) => bot,
        Err(_) => return Err(f14::error(&request, "error", "invalid-input")),
    };
    if reuse_floor > 0 {
        bot.reuse_profile_key = serde_json::to_string(profile).ok();
    }
    let mut unusable_tree = None;
    let reuse_started = crate::time::Instant::now();
    let reuse = if reuse_floor > 0 {
        Some(match retained {
            None => ReuseReport { reused: false, inherited: 0, credited: 0, reason: "no-tree", micros: 0 },
            Some(previous) => match previous.reuse_for(&bot, bag_unknown) {
                Ok((continued, inherited, bag_differs)) => {
                    unusable_tree = Some(std::mem::replace(&mut bot, continued));
                    let credited = inherited.min(profile.budget.selections.saturating_sub(reuse_floor));
                    let reason = if bag_differs { "continued-bag" } else { "continued" };
                    let micros = reuse_started.elapsed().as_micros() as u64;
                    ReuseReport { reused: true, inherited, credited, reason, micros }
                }
                Err((previous, reason)) => {
                    unusable_tree = Some(previous);
                    let micros = reuse_started.elapsed().as_micros() as u64;
                    ReuseReport { reused: false, inherited: 0, credited: 0, reason, micros }
                }
            },
        })
    } else {
        unusable_tree = retained;
        None
    };
    let composed_state = if profile.uses_core_decision() {
        match f14::composed_public_state(&request) {
            Ok(state) => Some(state),
            Err(compat_error) => return Err(f14::compat_error_response(&request, compat_error)),
        }
    } else {
        None
    };
    let mut composed_context = if let Some(state) = composed_state.as_ref() {
        match crate::f14_compat::select::PublicRootLockContext::for_profile(
            state,
            &limits,
            profile.is_public_amount(),
        ) {
            Ok(context) => Some(context),
            Err(compat_error) => return Err(f14::compat_error_response(&request, compat_error)),
        }
    } else {
        None
    };
    let root_session = if profile.uses_core_decision() {
        let context = match composed_context.take() {
            Some(context) => context,
            None => {
                return Err(f14::compat_error_response(
                    &request,
                    CompatError::InvalidSelector,
                ))
            }
        };
        let digest = match composed_state.as_ref() {
            Some(state) => f14::public_context_digest_for_state(state, &request, profile),
            None => {
                return Err(f14::compat_error_response(
                    &request,
                    CompatError::InvalidSelector,
                ))
            }
        };
        let allocation_mode = allocation_mode_for(
            &profile.profile_id,
            profile.allocation_mode.as_deref(),
        );
        let session = RootObjectiveSession::new_with_allocation_mode_and_scales(
            context,
            profile.decision_stage(),
            profile.budget.selections,
            token,
            digest,
            allocation_mode,
            profile.root_value_scale_f64().unwrap_or(1.0),
            profile.leaf_conversion_scale_f64(),
            profile.leaf_conversion_max_height_u32(),
        );
        if let Some(observation) = observation {
            session.attach_observation(observation);
        }
        if let Some(report) = reuse.as_ref() {
            session.credit_inherited(report.credited);
        }
        Some(Arc::new(session))
    } else {
        None
    };
    if let Some(session) = root_session.as_ref() {
        if let Err(compat_error) =
            bot.attach_root_session(Arc::clone(session), profile.worker_concurrency)
        {
            return Err(f14::compat_error_response(&request, compat_error));
        }
    }
    Ok(Prepared {
        request,
        profile: profile.clone(),
        bot: Some(bot),
        root_session,
        limits,
        token,
        reuse,
        unusable_tree,
    })
}

impl Prepared {
    pub(crate) fn take_bot(&mut self) -> Bot {
        self.bot.take().expect("prepared F14 bot already taken")
    }
}

pub(crate) fn finish(
    prepared: Prepared,
    moves: &[crate::data::Placement],
    info: MoveInfo,
    ended: FinishEnd,
) -> Json {
    finish_with_hook(prepared, moves, info, ended, None)
}

pub(crate) fn finish_with_hook(
    prepared: Prepared,
    moves: &[crate::data::Placement],
    info: MoveInfo,
    ended: FinishEnd,
    hook: Option<&f14::F14CancelHook>,
) -> Json {
    let reuse = prepared.reuse.as_ref().map(|report| report.to_json(prepared.profile.budget.selections));
    let mut response = finish_response(prepared, moves, info, ended, hook);
    if let Some(reuse) = reuse {
        if response["search"].is_object() {
            response["search"]["reuse"] = reuse;
        }
    }
    response
}

fn finish_response(
    prepared: Prepared,
    moves: &[crate::data::Placement],
    info: MoveInfo,
    ended: FinishEnd,
    hook: Option<&f14::F14CancelHook>,
) -> Json {
    let Prepared {
        request,
        profile,
        bot: _,
        root_session,
        limits,
        token,
        reuse: _,
        unusable_tree: _,
    } = prepared;
    let root_outcome = root_session.as_ref().map(|session| session.take_outcome());

    // A published root outcome is authoritative even when cancellation,
    // deadline, or stop wins the synchronizer race. Composed profiles retain
    // the former snapshot timing: they consume a typed outcome only for a
    // Budget ending.
    let mut forced_root = None;
    let mut root_not_ready = false;
    let consume_core_outcome = core_outcome_is_authoritative(&profile, ended);
    if profile.uses_core_decision() && consume_core_outcome {
        match root_outcome {
            Some(Err(compat_error)) => return f14::compat_error_response(&request, compat_error),
            Some(Ok(Some(FinishedRootOutcome::Failed(compat_error)))) => {
                return f14::compat_error_response(&request, compat_error);
            }
            Some(Ok(Some(FinishedRootOutcome::Decided(decision)))) => {
                if !root_stats_match_suggest_end(
                    ended,
                    decision.completed_selections,
                    decision.nodes,
                    &info,
                ) {
                    return f14::compat_error_response(
                        &request,
                        CompatError::RootOutcomeStatsMismatch,
                    );
                }
                let root_stats = SearchStats {
                    nodes: decision.nodes,
                    selections: decision.completed_selections,
                };
                forced_root = Some((decision.native_moves.clone(), Some(decision), root_stats));
            }
            Some(Ok(Some(FinishedRootOutcome::NoCandidates {
                completed_selections,
                nodes,
            }))) => {
                if !root_stats_match_suggest_end(ended, completed_selections, nodes, &info) {
                    return f14::compat_error_response(
                        &request,
                        CompatError::RootOutcomeStatsMismatch,
                    );
                }
                forced_root = Some((
                    Vec::new(),
                    None,
                    SearchStats {
                        nodes,
                        selections: completed_selections,
                    },
                ));
            }
            Some(Ok(None)) | None => root_not_ready = true,
        }
    }
    if let Some((decision_moves, root_decision, root_stats)) = forced_root {
        // `prepare` admitted this request before the search started.
        return f14::decide_limited_with_core_admitted(
            request,
            &profile,
            &decision_moves,
            root_stats,
            None,
            None,
            token,
            root_decision,
        );
    }
    match ended {
        FinishEnd::Cancelled | FinishEnd::Stopped => {
            f14::error(&request, "incomplete", "cancelled")
        }
        FinishEnd::Failed(reason) => f14::error(&request, "error", reason),
        FinishEnd::Deadline => f14::error(&request, "incomplete", "deadline"),
        FinishEnd::Budget => {
            if profile.uses_core_decision() && root_not_ready {
                return f14::compat_error_response(&request, CompatError::RootOutcomeNotReady);
            }
            f14::decide_limited(
                request,
                &profile,
                moves,
                SearchStats {
                    nodes: info.nodes,
                    selections: info.selections,
                },
                Some(&limits),
                hook,
                token,
            )
        }
    }
}

pub(crate) fn root_stats_match_suggest_end(
    ended: FinishEnd,
    completed_selections: u64,
    nodes: u64,
    info: &MoveInfo,
) -> bool {
    !matches!(ended, FinishEnd::Budget)
        || (completed_selections == info.selections && nodes == info.nodes)
}

fn core_outcome_is_authoritative(profile: &Profile, ended: FinishEnd) -> bool {
    profile.uses_core_snapshot() || matches!(ended, FinishEnd::Budget)
}

#[allow(dead_code)]
fn _statistics_search_stats(stats: Statistics) -> SearchStats {
    SearchStats {
        nodes: stats.nodes,
        selections: stats.selections,
    }
}

#[cfg(test)]
mod root_allocation_mode_tests {
    use super::*;
    use crate::f14_compat::transport::{
        A_PROFILE, COMPOSED_A, COMPOSED_B, CORE_ALLSPIN_PROFILE, PUBLIC_PROFILE,
        RANK_ORDER_PROFILE, ROOT_OBJECTIVE_PROFILE, ROOT_VALUE_MIX_PROFILE,
        LEAF_CONVERSION_GATED_PROFILE, LEAF_CONVERSION_PRESSURE_GATED_PROFILE,
        LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE,
        LEAF_CONVERSION_PROFILE, ROOT_VALUE_TIEBREAK_PROFILE,
    };

    #[test]
    fn root_value_mode_is_opt_in_and_existing_profiles_keep_their_modes() {
        assert_eq!(
            allocation_mode_for(f14::ROOT_VALUE_PROFILE, None),
            AllocationMode::RootValueV1
        );
        assert_eq!(
            allocation_mode_for(ROOT_VALUE_MIX_PROFILE, Some("root-value-mix-v1")),
            AllocationMode::RootValueMixV1
        );
        assert_eq!(
            allocation_mode_for(ROOT_VALUE_TIEBREAK_PROFILE, Some("root-value-tiebreak-v1")),
            AllocationMode::RootValueTiebreakV1
        );
        assert_eq!(
            allocation_mode_for(LEAF_CONVERSION_PROFILE, Some("leaf-conversion-v1")),
            AllocationMode::LeafConversionV1
        );
        assert_eq!(
            allocation_mode_for(
                LEAF_CONVERSION_GATED_PROFILE,
                Some("leaf-conversion-gated-v1")
            ),
            AllocationMode::LeafConversionGatedV1
        );
        assert_eq!(
            allocation_mode_for(
                LEAF_CONVERSION_PRESSURE_GATED_PROFILE,
                Some("leaf-conversion-pressure-gated-v1")
            ),
            AllocationMode::LeafConversionPressureGatedV1
        );
        assert_eq!(
            allocation_mode_for(
                LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE,
                Some("leaf-conversion-gated-b2b-charge-v1")
            ),
            AllocationMode::LeafConversionGatedB2bChargeV1
        );
        for profile_id in [
            A_PROFILE,
            PUBLIC_PROFILE,
            COMPOSED_A,
            COMPOSED_B,
            CORE_ALLSPIN_PROFILE,
            RANK_ORDER_PROFILE,
        ] {
            assert_eq!(allocation_mode_for(profile_id, None), AllocationMode::Off, "{profile_id}");
        }
        assert_eq!(
            allocation_mode_for(ROOT_OBJECTIVE_PROFILE, Some("off")),
            AllocationMode::Off
        );
        assert_eq!(
            allocation_mode_for(ROOT_OBJECTIVE_PROFILE, Some("conversion-permutation-v1")),
            AllocationMode::PermutationV1
        );
    }
}
