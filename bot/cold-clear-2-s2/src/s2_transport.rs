//! Schema 2 admission for the shared CC2/S2 engine. No legacy selector dispatch.
use crate::native_s2::{self, Error};
use crate::s2_core::{AmountTable, Context};
use crate::s2_eval::{Policy, PolicyInput};
use crate::s2_search::{Engine,Limits};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::time::Instant;

pub const ENGINE_ID: &str = "s2-cc2-integrated/1";
pub const CONFIG: &str = include_str!("s2_config.json");
pub const PUBLIC_KEYS: [&str; 7] = ["state", "rules", "lockTime", "randomizer", "rootAmounts", "movement", "visibleHeight"];
const RULE_HASH: &str = "sha256:2c47b3df945f6714449b92d1b44346ef4bf0e1a20e95be8ed10c28be75c66a60";
pub const MAX_SESSION_REQUESTS: usize = 4096;
pub fn bytes_hash(bytes: &[u8]) -> String { format!("sha256:{:x}", Sha256::digest(bytes)) }
// serde_json's default Map uses sorted keys, matching stableNativeJson. These
// envelopes contain integer JSON numbers only; f64 inputs are decimal strings.
pub fn stable_hash(value: &Json) -> String { bytes_hash(value.to_string().as_bytes()) }
pub fn id(s: &str) -> bool { !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_graphic()) }
pub fn safe_generation(value: &Json) -> Option<u64> { value.as_u64().filter(|n| *n <= 9_007_199_254_740_991) }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget { pub mode: String, pub selections: u64, pub max_millis: u64 }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRuntime { pub reserve_millis:u64, pub max_response_bytes:u64, pub max_process_rss_bytes:u64, pub memory_poll_millis:u64 }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub profile_id: String, pub config_hash: String, pub model_hash: String,
    pub policy: PolicyInput, pub seed: String, pub worker_concurrency: u32,
    pub max_depth: u16, pub queue_depth:u8, pub budget: Budget, pub host_runtime:HostRuntime,
    pub resources:Limits,
}
impl Profile {
    pub fn valid(&self) -> bool {
        let mut fields = json!(self);
        fields.as_object_mut().unwrap().remove("profileId");
        self.profile_id == stable_hash(&fields) && self.config_hash == bytes_hash(CONFIG.as_bytes())
            && self.model_hash == stable_hash(&json!(self.policy)) && Policy::new(&self.policy).is_ok()
            && self.worker_concurrency == 1 && (1..=128).contains(&self.max_depth) && self.resources.valid()
            && (1..=14).contains(&self.queue_depth) && self.host_runtime.reserve_millis<self.budget.max_millis
            && (4096..=1048576).contains(&self.host_runtime.max_response_bytes)
            && (1..=1073741824).contains(&self.host_runtime.max_process_rss_bytes)
            && (10..=1000).contains(&self.host_runtime.memory_poll_millis)
            && self.seed.parse::<u64>().map_or(false, |n| n.to_string() == self.seed)
            && matches!(self.budget.mode.as_str(), "selection" | "time")
            && (1..=4096).contains(&self.budget.selections) && (1..=30_000).contains(&self.budget.max_millis)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rules { id: String, normalized_options_hash: String, multiplier_decimal: String, cap_decimal: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Clock { logical_frame: u32, pieces_placed: u32, frame_semantics: String, clock_model: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Randomizer { model: String, knowledge: String, bag: Vec<crate::data::Piece> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Amounts { id: String, entries: Vec<native_s2::RootAmounts>, overflow_signatures: Vec<native_s2::Clear> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Diagnostics { mode: String, max_candidates: usize, features: bool, #[serde(default)] root_work: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    #[serde(rename = "type")] kind: String,
    schema_version: u32, engine_id: String, request_id: String, position_id: String, generation: u64,
    execution: Profile, remaining_millis: u64, state: Json, rules: Rules, lock_time: Clock,
    randomizer: Randomizer, root_amounts: Amounts, movement: String, visible_height: u32,
    diagnostics: Diagnostics,
}
pub fn capability(profile: &Profile) -> Json {
    json!({"engineId": ENGINE_ID, "schemaVersions": [2], "supported": true, "strengthQualified": false,
        "configHash": bytes_hash(CONFIG.as_bytes()), "modelHash": profile.model_hash,
        "profileId": profile.profile_id, "workerConcurrency": 1, "maxKnownNext": 13, "speculate": false})
}
pub fn error(request: &Json, status: &str, reason: &str) -> Json {
    let safe = |key: &str| request.get(key).and_then(Json::as_str).filter(|s| id(s));
    json!({"type":"s2_decision", "schemaVersion":2, "engineId":ENGINE_ID,
        "requestId":safe("requestId"), "positionId":safe("positionId"),
        "generation":request.get("generation").and_then(safe_generation),
        "profileId":request.pointer("/execution/profileId").and_then(Json::as_str).filter(|s|id(s)),
        "status":status,"reason":reason,"selectedMove":null,"search":{},"diagnostics":{},
        "releaseEvidence":false,"strengthQualified":false,"boundaryAudit":crate::s2_audit::Audit::default()})
}
pub fn decide(raw: Json, profile: &Profile, cancel: Arc<AtomicBool>) -> Json {
    let (mut response,audit)=crate::s2_audit::run(||decide_inner(raw.clone(),profile,cancel));
    if audit.external_strategic_reselect_calls+audit.legacy_f14_selection_calls+audit.legacy_f14_rescue_calls!=0 {
        response=error(&raw,"error","strategic-boundary-violation");
    }
    response["boundaryAudit"]=json!(audit);response
}
fn decide_inner(raw: Json, profile: &Profile, cancel: Arc<AtomicBool>) -> Json {
    let started = Instant::now();
    if raw.to_string().len() > 65_536 { return error(&raw, "error", "request-size"); }
    let input: Request = match serde_json::from_value(raw.clone()) {
        Ok(v) => v, Err(_) => return error(&raw, "error", "invalid-input"),
    };
    if input.schema_version != 2 || input.engine_id != ENGINE_ID || input.execution != *profile || !profile.valid()
        || input.rules.normalized_options_hash != RULE_HASH
        || input.rules.id != format!("tetrio-s2-v19-{}-beta-1-5-0", &RULE_HASH[7..])
        || input.randomizer.model != "seven_bag" || input.randomizer.knowledge != "unknown" || !input.randomizer.bag.is_empty()
        || input.movement != "native-s2-final-placement/1" || input.visible_height != 20
        || input.lock_time.frame_semantics != "engine-frame"
        || !matches!(input.lock_time.clock_model.as_str(), "synthetic-placement-lock/1" | "replay-clock/1")
        || input.root_amounts.id != "s2-native-root-amounts/1" {
        return error(&raw, "unsupported", "unsupported-version-model-or-profile");
    }
    if input.kind != "s2_decide" || !id(&input.request_id) || !id(&input.position_id)
        || input.generation > 9_007_199_254_740_991 || input.remaining_millis == 0 || input.remaining_millis > profile.budget.max_millis
        || !matches!(input.diagnostics.mode.as_str(), "summary" | "sampled" | "full-bounded")
        || !(1..=32).contains(&input.diagnostics.max_candidates)
        || (input.diagnostics.mode == "summary" && input.diagnostics.max_candidates != 1) {
        return error(&raw, "error", "invalid-input");
    }
    let public: serde_json::Map<String, Json> = PUBLIC_KEYS.iter().map(|k| (k.to_string(), raw[*k].clone())).collect();
    let admitted = (|| -> Result<Context, Error> {
        let root = native_s2::State::from_json(&input.state.to_string())?;
        if root.known_next.len() >= usize::from(profile.queue_depth) { return Err(Error::InvalidInput); }
        let multiplier = native_s2::parse_nonnegative_f64(&input.rules.multiplier_decimal)?;
        let cap = native_s2::parse_nonnegative_f64(&input.rules.cap_decimal)?;
        if f64::from(root.incoming.due_this_lock_rows) > cap.floor() { return Err(Error::InvalidInput); }
        let _clock = (input.lock_time.logical_frame, input.lock_time.pieces_placed);
        Context::new(root, multiplier, profile.max_depth, AmountTable {
            entries: input.root_amounts.entries, overflow_signatures: input.root_amounts.overflow_signatures,
        })
    })();
    let context = match admitted {Ok(context)=>context,Err(e)=>return from_error(&raw,e)};
    if stable_hash(&Json::Object(public)) != input.position_id { return error(&raw, "error", "public-position-hash"); }
    let result = (|| -> Result<Json, Error> {
        let mut engine = Engine::with_limits_and_trace(context, Policy::new(&profile.policy)?, profile.seed.parse().map_err(|_| Error::InvalidInput)?,profile.resources.clone(),input.diagnostics.root_work);
        let stopped = || cancel.load(Ordering::Acquire) || started.elapsed().as_millis() >= u128::from(input.remaining_millis);
        let mut interrupted = false;
        while engine.stats.selection_attempts < profile.budget.selections && !engine.complete() {
            if !engine.step(&stopped)? { interrupted = true; break; }
        }
        let cancelled = cancel.load(Ordering::Acquire);
        let (status, reason) = if cancelled { ("incomplete", "cancelled") }
            else if engine.capacity_reached() {
                (if engine.root_complete()&&engine.root_count()>0&&profile.resources.allow_capacity_snapshot {"move"}else{"incomplete"},"capacity-limit")
            }
            else if !engine.root_complete() { ("incomplete", "root-incomplete") }
            else if engine.root_count() == 0 { ("root-no-move", "no-legal-placement") }
            else if engine.complete() { ("move", "finite-tree-complete") }
            else if !interrupted && engine.stats.selection_attempts == profile.budget.selections {
                ("move", if profile.budget.mode == "time" { "time-selection-cap" } else { "selection-budget" })
            } else if profile.budget.mode == "time" { ("move", "deadline-budget") }
            else { ("incomplete", "deadline") };
        let mut response = error(&raw, status, reason);
        response["execution"] = json!(profile);
        response["diagnostics"] = engine.diagnostics_bounded_with_options(input.diagnostics.max_candidates, input.diagnostics.features, input.diagnostics.root_work)?;
        response["selectedMove"] = if status == "move" { response["diagnostics"]["rootCandidates"][0].clone() } else { Json::Null };
        response["search"] = json!(engine.stats);
        response["search"]["requestedSelections"] = json!(profile.budget.selections);
        response["search"]["rootExpansionComplete"] = json!(engine.root_complete());
        response["search"]["treeComplete"] = json!(engine.complete());
        response["search"]["capacityReached"] = json!(engine.capacity_reached());
        response["search"]["rootLegal"] = json!(engine.root_count());
        response["search"]["termination"] = json!(reason);
        response["metrics"] = json!({"nativeMicros": started.elapsed().as_micros() as u64,"maxCommitMicros":engine.max_commit_micros});
        Ok(response)
    })();
    match result {
        Ok(v) => v,
        Err(e) => from_error(&raw,e),
    }
}
fn from_error(raw:&Json,e:Error)->Json {
    error(raw,"error",match e {Error::InvalidInput=>"invalid-input",Error::NumericOverflow=>"numeric-overflow",
        Error::OracleMismatch=>"oracle-mismatch",Error::IllegalPlacement=>"illegal-placement"})
}
