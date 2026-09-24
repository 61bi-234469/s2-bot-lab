use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;
use std::time::Instant;

#[cfg(test)]
thread_local! {
    static F14_BOT_STARTS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

use parking_lot::{Condvar, Mutex, RwLock};

use crate::bot::{Bot, Statistics};
use crate::data::{AdvanceError, Piece, Placement};
use crate::f14_compat::{
    inproc::{self, FinishEnd},
    CompatError,
};
use crate::tbp::MoveInfo;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SuggestEnd {
    Budget,
    Deadline,
    Cancelled,
    Stopped,
    Failed(&'static str),
}

pub struct BotSyncronizer {
    state: Mutex<State>,
    blocker: Condvar,
    bot: RwLock<Option<Bot>>,
    // Destroying a mature DAG can take long enough to stall the protocol
    // thread. Hand retired bots to this dedicated owner, but use a rendezvous
    // channel so at most one old DAG is being reclaimed. An unbounded backlog
    // retains one mature DAG per suggestion and can exhaust host memory.
    retired_bots: SyncSender<Bot>,
}

impl BotSyncronizer {
    pub fn new() -> Self {
        BotSyncronizer {
            state: Mutex::new(State {
                stats: Default::default(),
                last_advance: Instant::now(),
                selection_limit: u64::MAX,
                start: Instant::now(),
                nodes_since_start: 0,
                failure: None,
            }),
            blocker: Condvar::new(),
            bot: RwLock::new(None),
            retired_bots: spawn_retirement_reclaimer(),
        }
    }

    pub fn start(&self, initial_state: Bot) {
        let retired = {
            let mut state = self.state.lock();
            state.stats = Default::default();
            state.nodes_since_start = 0;
            state.start = Instant::now();
            state.selection_limit = initial_state.search_selection_limit();
            state.failure = None;
            let retired = {
                let mut bot = self.bot.write();
                std::mem::replace(&mut *bot, Some(initial_state))
            };
            self.blocker.notify_all();
            retired
        };
        // A rendezvous send can wait for the reclaimer. Never do that while
        // holding state or bot locks, or a slow DAG destruction would block
        // workers and suggestions behind those locks.
        self.reclaim(retired);
    }

    pub fn stop(&self) {
        let retired = self.bot.write().take();
        self.reclaim(retired);
        self.blocker.notify_all();
    }

    pub fn suggest(&self) -> (Vec<Placement>, MoveInfo) {
        self.suggest_with_limit_wait(true)
    }

    pub fn suggest_now(&self) -> (Vec<Placement>, MoveInfo) {
        self.suggest_with_limit_wait(false)
    }

    pub fn suggest_until(
        &self,
        deadline: Instant,
        cancel: &AtomicBool,
    ) -> (Vec<Placement>, MoveInfo, SuggestEnd) {
        self.suggest_until_inner(deadline, cancel, None)
    }

    fn suggest_until_inner(
        &self,
        deadline: Instant,
        cancel: &AtomicBool,
        hook: Option<&crate::f14_compat::transport::F14CancelHook>,
    ) -> (Vec<Placement>, MoveInfo, SuggestEnd) {
        let mut state = self.state.lock();
        while state.selection_limit != u64::MAX && state.stats.selections < state.selection_limit {
            if let Some(reason) = state.failure {
                return (Vec::new(), empty_move_info(), SuggestEnd::Failed(reason));
            }
            if cancel.load(Ordering::Acquire) {
                return (Vec::new(), empty_move_info(), SuggestEnd::Cancelled);
            }
            if Instant::now() >= deadline {
                return (Vec::new(), empty_move_info(), SuggestEnd::Deadline);
            }
            if self.bot.read().is_none() {
                return (Vec::new(), empty_move_info(), SuggestEnd::Stopped);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || self.blocker.wait_for(&mut state, remaining).timed_out() {
                return (Vec::new(), empty_move_info(), SuggestEnd::Deadline);
            }
        }
        crate::f14_compat::transport::F14CancelHook::park(
            hook.and_then(|value| value.after_budget_wait.as_ref()),
        );
        if cancel.load(Ordering::Acquire) {
            return (Vec::new(), empty_move_info(), SuggestEnd::Cancelled);
        }
        if Instant::now() >= deadline {
            return (Vec::new(), empty_move_info(), SuggestEnd::Deadline);
        }
        drop(state);
        let (moves, info) = self.suggest_with_limit_wait(false);
        if self.bot.read().is_none() {
            match self.state.lock().failure {
                Some(reason) => (Vec::new(), empty_move_info(), SuggestEnd::Failed(reason)),
                None => (Vec::new(), empty_move_info(), SuggestEnd::Stopped),
            }
        } else {
            (moves, info, SuggestEnd::Budget)
        }
    }

    fn suggest_with_limit_wait(&self, wait_for_limit: bool) -> (Vec<Placement>, MoveInfo) {
        let mut state = self.state.lock();
        while wait_for_limit
            && state.selection_limit != u64::MAX
            && state.stats.selections < state.selection_limit
        {
            if self.bot.read().is_none() {
                return (Vec::new(), empty_move_info());
            }
            self.blocker.wait(&mut state);
        }
        let stats = state.stats;
        let nps = stats.nodes as f64 / state.last_advance.elapsed().as_secs_f64();
        let extra = format!(
            "{:.1}% of selections expanded, overall speed: {:.1} Mnps",
            stats.expansions as f64 / stats.selections as f64 * 100.0,
            state.nodes_since_start as f64 / state.start.elapsed().as_secs_f64() / 1_000_000.0
        );
        let omitted = stats.amount_top_out_omitted;
        drop(state);

        let bot = self.bot.read();
        match bot.as_ref() {
            Some(bot) => {
                let candidates = bot.suggest();
                let (moves, candidate_values): (Vec<_>, Vec<_>) = candidates.into_iter().unzip();
                let extra =
                    match bot.amount_only_extra_json(omitted, moves.is_empty() && omitted > 0) {
                        Some(json) => format!("{extra} {json}"),
                        None => extra,
                    };
                let info = MoveInfo {
                    nodes: stats.nodes,
                    selections: stats.selections,
                    candidate_values,
                    nps,
                    extra,
                };
                (moves, info)
            }
            // A stop can win the race after the fixed-budget wait above.  The
            // protocol must still answer every Suggest request: a silent
            // process is indistinguishable from a hung one to its frontend.
            None => (Vec::new(), empty_move_info()),
        }
    }

    fn reclaim(&self, bot: Option<Bot>) {
        if let Some(bot) = bot {
            // The receiver lasts for the synchronizer's lifetime.  If it has
            // unexpectedly stopped, dropping here is the only safe fallback.
            let _ = self.retired_bots.send(bot);
        }
    }

    pub fn try_advance(&self, mv: Placement) -> Result<(), AdvanceError> {
        let mut state = self.state.lock();
        let mut bot = self.bot.write();
        if let Some(bot) = &mut *bot {
            bot.try_advance(mv)?;
            state.stats = Default::default();
            state.last_advance = Instant::now();
            self.blocker.notify_all();
        }
        Ok(())
    }

    pub fn advance(&self, mv: Placement) {
        self.try_advance(mv)
            .expect("Bot synchronizer advance failed");
    }

    pub fn new_piece(&self, piece: Piece) {
        let mut bot = self.bot.write();
        if let Some(bot) = &mut *bot {
            bot.new_piece(piece);
        }
        self.blocker.notify_all();
    }

    pub fn work_loop(&self) {
        let mut state = self.state.lock();
        loop {
            if state.stats.selections >= state.selection_limit {
                self.blocker.wait(&mut state);
                continue;
            }
            let bot_guard = self.bot.read();
            let bot = match &*bot_guard {
                Some(bot) => bot,
                None => {
                    drop(bot_guard);
                    self.blocker.wait(&mut state);
                    continue;
                }
            };

            drop(state);
            let result = bot.do_work();
            drop(bot_guard);

            state = self.state.lock();
            match result {
                Ok(new_stats) => {
                    state.stats.accumulate(new_stats);
                    state.nodes_since_start += new_stats.nodes;
                    self.blocker.notify_all();
                }
                Err(error) => {
                    state.failure = Some(match error {
                        CompatError::ChainOverflow => "chain-overflow",
                        _ => "search-error",
                    });
                    self.blocker.notify_all();
                    drop(state);
                    self.stop();
                    state = self.state.lock();
                }
            }
        }
    }
}

fn spawn_retirement_reclaimer<T: Send + 'static>() -> SyncSender<T> {
    // A zero-capacity channel allows one value to be in Drop, but no queue of
    // additional values. The next retirement waits until that Drop completes.
    let (sender, receiver) = mpsc::sync_channel(0);
    std::thread::spawn(move || {
        while let Ok(value) = receiver.recv() {
            drop(value);
        }
    });
    sender
}

fn root_stats_match_suggest_end(
    ended: SuggestEnd,
    completed_selections: u64,
    nodes: u64,
    info: &MoveInfo,
) -> bool {
    inproc::root_stats_match_suggest_end(
        match ended {
            SuggestEnd::Budget => FinishEnd::Budget,
            SuggestEnd::Deadline => FinishEnd::Deadline,
            SuggestEnd::Cancelled => FinishEnd::Cancelled,
            SuggestEnd::Stopped => FinishEnd::Stopped,
            SuggestEnd::Failed(reason) => FinishEnd::Failed(reason),
        },
        completed_selections,
        nodes,
        info,
    )
}

fn core_outcome_is_authoritative(
    profile: &crate::f14_compat::transport::Profile,
    ended: SuggestEnd,
) -> bool {
    profile.uses_core_snapshot() || matches!(ended, SuggestEnd::Budget)
}

fn empty_move_info() -> MoveInfo {
    MoveInfo {
        nodes: 0,
        selections: 0,
        candidate_values: Vec::new(),
        nps: 0.0,
        extra: "no active bot".to_owned(),
    }
}

#[derive(Copy, Clone, Debug)]
struct State {
    stats: Statistics,
    last_advance: Instant,
    selection_limit: u64,
    start: Instant,
    nodes_since_start: u64,
    failure: Option<&'static str>,
}

#[cfg(test)]
mod tests {
    use super::spawn_retirement_reclaimer;
    use super::BotSyncronizer;
    use super::{root_stats_match_suggest_end, MoveInfo, SuggestEnd};
    use crate::bot::Statistics;
    use crate::f14_compat::driver::F14Driver;
    use crate::f14_compat::transport::{self, SearchStats};
    use std::sync::atomic::AtomicBool;
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    struct BlockOnDrop {
        started: Option<mpsc::Sender<()>>,
        release: Option<mpsc::Receiver<()>>,
    }

    impl BlockOnDrop {
        fn blocking(started: mpsc::Sender<()>, release: mpsc::Receiver<()>) -> Self {
            Self {
                started: Some(started),
                release: Some(release),
            }
        }

        fn immediate() -> Self {
            Self {
                started: None,
                release: None,
            }
        }
    }

    impl Drop for BlockOnDrop {
        fn drop(&mut self) {
            if let Some(started) = self.started.take() {
                started.send(()).unwrap();
                self.release.take().unwrap().recv().unwrap();
            }
        }
    }

    #[test]
    fn suggest_without_an_active_bot_returns_an_empty_protocol_result() {
        let bot = BotSyncronizer::new();
        let (moves, info) = bot.suggest();

        assert!(moves.is_empty());
        assert_eq!(info.nodes, 0);
        assert_eq!(info.selections, 0);
        assert_eq!(info.extra, "no active bot");
    }

    #[test]
    fn retirement_reclaimer_does_not_queue_a_second_mature_value() {
        let reclaimer = spawn_retirement_reclaimer();
        let (drop_started, drop_started_rx) = mpsc::channel();
        let (release_drop, release_drop_rx) = mpsc::channel();
        reclaimer
            .send(BlockOnDrop::blocking(drop_started, release_drop_rx))
            .unwrap();
        drop_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let (second_sent, second_sent_rx) = mpsc::channel();
        let second_reclaimer = reclaimer.clone();
        let sender = thread::spawn(move || {
            second_reclaimer.send(BlockOnDrop::immediate()).unwrap();
            second_sent.send(()).unwrap();
        });

        assert!(second_sent_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        release_drop.send(()).unwrap();
        second_sent_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        sender.join().unwrap();
    }

    fn f14_profile() -> crate::f14_compat::transport::Profile {
        serde_json::from_value(serde_json::json!({
            "profileId": "f14-amount-only-compat-a/1",
            "configHash": crate::f14_compat::transport::CONFIG_HASH,
            "seed": "1395802947",
            "workerConcurrency": 1,
            "budget": { "mode": "selection", "selections": 8, "maxMillis": 30000 }
        }))
        .unwrap()
    }

    fn root_profile() -> crate::f14_compat::transport::Profile {
        let mut profile = f14_profile();
        profile.profile_id = crate::f14_compat::transport::ROOT_OBJECTIVE_PROFILE.into();
        profile.seed = "5994928009864282113".into();
        profile.budget.selections = 512;
        profile.allocation_mode = Some("off".into());
        profile
    }

    fn root_request() -> serde_json::Value {
        let mut request = f14_request();
        request["requestId"] = serde_json::json!("f14-root-production");
        request["positionId"] = serde_json::json!("f14-root-production");
        request["execution"] = serde_json::to_value(root_profile()).unwrap();
        request
    }

    fn root_config() -> std::sync::Arc<crate::bot::BotConfig> {
        let mut config: crate::bot::BotConfig =
            serde_json::from_str(crate::f14_compat::transport::CONFIG).unwrap();
        config.search_seed = 5_994_928_009_864_282_113_u64;
        config.search_selection_limit = 512;
        config.enable_s2_amount_only_incoming = false;
        std::sync::Arc::new(config)
    }

    #[test]
    fn f14_driver_no_candidates_matches_transport_boundary() {
        let profile = root_profile();
        let request = root_request();
        let mut driver = F14Driver::start(profile.clone(), request.clone()).expect("driver start");
        let stats = Statistics {
            selections: profile.budget.selections,
            nodes: 23,
            ..Default::default()
        };
        driver
            .prepared
            .root_session
            .as_ref()
            .expect("root session")
            .complete_work(&stats, Vec::new)
            .expect("publish no-candidate outcome");
        driver.stats = stats;
        driver.limit = profile.budget.selections;
        let actual = driver.finish();
        let expected = transport::decide_limited(
            request,
            &profile,
            &[],
            SearchStats {
                nodes: stats.nodes,
                selections: stats.selections,
            },
            None,
            None,
            0,
        );
        assert_eq!(actual, expected);
    }

    fn f14_request() -> serde_json::Value {
        serde_json::json!({
            "type": "f14_decide",
            "schemaVersion": 1,
            "requestId": "f14-cancel-race",
            "positionId": "f14-cancel-race",
            "generation": 1,
            "execution": {
                "profileId": "f14-amount-only-compat-a/1",
                "configHash": crate::f14_compat::transport::CONFIG_HASH,
                "seed": "1395802947",
                "workerConcurrency": 1,
                "budget": { "mode": "selection", "selections": 8, "maxMillis": 30000 }
            },
            "start": {
                "board": vec![vec![Option::<char>::None; 10]; 40],
                "queue": ["T","Z","I","O","J","L","S"],
                "hold": null,
                "combo": 0,
                "back_to_back": false,
                "b2b": 0,
                "randomizer": { "type": "seven_bag", "bag_state": [] }
            },
            "selector": {
                "rulesetId": "tetrio-s2-v19-2c47b3df945f6714449b92d1b44346ef4bf0e1a20e95be8ed10c28be75c66a60-beta-1-5-0",
                "board": {
                    "fidelity": "exact",
                    "width": 10,
                    "height": 40,
                    "visibleHeight": 20,
                    "bufferHeight": 20,
                    "cells": "_".repeat(400)
                },
                "pieces": {
                    "current": "T",
                    "hold": null,
                    "holdAvailable": true,
                    "known": ["Z","I","O","J","L","S"]
                },
                "chain": { "combo": 0, "b2b": 0 },
                "time": { "logicalFrame": 0, "piecesPlaced": 0, "fidelity": "exact", "frameSemantics": "engine-frame" },
                "incoming": { "pendingRows": 0, "dueThisLockRows": 0 }
            }
        })
    }

    fn f14_config() -> std::sync::Arc<crate::bot::BotConfig> {
        let mut config: crate::bot::BotConfig =
            serde_json::from_str(crate::f14_compat::transport::CONFIG).unwrap();
        config.search_seed = 1395802947;
        config.search_selection_limit = 8;
        config.enable_s2_amount_only_incoming = false;
        std::sync::Arc::new(config)
    }

    fn cancel_during(
        hook: crate::f14_compat::transport::F14CancelHook,
        hold: crate::f14_compat::transport::F14Hold,
    ) {
        use crate::f14_compat::transport::F14StartGate;
        use parking_lot::Mutex;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let profile = f14_profile();
        let bot = std::sync::Arc::new(BotSyncronizer::new());
        let worker_bot = bot.clone();
        std::thread::spawn(move || worker_bot.work_loop());
        let flag = Arc::new(AtomicBool::new(false));
        let gate = Arc::new(Mutex::new(F14StartGate::new()));
        gate.lock().begin(1);
        let job_flag = flag.clone();
        let job_gate = gate.clone();
        let job_bot = bot.clone();
        let worker = std::thread::spawn(move || {
            super::f14_decide_job(
                f14_request(),
                &profile,
                f14_config(),
                &job_bot,
                &job_flag,
                1,
                &job_gate,
                Some(&hook),
            )
        });
        hold.wait_entered(Duration::from_secs(5));
        {
            let mut gate = gate.lock();
            gate.invalidate();
        }
        flag.store(true, Ordering::Release);
        bot.stop();
        hold.release();
        let response = worker.join().unwrap();
        assert_eq!(response["status"], "incomplete");
        assert_eq!(response["reason"], "cancelled");
        assert!(response["selectedMove"].is_null());
        let (moves, _) = bot.suggest_now();
        assert!(moves.is_empty());
    }

    #[test]
    fn root_profile_production_path_returns_core_owned_stats() {
        use crate::f14_compat::transport::F14StartGate;
        use parking_lot::Mutex;
        let profile = root_profile();
        let bot = std::sync::Arc::new(BotSyncronizer::new());
        let worker_bot = bot.clone();
        std::thread::spawn(move || worker_bot.work_loop());
        let flag = Arc::new(AtomicBool::new(false));
        let gate = Arc::new(Mutex::new(F14StartGate::new()));
        gate.lock().begin(1);
        let response = super::f14_decide_job(
            root_request(),
            &profile,
            root_config(),
            &bot,
            &flag,
            1,
            &gate,
            None,
        );
        assert_eq!(response["status"], "move");
        assert_eq!(response["diagnostics"]["coreRankingComposeCalls"], 1);
        assert_eq!(response["diagnostics"]["coreRerankCalls"], 1);
        assert_eq!(response["diagnostics"]["postStageRerankCalls"], 0);
        assert_eq!(response["search"]["actualSelections"], 512);
        assert!(response["selectedMove"].is_object());
        bot.stop();
    }

    #[test]
    fn composed_b_profile_production_path_returns_core_owned_decision() {
        use crate::f14_compat::transport::{F14StartGate, COMPOSED_B};
        use parking_lot::Mutex;
        let mut profile = root_profile();
        profile.profile_id = COMPOSED_B.into();
        profile.allocation_mode = None;
        let mut request = root_request();
        request["requestId"] = serde_json::json!("f14-composed-production");
        request["positionId"] = serde_json::json!("f14-composed-production");
        request["execution"] = serde_json::to_value(&profile).unwrap();
        let bot = std::sync::Arc::new(BotSyncronizer::new());
        let worker_bot = bot.clone();
        std::thread::spawn(move || worker_bot.work_loop());
        let flag = Arc::new(AtomicBool::new(false));
        let gate = Arc::new(Mutex::new(F14StartGate::new()));
        gate.lock().begin(1);
        let response = super::f14_decide_job(
            request,
            &profile,
            root_config(),
            &bot,
            &flag,
            1,
            &gate,
            None,
        );
        assert_eq!(response["status"], "move");
        let diagnostics = response["diagnostics"].as_object().unwrap();
        assert_eq!(diagnostics.len(), 3);
        assert!(diagnostics.contains_key("postStageConversionComputeCalls"));
        assert!(diagnostics.contains_key("postStageConversionAddCalls"));
        assert!(diagnostics.contains_key("postStageRerankCalls"));
        assert!(!diagnostics.contains_key("coreRankingComposeCalls"));
        assert_eq!(response["boundaryAudit"]["legacyF14SelectionCalls"], 0);
        assert_eq!(response["boundaryAudit"]["legacyF14RescueCalls"], 0);
        bot.stop();
    }

    #[test]
    fn composed_published_outcome_does_not_override_cancel_after_budget_work() {
        use crate::f14_compat::transport::{F14CancelHook, F14StartGate, COMPOSED_B};
        use parking_lot::Mutex;
        let mut profile = root_profile();
        profile.profile_id = COMPOSED_B.into();
        profile.allocation_mode = None;
        let mut request = f14_request();
        request["requestId"] = serde_json::json!("f14-composed-cancel-race");
        request["positionId"] = serde_json::json!("f14-composed-cancel-race");
        request["execution"] = serde_json::to_value(&profile).unwrap();
        let config = root_config();
        let bot = std::sync::Arc::new(BotSyncronizer::new());
        let worker_bot = bot.clone();
        std::thread::spawn(move || worker_bot.work_loop());
        let flag = Arc::new(AtomicBool::new(false));
        let gate = Arc::new(Mutex::new(F14StartGate::new()));
        gate.lock().begin(1);
        let (park, hold) = crate::f14_compat::transport::F14Park::pair();
        let worker_bot = bot.clone();
        let worker_flag = flag.clone();
        let worker_gate = gate.clone();
        let worker = std::thread::spawn(move || {
            super::f14_decide_job(
                request,
                &profile,
                config,
                &worker_bot,
                &worker_flag,
                1,
                &worker_gate,
                Some(&F14CancelHook {
                    after_flag_check: None,
                    before_start: None,
                    after_selector_enter: None,
                    after_budget_wait: Some(park),
                }),
            )
        });
        hold.wait_entered(Duration::from_secs(5));
        flag.store(true, std::sync::atomic::Ordering::Release);
        bot.stop();
        hold.release();
        let response = worker.join().unwrap();
        assert_eq!(response["status"], "incomplete");
        assert_eq!(response["reason"], "cancelled");
        assert!(response["selectedMove"].is_null());
    }

    #[test]
    fn composed_core_outcome_is_consumed_only_for_budget_endings() {
        use crate::f14_compat::transport::{
            A_PROFILE, CAS_CONFIG_HASH, COMPOSED_B, CORE_ALLSPIN_PROFILE, POST_SPIN_POLICY_OFF,
            PUBLIC_PROFILE,
        };
        let mut composed = root_profile();
        composed.profile_id = COMPOSED_B.into();
        for ended in [
            SuggestEnd::Cancelled,
            SuggestEnd::Stopped,
            SuggestEnd::Deadline,
        ] {
            assert!(!super::core_outcome_is_authoritative(&composed, ended));
        }
        assert!(super::core_outcome_is_authoritative(
            &composed,
            SuggestEnd::Budget
        ));
        for profile_id in [A_PROFILE, PUBLIC_PROFILE, CORE_ALLSPIN_PROFILE] {
            let mut profile = f14_profile();
            profile.profile_id = profile_id.into();
            profile.seed = if profile_id == A_PROFILE {
                "1395802947"
            } else {
                "5994928009864282113"
            }
            .into();
            if profile_id == CORE_ALLSPIN_PROFILE {
                profile.config_hash = CAS_CONFIG_HASH.into();
                profile.post_spin_policy_id = Some(POST_SPIN_POLICY_OFF.into());
            }
            for ended in [
                SuggestEnd::Cancelled,
                SuggestEnd::Stopped,
                SuggestEnd::Deadline,
            ] {
                assert!(!super::core_outcome_is_authoritative(&profile, ended));
            }
            assert!(super::core_outcome_is_authoritative(
                &profile,
                SuggestEnd::Budget
            ));
        }
        assert!(super::core_outcome_is_authoritative(
            &root_profile(),
            SuggestEnd::Cancelled
        ));
        assert!(super::core_outcome_is_authoritative(
            &root_profile(),
            SuggestEnd::Deadline
        ));
    }

    #[test]
    fn composed_missing_core_outcome_is_not_ready() {
        use crate::f14_compat::transport::{F14StartGate, COMPOSED_B};
        use parking_lot::Mutex;
        let mut profile = root_profile();
        profile.profile_id = COMPOSED_B.into();
        profile.allocation_mode = None;
        let mut request = root_request();
        request["requestId"] = serde_json::json!("f14-composed-not-ready");
        request["positionId"] = serde_json::json!("f14-composed-not-ready");
        request["execution"] = serde_json::to_value(&profile).unwrap();
        let mut config = root_config();
        Arc::get_mut(&mut config).unwrap().search_selection_limit = 8;
        let bot = std::sync::Arc::new(BotSyncronizer::new());
        let worker_bot = bot.clone();
        std::thread::spawn(move || worker_bot.work_loop());
        let flag = Arc::new(AtomicBool::new(false));
        let gate = Arc::new(Mutex::new(F14StartGate::new()));
        gate.lock().begin(1);
        let response =
            super::f14_decide_job(request, &profile, config, &bot, &flag, 1, &gate, None);
        assert_eq!(response["status"], "error");
        assert_eq!(response["reason"], "root-outcome-not-ready");
        bot.stop();
    }

    #[test]
    fn amount_and_public_missing_core_outcome_is_not_ready() {
        use crate::f14_compat::transport::{
            F14StartGate, A_PROFILE, CAS_CONFIG, CAS_CONFIG_HASH, CONFIG_HASH,
            CORE_ALLSPIN_PROFILE, POST_SPIN_POLICY_OFF, PUBLIC_PROFILE,
        };
        use parking_lot::Mutex;
        for (profile_id, seed) in [
            (A_PROFILE, "1395802947"),
            (PUBLIC_PROFILE, "5994928009864282113"),
            (CORE_ALLSPIN_PROFILE, "5994928009864282113"),
        ] {
            let mut profile = f14_profile();
            profile.profile_id = profile_id.into();
            profile.seed = seed.into();
            profile.budget.selections = 512;
            if profile_id == CORE_ALLSPIN_PROFILE {
                profile.config_hash = CAS_CONFIG_HASH.into();
                profile.post_spin_policy_id = Some(POST_SPIN_POLICY_OFF.into());
            }
            let mut request = f14_request();
            request["requestId"] = serde_json::json!(format!("f14-{profile_id}-not-ready"));
            request["positionId"] = request["requestId"].clone();
            request["execution"] = serde_json::to_value(&profile).unwrap();
            let config_bytes = if profile_id == CORE_ALLSPIN_PROFILE {
                CAS_CONFIG
            } else {
                assert_eq!(profile.config_hash, CONFIG_HASH);
                crate::f14_compat::transport::CONFIG
            };
            let mut config: Arc<crate::bot::BotConfig> =
                Arc::new(serde_json::from_str(config_bytes).unwrap());
            Arc::get_mut(&mut config).unwrap().search_seed = profile.seed_u64().unwrap();
            Arc::get_mut(&mut config).unwrap().search_selection_limit = 8;
            Arc::get_mut(&mut config)
                .unwrap()
                .enable_s2_amount_only_incoming = false;
            let bot = std::sync::Arc::new(BotSyncronizer::new());
            let worker_bot = bot.clone();
            std::thread::spawn(move || worker_bot.work_loop());
            let flag = Arc::new(AtomicBool::new(false));
            let gate = Arc::new(Mutex::new(F14StartGate::new()));
            gate.lock().begin(1);
            let response =
                super::f14_decide_job(request, &profile, config, &bot, &flag, 1, &gate, None);
            assert_eq!(response["status"], "error");
            assert_eq!(response["reason"], "root-outcome-not-ready");
            bot.stop();
        }
    }

    #[test]
    fn published_root_stats_are_authoritative_for_non_budget_endings() {
        let info = MoveInfo {
            nodes: 0,
            selections: 0,
            candidate_values: Vec::new(),
            nps: 0.0,
            extra: String::new(),
        };
        for ended in [
            SuggestEnd::Cancelled,
            SuggestEnd::Stopped,
            SuggestEnd::Deadline,
            SuggestEnd::Failed("native-failure"),
        ] {
            assert!(root_stats_match_suggest_end(ended, 512, 99, &info));
        }
        assert!(!root_stats_match_suggest_end(
            SuggestEnd::Budget,
            512,
            99,
            &info
        ));
        assert!(root_stats_match_suggest_end(
            SuggestEnd::Budget,
            0,
            0,
            &info,
        ));
    }
    #[test]
    fn f14_cancel_after_flag_check_does_not_start_search() {
        let (park, hold) = crate::f14_compat::transport::F14Park::pair();
        cancel_during(
            crate::f14_compat::transport::F14CancelHook {
                after_flag_check: Some(park),
                before_start: None,
                after_selector_enter: None,
                after_budget_wait: None,
            },
            hold,
        );
    }

    #[test]
    fn f14_cancel_before_start_does_not_start_search() {
        let (park, hold) = crate::f14_compat::transport::F14Park::pair();
        cancel_during(
            crate::f14_compat::transport::F14CancelHook {
                after_flag_check: None,
                before_start: Some(park),
                after_selector_enter: None,
                after_budget_wait: None,
            },
            hold,
        );
    }
}

// Native route owns one cancellable worker; parsing never waits for search completion.
// Joining happens before cancellation acknowledgment or process shutdown.
pub(crate) fn run_native(profile: crate::native_s2::transport::Profile) -> std::io::Result<()> {
    run_s2_session(S2SessionProfile::V1(profile))
}
pub(crate) fn run_integrated(profile: crate::s2_transport::Profile) -> std::io::Result<()> {
    run_s2_session(S2SessionProfile::Integrated(profile))
}
#[derive(Clone)]
enum S2SessionProfile {
    V1(crate::native_s2::transport::Profile),
    Integrated(crate::s2_transport::Profile),
}
impl S2SessionProfile {
    fn error(&self, raw: &serde_json::Value, status: &str, reason: &str) -> serde_json::Value {
        match self {
            Self::V1(_) => crate::native_s2::transport::error(raw, status, reason),
            Self::Integrated(_) => crate::s2_transport::error(raw, status, reason),
        }
    }
    fn decide(&self, raw: serde_json::Value, cancel: Arc<AtomicBool>) -> serde_json::Value {
        match self {
            Self::V1(p) => crate::native_s2::transport::decide(raw, p, cancel),
            Self::Integrated(p) => crate::s2_transport::decide(raw, p, cancel),
        }
    }
}
fn run_s2_session(profile: S2SessionProfile) -> std::io::Result<()> {
    use crate::native_s2::transport as native;
    use serde_json::{json, Value};
    use std::io::Write;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    enum Event {
        Input(Option<Value>),
        Done(u64, Value),
        InputOverflow,
    }
    let integrated_reader = matches!(&profile, S2SessionProfile::Integrated(_));
    let (tx, rx) = mpsc::channel();
    let input_tx = tx.clone();
    // Bound only v2's queued input. Done remains nonblocking so joining a
    // cancelled worker cannot deadlock behind a full reader queue.
    let queued = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let reader_queued = queued.clone();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        loop {
            let value = if integrated_reader {
                crate::tbp::read_json_line_bounded(&mut input, 65_536)
            } else {
                crate::tbp::read_json_line(&mut input)
            };
            let eof = value.is_none();
            if integrated_reader && reader_queued.fetch_add(1, Ordering::AcqRel) >= 4 {
                let _ = input_tx.send(Event::InputOverflow);
                break;
            }
            if input_tx.send(Event::Input(value)).is_err() || eof {
                break;
            }
        }
    });
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let mut emit = |value: &Value| -> std::io::Result<()> {
        serde_json::to_writer(&mut output, value)?;
        output.write_all(b"\n")?;
        output.flush()
    };
    let mut info = json!({"type":"info","name":"Cold Clear 2 S2","version":concat!(env!("CARGO_PKG_VERSION")," ",env!("GIT_HASH")),
        "author":"MinusKelvin + s2-analysis-engine contributors"});
    match &profile {
        S2SessionProfile::V1(_) => {
            info["features"] = json!([native::FEATURE]);
            info["nativeConfig"] = json!(native::CONFIG);
        }
        S2SessionProfile::Integrated(p) => {
            info["features"] = json!([crate::s2_transport::ENGINE_ID]);
            info["integratedConfig"] = json!(crate::s2_transport::CONFIG);
            info["integratedCapability"] = crate::s2_transport::capability(p);
        }
    }
    emit(&info)?;
    let mut ready = false;
    let mut generation = 0_u64;
    let integrated = matches!(&profile, S2SessionProfile::Integrated(_));
    let mut seen = std::collections::HashSet::new();
    let mut last_generation = None;
    let mut worker: Option<(Arc<AtomicBool>, std::thread::JoinHandle<()>, Value)> = None;
    let stop = |worker: &mut Option<(Arc<AtomicBool>, std::thread::JoinHandle<()>, Value)>| {
        if let Some((flag, thread, _)) = worker.take() {
            flag.store(true, Ordering::Release);
            let _ = thread.join();
        }
    };
    let result = (|| -> std::io::Result<()> {
        while let Ok(event) = rx.recv() {
            if integrated && matches!(&event, Event::Input(_)) {
                queued.fetch_sub(1, Ordering::AcqRel);
            }
            match event {
                Event::InputOverflow => {
                    emit(&json!({"type":"protocol_error","reason":"input-backlog-limit"}))?;
                    break;
                }
                Event::Input(None) => break,
                Event::Done(token, response) => {
                    if token == generation {
                        if let Some((_, thread, _)) = worker.take() {
                            let _ = thread.join();
                        }
                        emit(&response)?;
                    }
                }
                Event::Input(Some(raw)) => match raw.get("type").and_then(Value::as_str) {
                    Some("rules") => {
                        ready = true;
                        emit(&json!({"type":"ready"}))?;
                    }
                    Some("quit") => break,
                    Some("s2_cancel") => {
                        let matches = worker.as_ref().map_or(false, |(_, _, request)| {
                            raw.get("requestId") == request.get("requestId")
                                && raw.get("generation") == request.get("generation")
                        });
                        if matches {
                            generation += 1;
                            stop(&mut worker);
                        }
                        emit(
                            &json!({"type":"s2_cancelled","requestId":raw.get("requestId"),"generation":raw.get("generation"),"joined":matches}),
                        )?;
                    }
                    Some("s2_decide") => {
                        if integrated {
                            let identity = raw
                                .get("requestId")
                                .and_then(Value::as_str)
                                .filter(|s| crate::s2_transport::id(s));
                            let request_generation = raw
                                .get("generation")
                                .and_then(crate::s2_transport::safe_generation);
                            let invalid = identity.is_none()
                                || request_generation.is_none()
                                || seen.len() >= crate::s2_transport::MAX_SESSION_REQUESTS
                                || identity.map_or(false, |id| seen.contains(id))
                                || request_generation.map_or(false, |g| {
                                    last_generation.map_or(false, |last| g <= last)
                                });
                            if invalid {
                                emit(
                                    &json!({"type":"protocol_error","reason":"invalid-duplicate-or-exhausted-identity"}),
                                )?;
                                break;
                            }
                            seen.insert(identity.unwrap().to_owned());
                            last_generation = request_generation;
                        }
                        if !ready || worker.is_some() {
                            emit(&profile.error(&raw, "error", "session-not-ready-or-busy"))?;
                            continue;
                        }
                        generation += 1;
                        let token = generation;
                        let send = tx.clone();
                        let p = profile.clone();
                        let request = raw.clone();
                        let cancel = Arc::new(AtomicBool::new(false));
                        let flag = cancel.clone();
                        let thread = std::thread::spawn(move || {
                            let response =
                                std::panic::catch_unwind(|| p.decide(request.clone(), flag))
                                    .unwrap_or_else(|_| p.error(&request, "error", "internal"));
                            let _ = send.send(Event::Done(token, response));
                        });
                        worker = Some((cancel, thread, raw));
                    }
                    Some("invalid_json") => {
                        if integrated {
                            emit(&json!({"type":"protocol_error","reason":"invalid-json"}))?;
                            break;
                        }
                        emit(&profile.error(&raw, "error", "invalid-json"))?;
                    }
                    Some(_) => {
                        if integrated {
                            emit(&json!({"type":"protocol_error","reason":"unsupported-message"}))?;
                            break;
                        }
                        emit(&profile.error(&raw, "unsupported", "unsupported-message"))?;
                    }
                    None => {
                        if integrated {
                            emit(&json!({"type":"protocol_error","reason":"invalid-input"}))?;
                            break;
                        }
                        emit(&profile.error(&raw, "error", "invalid-input"))?;
                    }
                },
            }
        }
        Ok(())
    })();
    stop(&mut worker);
    result
}

pub(crate) fn f14_decide_job(
    request: serde_json::Value,
    profile: &crate::f14_compat::transport::Profile,
    config: std::sync::Arc<crate::bot::BotConfig>,
    bot: &BotSyncronizer,
    flag: &Arc<AtomicBool>,
    token: u64,
    gate: &Mutex<crate::f14_compat::transport::F14StartGate>,
    hook: Option<&crate::f14_compat::transport::F14CancelHook>,
) -> serde_json::Value {
    f14_decide_job_with_observation(request, profile, config, bot, flag, token, gate, hook, None)
}

pub(crate) fn f14_decide_job_with_observation(
    request: serde_json::Value,
    profile: &crate::f14_compat::transport::Profile,
    config: std::sync::Arc<crate::bot::BotConfig>,
    bot: &BotSyncronizer,
    flag: &Arc<AtomicBool>,
    token: u64,
    gate: &Mutex<crate::f14_compat::transport::F14StartGate>,
    hook: Option<&crate::f14_compat::transport::F14CancelHook>,
    observation: Option<crate::f14_compat::select::RootObservation>,
) -> serde_json::Value {
    use crate::f14_compat::transport as f14;
    if let Err(response) = f14::admit(&request, profile) {
        return response;
    }
    if flag.load(Ordering::Acquire) {
        return f14::error(&request, "incomplete", "cancelled");
    }
    f14::F14CancelHook::park(hook.and_then(|value| value.after_flag_check.as_ref()));
    if flag.load(Ordering::Acquire) {
        return f14::error(&request, "incomplete", "cancelled");
    }
    let mut prepared = match inproc::prepare_after_admit_with_cancel(
        request.clone(),
        profile,
        config,
        token,
        observation,
        Arc::clone(flag),
    ) {
        Ok(prepared) => prepared,
        Err(response) => return response,
    };
    f14::F14CancelHook::park(hook.and_then(|value| value.before_start.as_ref()));
    {
        let gate = gate.lock();
        if !gate.allow_start(token, flag) {
            return f14::error(&request, "incomplete", "cancelled");
        }
        bot.start(prepared.take_bot());
        #[cfg(test)]
        F14_BOT_STARTS.with(|count| count.set(count.get() + 1));
    }
    let deadline = prepared.limits.deadline;
    let (moves, info, ended) = bot.suggest_until_inner(deadline, flag, hook);
    let finish_end = match ended {
        SuggestEnd::Budget => FinishEnd::Budget,
        SuggestEnd::Deadline => FinishEnd::Deadline,
        SuggestEnd::Cancelled => FinishEnd::Cancelled,
        SuggestEnd::Stopped => FinishEnd::Stopped,
        SuggestEnd::Failed(reason) => FinishEnd::Failed(reason),
    };
    bot.stop();
    inproc::finish_with_hook(prepared, &moves, info, finish_end, hook)
}
pub(crate) fn run_f14(
    profile: crate::f14_compat::transport::Profile,
    config: std::sync::Arc<crate::bot::BotConfig>,
    bot: std::sync::Arc<BotSyncronizer>,
) -> std::io::Result<()> {
    use crate::f14_compat::transport as f14;
    use serde_json::{json, Value};
    use std::io::Write;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    enum Event {
        Input(Option<Value>),
        Done(u64, Value),
    }
    let (tx, rx) = mpsc::channel();
    let input_tx = tx.clone();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        loop {
            let value = crate::tbp::read_json_line(&mut input);
            let eof = value.is_none();
            if input_tx.send(Event::Input(value)).is_err() || eof {
                break;
            }
        }
    });
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let mut emit = |value: &Value| -> std::io::Result<()> {
        serde_json::to_writer(&mut output, value)?;
        output.write_all(b"\n")?;
        output.flush()
    };
    let f14_profiles = if profile.profile_id == f14::ROOT_OBJECTIVE_PROFILE {
        vec![
            f14::A_PROFILE,
            f14::PUBLIC_PROFILE,
            f14::ROOT_OBJECTIVE_PROFILE,
        ]
    } else if profile.profile_id == f14::ROOT_VALUE_PROFILE {
        vec![
            f14::A_PROFILE,
            f14::PUBLIC_PROFILE,
            f14::CORE_ALLSPIN_PROFILE,
            f14::ROOT_VALUE_PROFILE,
        ]
    } else if profile.profile_id == f14::CORE_ALLSPIN_PROFILE {
        vec![
            f14::A_PROFILE,
            f14::PUBLIC_PROFILE,
            f14::CORE_ALLSPIN_PROFILE,
        ]
    } else if profile.profile_id == f14::RANK_ORDER_PROFILE {
        vec![f14::A_PROFILE, f14::PUBLIC_PROFILE, f14::RANK_ORDER_PROFILE]
    } else if profile.is_composed() {
        vec![
            f14::A_PROFILE,
            f14::PUBLIC_PROFILE,
            f14::COMPOSED_A,
            f14::COMPOSED_B,
        ]
    } else {
        vec![f14::A_PROFILE, f14::PUBLIC_PROFILE]
    };
    emit(&json!({
        "type":"info",
        "name":"Cold Clear 2 S2",
        "version": concat!(env!("CARGO_PKG_VERSION"), " ", env!("GIT_HASH")),
        "author":"MinusKelvin + s2-analysis-engine contributors",
        "features":[profile.advertised_feature()],
        "f14Profiles": f14_profiles,
        "f14Config": profile.config_bytes()
    }))?;
    let mut ready = false;
    let mut generation = 0_u64;
    let mut worker: Option<(Arc<AtomicBool>, std::thread::JoinHandle<()>, Value)> = None;
    let gate = Arc::new(Mutex::new(f14::F14StartGate::new()));
    let stop = |worker: &mut Option<(Arc<AtomicBool>, std::thread::JoinHandle<()>, Value)>| {
        if let Some((flag, thread, _)) = worker.take() {
            flag.store(true, Ordering::Release);
            let _ = thread.join();
        }
    };
    let result = (|| -> std::io::Result<()> {
        while let Ok(event) = rx.recv() {
            match event {
                Event::Input(None) => break,
                Event::Done(token, response) => {
                    if token == generation {
                        if let Some((_, thread, _)) = worker.take() {
                            let _ = thread.join();
                        }
                        emit(&response)?;
                    }
                }
                Event::Input(Some(raw)) => match raw.get("type").and_then(Value::as_str) {
                    Some("rules") => {
                        ready = true;
                        emit(&json!({"type":"ready"}))?;
                    }
                    Some("quit") => break,
                    Some("f14_cancel") => {
                        let matches = worker.as_ref().map_or(false, |(_, _, request)| {
                            raw.get("requestId") == request.get("requestId")
                                && raw.get("generation") == request.get("generation")
                        });
                        if matches {
                            generation += 1;
                            {
                                let mut gate = gate.lock();
                                gate.invalidate();
                            }
                            if let Some((flag, _, _)) = worker.as_ref() {
                                flag.store(true, Ordering::Release);
                            }
                            bot.stop();
                            stop(&mut worker);
                        }
                        emit(&json!({
                            "type":"f14_cancelled",
                            "requestId": raw.get("requestId"),
                            "generation": raw.get("generation"),
                            "joined": matches
                        }))?;
                    }
                    Some("f14_decide") => {
                        if !ready || worker.is_some() {
                            emit(&f14::error(&raw, "error", "session-not-ready-or-busy"))?;
                            continue;
                        }
                        generation += 1;
                        let token = generation;
                        {
                            let mut gate = gate.lock();
                            gate.begin(token);
                        }
                        let send = tx.clone();
                        let p = profile.clone();
                        let request = raw.clone();
                        let cancel = Arc::new(AtomicBool::new(false));
                        let flag = cancel.clone();
                        let bot = bot.clone();
                        let config = config.clone();
                        let gate = gate.clone();
                        let thread = std::thread::spawn(move || {
                            let response =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    f14_decide_job(
                                        request.clone(),
                                        &p,
                                        config,
                                        &bot,
                                        &flag,
                                        token,
                                        &gate,
                                        None,
                                    )
                                }))
                                .unwrap_or_else(|_| f14::error(&request, "error", "internal"));
                            let _ = send.send(Event::Done(token, response));
                        });
                        worker = Some((cancel, thread, raw));
                    }
                    Some("invalid_json") => emit(&f14::error(&raw, "error", "invalid-json"))?,
                    Some(_) => emit(&f14::error(&raw, "unsupported", "unsupported-message"))?,
                    None => emit(&f14::error(&raw, "error", "invalid-input"))?,
                },
            }
        }
        Ok(())
    })();
    bot.stop();
    stop(&mut worker);
    result
}

#[cfg(test)]
mod f14_error_priority_tests {
    use super::*;
    use crate::bot::BotConfig;
    use crate::f14_compat::transport::{F14StartGate, Profile};
    use parking_lot::Mutex;
    use serde_json::json;

    fn amount_profile() -> Profile {
        serde_json::from_value(json!({
            "profileId": "f14-amount-only-compat-a/1",
            "configHash": "sha256:12665e92fa86934d82b5fd909b1248954e267d4e5c8fcafb0c23024938d1a769",
            "seed": "1395802947",
            "workerConcurrency": 1,
            "budget": { "mode": "selection", "selections": 8, "maxMillis": 30000 }
        }))
        .unwrap()
    }

    fn composed_profile() -> Profile {
        serde_json::from_value(json!({
            "profileId": "f14-composed-ranking-b/1",
            "configHash": "sha256:12665e92fa86934d82b5fd909b1248954e267d4e5c8fcafb0c23024938d1a769",
            "seed": "5994928009864282113",
            "workerConcurrency": 1,
            "budget": { "mode": "selection", "selections": 8, "maxMillis": 30000 }
        }))
        .unwrap()
    }

    fn opening_parts() -> (serde_json::Value, serde_json::Value) {
        let cells = "_".repeat(400);
        let start = json!({
            "board": vec![vec![serde_json::Value::Null; 10]; 40],
            "queue": ["T","Z","I","O","J","L","S"],
            "hold": null,
            "combo": 0,
            "back_to_back": false,
            "b2b": 0,
            "randomizer": { "type": "seven_bag", "bag_state": [] }
        });
        let selector = json!({
            "rulesetId": "tetrio-s2-v19-2c47b3df945f6714449b92d1b44346ef4bf0e1a20e95be8ed10c28be75c66a60-beta-1-5-0",
            "board": {
                "fidelity": "exact",
                "width": 10,
                "height": 40,
                "visibleHeight": 20,
                "bufferHeight": 20,
                "cells": cells
            },
            "pieces": {
                "current": "T",
                "hold": null,
                "holdAvailable": true,
                "known": ["Z","I","O","J","L","S"]
            },
            "chain": { "combo": 0, "b2b": 0 },
            "time": { "logicalFrame": 0, "piecesPlaced": 0, "fidelity": "exact", "frameSemantics": "engine-frame" },
            "incoming": { "pendingRows": 0, "dueThisLockRows": 0 }
        });
        (start, selector)
    }

    fn decide_job(profile: &Profile, request: serde_json::Value) -> serde_json::Value {
        let bot = BotSyncronizer::new();
        let config = Arc::new(BotConfig::default());
        let flag = Arc::new(AtomicBool::new(false));
        let gate = Mutex::new(F14StartGate::new());
        gate.lock().begin(1);
        f14_decide_job(request, profile, config, &bot, &flag, 1, &gate, None)
    }

    #[test]
    fn admit_failure_does_not_start_bot() {
        F14_BOT_STARTS.with(|count| count.set(0));
        let profile = amount_profile();
        let response = decide_job(
            &profile,
            json!({
                "type": "f14_decide",
                "schemaVersion": 1,
                "requestId": "admit-fail",
                "positionId": "admit-fail",
                "generation": 1,
                "execution": profile,
            }),
        );
        assert_eq!(response["status"], "error");
        assert_eq!(response["reason"], "invalid-input");
        assert_eq!(F14_BOT_STARTS.with(|count| count.get()), 0);
    }

    #[test]
    fn start_selector_mismatch_does_not_start_bot() {
        F14_BOT_STARTS.with(|count| count.set(0));
        let profile = amount_profile();
        let (mut start, selector) = opening_parts();
        start["b2b"] = json!(3);
        let response = decide_job(
            &profile,
            json!({
                "type": "f14_decide",
                "schemaVersion": 1,
                "requestId": "mismatch",
                "positionId": "mismatch",
                "generation": 1,
                "execution": profile,
                "start": start,
                "selector": selector,
            }),
        );
        assert_eq!(response["reason"], "start-selector-mismatch");
        assert_eq!(F14_BOT_STARTS.with(|count| count.get()), 0);
    }

    #[test]
    fn composed_context_prep_failure_is_search_pre_start() {
        F14_BOT_STARTS.with(|count| count.set(0));
        let profile = composed_profile();
        let (start, mut selector) = opening_parts();
        selector["time"]["fidelity"] = json!("approx");
        let response = decide_job(
            &profile,
            json!({
                "type": "f14_decide",
                "schemaVersion": 1,
                "requestId": "context-prep",
                "positionId": "context-prep",
                "generation": 1,
                "execution": profile,
                "start": start,
                "selector": selector,
            }),
        );
        assert_eq!(response["status"], "error");
        assert_eq!(response["reason"], "invalid-input");
        assert_eq!(F14_BOT_STARTS.with(|count| count.get()), 0);
    }
}
