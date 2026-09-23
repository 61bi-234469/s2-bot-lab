use std::collections::VecDeque;
use std::sync::Arc;

use enum_dispatch::enum_dispatch;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::data::{AdvanceError, GameState, Piece, Placement};
use crate::f14_compat::{CompatError, select::RootObjectiveSession};

mod freestyle;
mod evaluation_features;
pub(crate) use evaluation_features::{
    cell_coveredness, row_transitions, tetris_well_depth, well_known_tslot_left,
    well_known_tslot_right,
};

use self::freestyle::Freestyle;

pub struct Bot {
    options: BotOptions,
    current: GameState,
    queue: VecDeque<Piece>,
    mode: ModeEnum,
    root_session: Option<Arc<RootObjectiveSession>>,
}

/// Entry for the existing root diagnostic executable. Each call
/// owns a new legacy DAG; no persistent session, Play, or production profile.
pub fn diagnose_s2_root_priority(raw: serde_json::Value) -> Result<serde_json::Value, String> {
    use crate::f14_compat::{select::{public_state_from_json, PublicRootLockContext, F14RuntimeLimits}, transport::CONFIG};
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, Ordering};
    use crate::time::Instant;
    use std::time::Duration;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        schema: String, selector: Value, priority_enabled: bool,
        selections: u64, max_millis: u64, seed: String,
        #[serde(default)]
        report_prefix_distinct: bool,
    }
    let request: Request = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    if request.schema != "s2-root-priority-diagnostic/1"
        || !(1..=4096).contains(&request.selections) || !(1..=30_000).contains(&request.max_millis)
        || request.seed.is_empty() || !request.seed.bytes().all(|b| b.is_ascii_digit())
    { return Err("unsupported diagnostic profile".into()); }
    let seed: u64 = request.seed.parse().map_err(|_| "invalid seed")?;
    let public = public_state_from_json(&request.selector).map_err(|e| format!("{e:?}"))?;
    if public.board_cells.len() != 400 || public.width != 10 || public.height != 40
        || public.visible_height != 20 || !public.pieces.hold_available
        || public.pieces.current.is_none() || public.pieces.known.len() > 13
        || (public.pieces.hold.is_none() && public.pieces.known.is_empty())
        || public.incoming.due_this_lock_rows > public.incoming.pending_rows
        || public.incoming.pending_rows > 255 || public.combo > 255
        || public.time.logical_frame > 1_000_000
        || !public.board_cells.bytes().all(|b| b"_GIOTSZJL".contains(&b))
    { return Err("unsupported diagnostic public state".into()); }
    let limits = F14RuntimeLimits { deadline: Instant::now() + Duration::from_millis(request.max_millis),
        cancel: Arc::new(AtomicBool::new(false)) };
    // One public source owns both views. No supplied private bag/RNG/packet data.
    let board: Vec<Vec<Value>> = public.board_cells.as_bytes().chunks_exact(10)
        .map(|row| row.iter().map(|&b| if b == b'_' { Value::Null } else { json!((b as char).to_string()) }).collect()).collect();
    let queue: Vec<_> = public.pieces.current.iter().chain(&public.pieces.known).collect();
    let start = json!({ "board": board, "queue": queue, "hold": public.pieces.hold,
        "combo": public.combo, "b2b": public.b2b, "back_to_back": public.b2b > 0,
        "randomizer": {"type": "seven_bag", "bag_state": []} });
    crate::f14_compat::transport::assert_start_selector_projection(&start, &request.selector)
        .map_err(|e| format!("{e:?}"))?;
    let mut config: BotConfig = serde_json::from_str(CONFIG).map_err(|e| e.to_string())?;
    config.search_seed = seed;
    config.search_selection_limit = request.selections;
    config.enable_s2_amount_only_incoming = false; // exactly the preserved F14 substrate
    let bot = crate::create_bot(serde_json::from_value(start).map_err(|e| e.to_string())?, Arc::new(config))
        .map_err(|e| e.to_string())?;
    let context = PublicRootLockContext::new(&public, &limits).map_err(|e| format!("{e:?}"))?;
    let ModeEnum::Freestyle(search) = &bot.mode;
    let mut nodes = 0;
    let mut expansions = 0;
    let mut initial = vec![];
    let mut prefix_seen = std::collections::HashSet::<String>::new();
    for i in 0..request.selections {
        if limits.cancel.load(Ordering::Acquire) || Instant::now() >= limits.deadline { return Err("diagnostic deadline".into()); }
        let stats = search.do_work_with_root_priority(&bot.options, request.priority_enabled.then_some(&context))
            .map_err(|e| format!("{e:?}"))?;
        nodes += stats.nodes;
        expansions += stats.expansions;
        if i == 0 { initial = search.root_priorities(); }
        if request.report_prefix_distinct {
            for (mv, _) in search.suggest(&bot.options) {
                prefix_seen.insert(serde_json::to_string(&mv).map_err(|e| e.to_string())?);
            }
        }
    }
    if Instant::now() >= limits.deadline { return Err("diagnostic deadline".into()); }
    let roots = search.root_priorities();
    let mut response = json!({ "diagnostic": request.schema, "games": 0, "releaseEvidence": false,
        "priorityEnabled": request.priority_enabled, "selections": request.selections,
        "seed": request.seed, "nodes": nodes, "expansions": expansions,
        "initial": initial, "roots": roots, "selected": bot.suggest().first() });
    if request.report_prefix_distinct {
        response["prefixDistinctCount"] = json!(prefix_seen.len());
    }
    Ok(response)
}

/// Offline conversion shadow. Teacher identities only; no search or ranking.
pub fn diagnose_s2_conversion_shadow(raw: serde_json::Value) -> Result<serde_json::Value, String> {
    use crate::f14_compat::select::{public_state_from_json, shadow_conversion_facts, F14RuntimeLimits};
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicBool;
    use crate::time::Instant;
    use std::time::Duration;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        schema: String,
        selector: Value,
        identities: Vec<Value>,
        #[serde(default)]
        public_profile: Option<bool>,
        max_millis: u64,
    }
    let request: Request = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    let public_profile = request.public_profile.unwrap_or(true);
    if request.schema != "s2-conversion-core-shadow/1"
        || !(1..=30_000).contains(&request.max_millis)
        || request.identities.is_empty()
        || request.identities.len() > 64
    { return Err("unsupported diagnostic profile".into()); }
    let public = public_state_from_json(&request.selector).map_err(|e| format!("{e:?}"))?;
    if public.board_cells.len() != 400 || public.width != 10 || public.height != 40
        || public.visible_height != 20 || !public.pieces.hold_available
        || public.pieces.current.is_none()
        || (public.pieces.hold.is_none() && public.pieces.known.is_empty())
        || public.incoming.due_this_lock_rows > public.incoming.pending_rows
        || public.incoming.pending_rows > 255 || public.combo > 255
        || public.time.logical_frame > 1_000_000
        || !public.board_cells.bytes().all(|b| b"_GIOTSZJL".contains(&b))
    { return Err("unsupported diagnostic public state".into()); }
    let limits = F14RuntimeLimits { deadline: Instant::now() + Duration::from_millis(request.max_millis),
        cancel: Arc::new(AtomicBool::new(false)) };
    let (facts, audit) = crate::s2_audit::run(|| {
        shadow_conversion_facts(&public, &request.identities, Some(&limits), public_profile)
    });
    let facts = facts.map_err(|e| format!("{e:?}"))?;
    Ok(json!({
        "diagnostic": request.schema,
        "games": 0,
        "releaseEvidence": false,
        "publicProfile": public_profile,
        "candidates": facts,
        "boundaryAudit": audit,
    }))
}

#[cfg(not(target_arch = "wasm32"))]
/// Native-shadow root-objective diagnostic.  It derives the fixed root
/// objective execution profile from the saved request, then enters the same
/// f14_decide_job lifecycle as production. Feedback is admitted only after the
/// JS checker validates the independent-review and baseline bindings.
pub fn diagnose_s2_root_allocation(raw: serde_json::Value) -> Result<serde_json::Value, String> {
    use crate::f14_compat::select::{RootAllocationTraceSink, RootObservation};
    use crate::f14_compat::transport::{Budget, F14StartGate, Profile, CONFIG, CONFIG_HASH, ROOT_OBJECTIVE_PROFILE};
    use crate::sync::{f14_decide_job_with_observation, BotSyncronizer};
    use parking_lot::Mutex;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::sync::atomic::AtomicBool;

    let schema = raw.get("schema").and_then(Value::as_str).unwrap_or("");
    if schema != "s2-f14-root-allocation-diagnostic/1" {
        return Err("unsupported diagnostic schema".into());
    }
    let mode = raw.get("mode").and_then(Value::as_str).unwrap_or("");
    if mode != "native-shadow" && mode != "feedback" {
        return Err("unsupported root allocation diagnostic mode".into());
    }
    let mut request = raw
        .get("request")
        .cloned()
        .ok_or_else(|| "diagnostic request is required".to_owned())?;
    if !request.is_object() {
        return Err("diagnostic request must be an object".into());
    }
    let original_bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    let digest_hex = |digest: [u8; 32]| -> String {
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    };
    let original_hash = format!("sha256:{}", digest_hex(Sha256::digest(&original_bytes).into()));
    let max_millis = raw.get("maxMillis").and_then(Value::as_u64).unwrap_or(30_000);
    if !(1..=300_000).contains(&max_millis) {
        return Err("invalid diagnostic maxMillis".into());
    }
    let mut profile = Profile {
        profile_id: ROOT_OBJECTIVE_PROFILE.to_owned(),
        config_hash: CONFIG_HASH.to_owned(),
        seed: "5994928009864282113".to_owned(),
        worker_concurrency: 1,
        budget: Budget { mode: "selection".to_owned(), selections: 512, max_millis },
        post_spin_policy_id: None,
        allocation_mode: Some(if mode == "feedback" {
            "conversion-permutation-v1"
        } else {
            "off"
        }.to_owned()),
        final_order_policy_id: None,
    };
    if !profile.valid() {
        return Err("invalid fixed root profile".into());
    }
    request["execution"] = serde_json::to_value(&profile).map_err(|e| e.to_string())?;
    let public_context_digest = crate::f14_compat::transport::public_context_digest_for_request(&request, &profile)
        .map(digest_hex)
        .map_err(|error| format!("invalid public context: {error:?}"))?;
    let derived_bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    let derived_hash = format!("sha256:{}", digest_hex(Sha256::digest(&derived_bytes).into()));
    let mut config: BotConfig = serde_json::from_str(CONFIG).map_err(|e| e.to_string())?;
    config.search_seed = profile.seed_u64().ok_or_else(|| "invalid root seed".to_owned())?;
    config.search_selection_limit = profile.budget.selections;
    config.enable_s2_amount_only_incoming = false;
    let config = Arc::new(config);
    let synchronizer = Arc::new(BotSyncronizer::new());
    let worker = Arc::clone(&synchronizer);
    std::thread::spawn(move || worker.work_loop());
    let sink = RootAllocationTraceSink::new();
    let observation = RootObservation::native_shadow(Arc::clone(&sink));
    let flag = Arc::new(AtomicBool::new(false));
    let gate = Arc::new(Mutex::new(F14StartGate::new()));
    gate.lock().begin(1);
    let response = f14_decide_job_with_observation(
        request,
        &profile,
        Arc::clone(&config),
        &synchronizer,
        &flag,
        1,
        &gate,
        None,
        Some(observation),
    );
    synchronizer.stop();
    let rows = sink.rows();
    Ok(json!({
        "diagnostic": schema,
        "mode": mode,
        "games": 0,
        "releaseEvidence": false,
        "holdoutPairsRead": 0,
        "originalRequestSha256": original_hash,
        "derivedRequestSha256": derived_hash,
        "publicContextDigest": format!("sha256:{public_context_digest}"),
        "response": response,
        "trace": rows,
        "traceRows": rows.len(),
    }))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BotConfig {
    pub freestyle_weights: freestyle::Weights,
    pub freestyle_exploitation: f64,
    /// Number of root candidates exposed to the S2 canonical reranker.
    pub suggestion_count: usize,
    /// Exact number of tree selections before a deterministic suggestion.
    pub search_selection_limit: u64,
    /// Seed for the single search worker's exploration choices.
    pub search_seed: u64,
    /// Adds source-qualified direct-180 edges to the native proposal frontier.
    ///
    /// This remains disabled for every existing configuration unless a candidate
    /// configuration explicitly enables it.
    #[serde(default)]
    pub enable_direct_180: bool,
    /// Recover an empty root frontier through the hidden spawn buffer.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_spawn_buffer_entry: bool,
    /// Penalize post-lock boards that obstruct remaining bag/HOLD spawn sources.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_spawn_occupancy_eval: bool,
    /// Accept amount-only incoming scalars on Start and run the in-search
    /// amount model. Omitted/false preserves today's Start interpretation.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_s2_amount_only_incoming: bool,
    /// Score structural costs on the real board while retaining T-slot preview bonuses.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_real_board_structural_eval: bool,
    /// Score a non-mutating T-slot preview once, including zero-line penalties.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_tslot_nonmutating_dedup: bool,
    /// Charge the real-board projected-height cost once on each amount-only tank edge.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_s2_tank_risk_shaping: bool,
    /// Keep amount top-out edges and charge their discrete threshold cost.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_s2_amount_top_out_cost: bool,
    /// Keep amount top-out edges without enabling an amount top-out reward.
    ///
    /// This is intentionally separate from the historical cost flag. S3 uses
    /// this field for state-only edge retention.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_s2_amount_top_out_edge_retention: bool,
    /// Apply the `s2_amount_top_out` reward to retained amount top-out edges.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_s2_amount_top_out_reward: bool,
    /// Add canonical B2B Surge rows as an opt-in search reward.
    #[serde(default, skip_serializing_if = "is_false")]
    pub enable_s2_b2b_surge: bool,
}

fn is_false(value: &bool) -> bool { !*value }

impl BotConfig {
    /// Reject combinations that would enable a reward without retaining the
    /// edge to which that reward could apply.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.enable_s2_amount_top_out_reward && !self.enable_s2_amount_top_out_edge_retention {
            return Err("amount-top-out-reward-requires-edge-retention");
        }
        Ok(())
    }

    /// Resolve the edge-retention decision while preserving historical A0
    /// config behavior when the new split flags are both omitted.
    pub fn amount_top_out_edge_retention(&self) -> bool {
        if self.enable_s2_amount_top_out_edge_retention || self.enable_s2_amount_top_out_reward {
            self.enable_s2_amount_top_out_edge_retention
        } else {
            self.enable_s2_amount_top_out_cost
        }
    }

    /// Resolve the reward decision independently for the S3 split path.
    pub fn amount_top_out_reward(&self) -> bool {
        if self.enable_s2_amount_top_out_edge_retention || self.enable_s2_amount_top_out_reward {
            self.enable_s2_amount_top_out_reward
        } else {
            self.enable_s2_amount_top_out_cost
        }
    }
}

impl Default for BotConfig {
    fn default() -> Self {
        static DEFAULT: Lazy<BotConfig> =
            Lazy::new(|| serde_json::from_str(include_str!("default.json")).unwrap());
        DEFAULT.clone()
    }
}

#[derive(Debug)]
pub struct BotOptions {
    pub speculate: bool,
    pub config: Arc<BotConfig>,
}

#[enum_dispatch]
enum ModeEnum {
    Freestyle,
}

#[enum_dispatch(ModeEnum)]
trait Mode {
    fn advance(&mut self, options: &BotOptions, mv: Placement) -> Option<ModeSwitch>;
    fn new_piece(&mut self, options: &BotOptions, piece: Piece);
    fn suggest(&self, options: &BotOptions) -> Vec<(Placement, f32)>;
    fn do_work(
        &self,
        options: &BotOptions,
        session: Option<&RootObjectiveSession>,
    ) -> Result<Statistics, CompatError>;
}

enum ModeSwitch {
    Freestyle,
}

impl Bot {
    pub fn new(options: BotOptions, root: GameState, queue: &[Piece]) -> Self {
        Bot {
            current: root,
            queue: queue.iter().copied().collect(),
            mode: Freestyle::new(&options, root, queue).into(),
            options,
            root_session: None,
        }
    }

    pub fn try_advance(&mut self, mv: Placement) -> Result<(), AdvanceError> {
        puffin::profile_function!();
        let next = *self.queue.front().expect("Bot advance requires a queued piece");
        let mut current = self.current;
        current.try_advance_with_surge(next, mv, self.options.config.enable_s2_b2b_surge)?;
        self.current = current;
        if let Some(to) = self.mode.advance(&self.options, mv) {
            self.switch(to);
        };
        self.queue.pop_front();
        Ok(())
    }

    pub fn advance(&mut self, mv: Placement) {
        self.try_advance(mv).expect("Bot advance failed");
    }

    pub fn new_piece(&mut self, piece: Piece) {
        puffin::profile_function!();
        self.queue.push_back(piece);
        self.mode.new_piece(&self.options, piece);
    }

    pub fn suggest(&self) -> Vec<(Placement, f32)> {
        puffin::profile_function!();
        self.mode.suggest(&self.options)
    }

    pub fn do_work(&self) -> Result<Statistics, CompatError> {
        puffin::profile_function!();
        let result = self.mode.do_work(&self.options, self.root_session.as_deref());
        if let Err(error) = result {
            if let Some(session) = self.root_session.as_ref() {
                session.publish_root_failure(error);
            }
        }
        result
    }

    pub(crate) fn attach_root_session(
        &mut self,
        session: Arc<RootObjectiveSession>,
        worker_concurrency: u32,
    ) -> Result<(), CompatError> {
        if worker_concurrency != 1 {
            return Err(CompatError::InvalidSelector);
        }
        self.root_session = Some(session);
        Ok(())
    }

    pub(crate) fn current_b2b(&self) -> u32 {
        self.current.b2b
    }

    pub fn search_selection_limit(&self) -> u64 {
        self.options.config.search_selection_limit
    }

    pub fn amount_only_extra_json(&self, omitted: u64, no_move: bool) -> Option<String> {
        if !self.options.config.enable_s2_amount_only_incoming {
            return None;
        }
        Some(
            serde_json::json!({
                "pending_incoming_rows": self.current.pending_incoming_rows,
                "due_this_lock_rows": self.current.due_this_lock_rows,
                "amount_top_out_omitted": omitted,
                "amount_top_out_no_move": no_move,
            })
            .to_string(),
        )
    }

    fn switch(&mut self, to: ModeSwitch) {
        puffin::profile_function!();
        match to {
            ModeSwitch::Freestyle => {
                self.mode =
                    Freestyle::new(&self.options, self.current, self.queue.make_contiguous()).into()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::BotConfig;

    #[test]
    fn s2_candidate_default_exposes_a_bounded_root_set() {
        let config = BotConfig::default();
        assert_eq!(config.suggestion_count, 16);
        assert_eq!(config.search_selection_limit, u64::MAX);
        assert_eq!(config.search_seed, 0x5332_4343_3200_0001);
        assert!(!config.enable_direct_180);
    }

    #[test]
    fn direct_180_config_flag_is_backward_compatible_and_opt_in() {
        let mut value = serde_json::to_value(BotConfig::default()).unwrap();
        value.as_object_mut().unwrap().remove("enable_direct_180");
        let omitted: BotConfig = serde_json::from_value(value.clone()).unwrap();
        assert!(!omitted.enable_direct_180);

        value.as_object_mut().unwrap().insert(
            "enable_direct_180".to_owned(),
            serde_json::Value::Bool(true),
        );
        let enabled: BotConfig = serde_json::from_value(value).unwrap();
        assert!(enabled.enable_direct_180);
    }

    #[test]
    fn spawn_buffer_entry_is_opt_in_and_false_preserves_serialized_shape() {
        let original = serde_json::to_value(BotConfig::default()).unwrap();
        assert!(original.get("enable_spawn_buffer_entry").is_none());
        let omitted: BotConfig = serde_json::from_value(original.clone()).unwrap();
        assert!(!omitted.enable_spawn_buffer_entry);
        for enabled in [false, true] {
            let mut value = original.clone();
            value["enable_spawn_buffer_entry"] = enabled.into();
            let config: BotConfig = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(config.enable_spawn_buffer_entry, enabled);
            assert_eq!(serde_json::to_value(config).unwrap(), if enabled { value } else { original.clone() });
        }
    }

    #[test]
    fn spawn_occupancy_eval_is_opt_in_and_false_preserves_serialized_shape() {
        let original = serde_json::to_value(BotConfig::default()).unwrap();
        assert!(original.get("enable_spawn_occupancy_eval").is_none());
        let omitted: BotConfig = serde_json::from_value(original.clone()).unwrap();
        assert!(!omitted.enable_spawn_occupancy_eval);
        for enabled in [false, true] {
            let mut value = original.clone();
            value["enable_spawn_occupancy_eval"] = enabled.into();
            let config: BotConfig = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(config.enable_spawn_occupancy_eval, enabled);
            assert_eq!(
                serde_json::to_value(config).unwrap(),
                if enabled { value } else { original.clone() }
            );
        }
    }

    #[test]
    fn amount_only_incoming_is_opt_in_and_false_preserves_serialized_shape() {
        let original = serde_json::to_value(BotConfig::default()).unwrap();
        assert!(original.get("enable_s2_amount_only_incoming").is_none());
        let omitted: BotConfig = serde_json::from_value(original.clone()).unwrap();
        assert!(!omitted.enable_s2_amount_only_incoming);
        for enabled in [false, true] {
            let mut value = original.clone();
            value["enable_s2_amount_only_incoming"] = enabled.into();
            let config: BotConfig = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(config.enable_s2_amount_only_incoming, enabled);
            assert_eq!(
                serde_json::to_value(config).unwrap(),
                if enabled { value } else { original.clone() }
            );
        }
    }


    #[test]
    fn b2b_surge_is_opt_in_and_default_shape_is_unchanged() {
        let original = serde_json::to_value(BotConfig::default()).unwrap();
        assert!(original.get("enable_s2_b2b_surge").is_none());
        assert!(original["freestyle_weights"].get("s2_b2b_surge").is_none());

        let omitted: BotConfig = serde_json::from_value(original.clone()).unwrap();
        assert!(!omitted.enable_s2_b2b_surge);
        assert_eq!(omitted.freestyle_weights.s2_b2b_surge, 0.0);

        let mut enabled = original;
        enabled["enable_s2_b2b_surge"] = true.into();
        enabled["freestyle_weights"]["s2_b2b_surge"] = 1.0.into();
        let config: BotConfig = serde_json::from_value(enabled.clone()).unwrap();
        assert!(config.enable_s2_b2b_surge);
        assert_eq!(config.freestyle_weights.s2_b2b_surge, 1.0);
        assert_eq!(serde_json::to_value(config).unwrap(), enabled);
    }

    #[test]
    fn candidate_fixture_binds_the_opt_in_surge_route() {
        let value: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/tuning/cc2-s2-post-r3-s2-b2b-surge-search-state-candidate.json")).unwrap();
        let config: BotConfig = serde_json::from_value(value).unwrap();
        assert!(config.enable_s2_b2b_surge);
        assert_eq!(config.freestyle_weights.s2_b2b_surge, 1.0);
        assert!(!config.enable_s2_amount_top_out_cost);
    }

    #[test]
    fn s3_state_only_fixture_binds_r3_base_and_split_top_out_flags() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/tuning/cc2-s2-post-r3-s3-incoming-cancel-state-only-r3-base.json"
        ))
        .unwrap();
        let config: BotConfig = serde_json::from_value(value).unwrap();
        assert!(config.enable_s2_amount_only_incoming);
        assert!(config.enable_s2_amount_top_out_edge_retention);
        assert!(!config.enable_s2_amount_top_out_reward);
        assert!(!config.enable_s2_amount_top_out_cost);
        assert!(!config.enable_s2_b2b_surge);
        assert!(config.amount_top_out_edge_retention());
        assert!(!config.amount_top_out_reward());
    }
    #[test]
    fn amount_top_out_cost_is_opt_in_and_zero_weight_preserves_serialized_shape() {
        let original = serde_json::to_value(BotConfig::default()).unwrap();
        assert!(original.get("enable_s2_amount_top_out_cost").is_none());
        assert!(original["freestyle_weights"].get("s2_amount_top_out").is_none());

        let mut enabled = original.clone();
        enabled["enable_s2_amount_top_out_cost"] = true.into();
        enabled["freestyle_weights"]["s2_amount_top_out"] = (-1.0).into();
        let config: BotConfig = serde_json::from_value(enabled.clone()).unwrap();
        assert!(config.enable_s2_amount_top_out_cost);
        assert_eq!(config.freestyle_weights.s2_amount_top_out, -1.0);
        assert_eq!(serde_json::to_value(config).unwrap(), enabled);

        let mut explicit_zero = original.clone();
        explicit_zero["enable_s2_amount_top_out_cost"] = false.into();
        explicit_zero["freestyle_weights"]["s2_amount_top_out"] = 0.0.into();
        let config: BotConfig = serde_json::from_value(explicit_zero).unwrap();
        assert_eq!(serde_json::to_value(config).unwrap(), original);
    }

    #[test]
    fn amount_top_out_edge_retention_and_reward_are_independent() {
        let original = serde_json::to_value(BotConfig::default()).unwrap();
        assert!(!BotConfig::default().amount_top_out_edge_retention());
        assert!(!BotConfig::default().amount_top_out_reward());
        assert!(original.get("enable_s2_amount_top_out_edge_retention").is_none());
        assert!(original.get("enable_s2_amount_top_out_reward").is_none());

        let mut state_only = original;
        state_only["enable_s2_amount_top_out_edge_retention"] = true.into();
        let config: BotConfig = serde_json::from_value(state_only.clone()).unwrap();
        assert!(config.amount_top_out_edge_retention());
        assert!(!config.amount_top_out_reward());
        assert_eq!(serde_json::to_value(config).unwrap(), state_only);
    }

    #[test]
    fn a0_fixture_binds_a_negative_finite_top_out_coefficient() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/tuning/cc2-s2-a0-amount-top-out-cost.json"
        ))
        .unwrap();
        let config: BotConfig = serde_json::from_value(value).unwrap();
        let weight = config.freestyle_weights.s2_amount_top_out;
        assert!(config.enable_s2_amount_top_out_cost);
        assert!(weight.is_finite() && (-1_000_000.0..0.0).contains(&weight));
    }
}

#[derive(Copy, Clone, Debug)]
pub struct Statistics {
    pub nodes: u64,
    pub selections: u64,
    pub expansions: u64,
    pub amount_top_out_omitted: u64,
    pub amount_top_out_retained: u64,
    pub amount_top_out_priced: u64,
}

impl Default for Statistics {
    fn default() -> Self {
        Statistics {
            nodes: 0,
            selections: 0,
            expansions: 0,
            amount_top_out_omitted: 0,
            amount_top_out_retained: 0,
            amount_top_out_priced: 0,
        }
    }
}

impl Statistics {
    pub fn accumulate(&mut self, other: Self) {
        self.nodes += other.nodes;
        self.selections += other.selections;
        self.expansions += other.expansions;
        self.amount_top_out_omitted += other.amount_top_out_omitted;
        self.amount_top_out_retained += other.amount_top_out_retained;
        self.amount_top_out_priced += other.amount_top_out_priced;
    }
}
