use std::sync::Arc;

use serde_json::Value as Json;

use crate::bot::{BotConfig, Statistics};
use crate::tbp::MoveInfo;

use super::inproc::{self, FinishEnd, Prepared};
use super::select::FinishedRootOutcome;
use super::transport::{self as f14, Profile};
use super::CompatError;
use crate::time::Instant;

/// Progress returned by one bounded F14 work request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WorkProgress {
    pub(crate) nodes: u64,
    pub(crate) selections: u64,
    pub(crate) complete: bool,
}

#[derive(Clone)]
pub(crate) struct F14RerankState {
    pub(crate) request: Json,
    pub(crate) profile: Profile,
    pub(crate) outcome: FinishedRootOutcome,
}

/// Sync-free F14 lifecycle shared by the native-shaped WASM adapter and tests.
pub(crate) struct F14Driver {
    pub(crate) prepared: Prepared,
    pub(crate) stats: Statistics,
    pub(crate) limit: u64,
    pub(crate) ended: Option<FinishEnd>,
}

impl F14Driver {
    pub(crate) fn start(profile: Profile, request: Json) -> Result<Self, Json> {
        // Keep this admission check before every other start-side operation. It
        // is the same first check performed by inproc::prepare and the native
        // job, including the response identity and error ordering.
        f14::admit(&request, &profile)?;

        let mut config: BotConfig = serde_json::from_str(profile.config_bytes())
            .map_err(|_| f14::error(&request, "error", "invalid-input"))?;
        config.search_seed = profile
            .seed_u64()
            .ok_or_else(|| f14::error(&request, "error", "invalid-input"))?;
        config.search_selection_limit = profile.budget.selections;
        config.enable_s2_amount_only_incoming = false;

        let token = request
            .get("generation")
            .and_then(Json::as_u64)
            .unwrap_or(0);
        let limit = profile.budget.selections;
        // Admitted above with this profile; prepare must not repeat it.
        let prepared = inproc::prepare_admitted(
            request,
            &profile,
            Arc::new(config),
            token,
            None,
        )?;
        Ok(Self {
            prepared,
            stats: Statistics::default(),
            limit,
            ended: None,
        })
    }

    pub(crate) fn work(&mut self, selections: u32) -> WorkProgress {
        if self.ended.is_none() {
            let target = self
                .stats
                .selections
                .saturating_add(u64::from(selections))
                .min(self.limit);
            while self.stats.selections < target {
                // The native job checks its wall clock before waiting for each
                // unit of work; a passed deadline ends the request as
                // `incomplete/deadline` before more search happens.
                if deadline_reached(&self.prepared) {
                    self.ended = Some(FinishEnd::Deadline);
                    break;
                }
                let before = self.stats.selections;
                let result = self
                    .prepared
                    .bot
                    .as_ref()
                    .expect("F14 prepared bot")
                    .do_work();
                match result {
                    Ok(stats) => {
                        self.stats.accumulate(stats);
                        if self.stats.selections == before {
                            break;
                        }
                    }
                    Err(error) => {
                        self.ended = Some(finish_end(error));
                        break;
                    }
                }
            }
        }
        WorkProgress {
            nodes: self.stats.nodes,
            selections: self.stats.selections,
            complete: self.ended.is_some() || self.stats.selections >= self.limit,
        }
    }

    /// Time budget only: the host's deadline passed before the selection cap.
    /// Rank what the search has now, exactly as a budget end would.
    pub(crate) fn finish_early(self) -> Json {
        self.finish_early_with_retained().0
    }

    pub(crate) fn finish_early_with_retained(mut self) -> (Json, Option<F14RerankState>) {
        if !self.prepared.profile.is_time_budget() {
            return (
                f14::error(&self.prepared.request, "error", "invalid-input"),
                None,
            );
        }
        // Even a very short think time decides from at least one selection.
        if self.ended.is_none() && self.stats.selections == 0 {
            self.work(8);
        }
        if self.ended.is_none() && self.stats.selections < self.limit {
            if let (Some(root), Some(bot)) =
                (self.prepared.root_session.as_ref(), self.prepared.bot.as_ref())
            {
                // A failure is published into the session and reported by finish.
                let _ = root.complete_early(|| bot.suggest());
            }
            self.limit = self.stats.selections;
        }
        self.finish_with_retained()
    }

    pub(crate) fn finish(self) -> Json {
        self.finish_with_retained().0
    }

    pub(crate) fn finish_with_retained(mut self) -> (Json, Option<F14RerankState>) {
        // Complete the budget if the caller did not drive `work` to the end;
        // a bot that stops making progress ends the loop like the old adapter.
        while self.ended.is_none() && self.stats.selections < self.limit {
            let before = self.stats.selections;
            self.work(64);
            if self.ended.is_none() && self.stats.selections == before {
                break;
            }
        }
        // The native job re-checks its clock after the budget wait, so a
        // deadline that passed during the last unit of work still wins.
        if self.ended.is_none() && deadline_reached(&self.prepared) {
            self.ended = Some(FinishEnd::Deadline);
        }
        let moves: Vec<crate::data::Placement> = self
            .prepared
            .bot
            .as_ref()
            .map(|bot| bot.suggest().into_iter().map(|(placement, _)| placement).collect())
            .unwrap_or_default();
        let info = MoveInfo {
            nodes: self.stats.nodes,
            selections: self.stats.selections,
            candidate_values: Vec::new(),
            nps: 0.0,
            extra: "selection budget complete".to_owned(),
        };
        let retained_outcome = if self.prepared.profile.profile_id == f14::PUBLIC_PROFILE
            || self.prepared.profile.profile_id == f14::LEAF_CONVERSION_GATED_PROFILE
        {
            self.prepared
                .root_session
                .as_ref()
                .and_then(|session| session.published_outcome())
        } else {
            None
        };
        let retained_request = self.prepared.request.clone();
        let retained_profile = self.prepared.profile.clone();
        let response = inproc::finish(
            self.prepared,
            &moves,
            info,
            self.ended.take().unwrap_or(FinishEnd::Budget),
        );
        let retained = match (
            response["status"].as_str(),
            response["reason"].as_str(),
            retained_outcome,
        ) {
            (Some("move"), _, Some(outcome @ FinishedRootOutcome::Decided(_)))
            | (Some("root-no-move"), _, Some(outcome @ FinishedRootOutcome::NoCandidates { .. }))
            | (
                Some("error"),
                Some("empty-candidates"),
                Some(outcome @ FinishedRootOutcome::NoCandidates { .. }),
            ) => Some(F14RerankState {
                request: retained_request,
                profile: retained_profile,
                outcome,
            }),
            _ => None,
        };
        (response, retained)
    }
}

/// Same mapping as the native worker (`sync.rs` `work_loop`): a `do_work`
/// error is a search failure. Deadline and cancellation are never derived from
/// it; the native job observes them on its own clock and flag, which the
/// driver mirrors with `deadline_reached`.
fn finish_end(error: CompatError) -> FinishEnd {
    match error {
        CompatError::ChainOverflow => FinishEnd::Failed("chain-overflow"),
        _ => FinishEnd::Failed("search-error"),
    }
}

fn deadline_reached(prepared: &Prepared) -> bool {
    Instant::now() >= prepared.limits.deadline
}
