//! Opt-in JSONL envelope for the single-worker native decision route.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::Instant;
use super::{Clear, Error, RootAmounts, State, parse_nonnegative_f64};
use crate::dag::finite::Search;
pub const FEATURE:&str="s2-native-integrated/1";
#[cfg(all(feature="native-pressure-height-recovery",feature="native-root-first-expansion"))]
compile_error!("native policy candidate features are mutually exclusive");
#[cfg(not(any(feature="native-pressure-height-recovery",feature="native-root-first-expansion")))]
pub const CONFIG_HASH:&str="sha256:f6ca6d9c896c614ea9f0a330742fa1d26395ec50d11661e9e826b1b335a8af40";
#[cfg(feature="native-pressure-height-recovery")]
pub const CONFIG_HASH:&str="sha256:61000f5c1d8fa56df2715785b4409d0cfc32cbee6ab822e745aa2cc9d78ebb8d";
#[cfg(all(feature="native-root-first-expansion",not(feature="native-pressure-height-recovery"),not(feature="native-root-attack-tiebreak"),not(feature="native-tsd-formation")))]
pub const CONFIG_HASH:&str="sha256:91263994ed95ca995079cbae503b7cb1bbbaa95bc253de3a258499953115f312";
#[cfg(feature="native-root-attack-tiebreak")]
pub const CONFIG_HASH:&str="sha256:46f041cf59a88afcd9923120473376edbfe7c967e4e1e2d1d22cd95a203e04a1";
#[cfg(not(any(feature="native-pressure-height-recovery",feature="native-root-first-expansion")))]
pub const CONFIG:&str=include_str!("policy.json");
#[cfg(feature="native-pressure-height-recovery")]
pub const CONFIG:&str=include_str!("policy-pressure-height-recovery.json");
#[cfg(all(feature="native-root-first-expansion",not(feature="native-pressure-height-recovery"),not(feature="native-root-attack-tiebreak"),not(feature="native-tsd-formation")))]
pub const CONFIG:&str=include_str!("policy-root-first-expansion.json");
#[cfg(feature="native-root-attack-tiebreak")]
pub const CONFIG:&str=include_str!("policy-root-attack-tiebreak.json");
#[cfg(all(feature="native-tsd-formation",feature="native-root-attack-tiebreak"))]
compile_error!("native policy candidate features are mutually exclusive");
#[cfg(all(feature="native-tsd-formation",not(feature="native-tslot-preview")))]
pub const CONFIG_HASH:&str="sha256:e69e7e5f0c6ffb16f4ba9fbc85a78fdd937378ee0ab1ec9bfdcd5840efc8e7d0";
#[cfg(all(feature="native-tsd-formation",not(feature="native-tslot-preview")))]
pub const CONFIG:&str=include_str!("policy-tsd-formation.json");
const RULE_HASH:&str="sha256:2c47b3df945f6714449b92d1b44346ef4bf0e1a20e95be8ed10c28be75c66a60";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Profile {pub profile_id:String,pub config_hash:String,pub seed:String,pub worker_concurrency:u32,pub budget:Budget}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Budget {pub mode:String,pub selections:u64,pub max_millis:u64}
impl Profile {
    pub fn valid(&self)->bool {
        id(&self.profile_id)&&self.config_hash==CONFIG_HASH&&self.worker_concurrency==1
        && self.seed.parse::<u64>().map_or(false,|n|n.to_string()==self.seed)
        && matches!(self.budget.mode.as_str(),"selection"|"time")
        && (1..=1_000_000).contains(&self.budget.selections)&&(1..=300_000).contains(&self.budget.max_millis)
    }
}
fn id(s:&str)->bool {!s.is_empty()&&s.len()<=128&&s.bytes().all(|b|b.is_ascii_graphic())}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Rules {id:String,normalized_options_hash:String,multiplier_decimal:String,cap_decimal:String}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Clock {logical_frame:u32,pieces_placed:u32,frame_semantics:String,clock_model:String}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Randomizer {model:String,knowledge:String,bag:Vec<crate::data::Piece>}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Amounts {id:String,entries:Vec<RootAmounts>,overflow_signatures:Vec<Clear>}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Request {
    #[serde(rename="type")] kind:String,schema_version:u32,request_id:String,position_id:String,
    generation:u64,execution:Profile,state:Json,rules:Rules,lock_time:Clock,randomizer:Randomizer,
    root_amounts:Amounts,movement:String,visible_height:u32,diagnostics:bool,
}
pub fn error(request:&Json,status:&str,reason:&str)->Json {
    let safe=|key:&str|request.get(key).and_then(Json::as_str).filter(|s|id(s)).map(str::to_owned);
    json!({"type":"s2_decision","schemaVersion":1,"requestId":safe("requestId"),"positionId":safe("positionId"),
        "generation":request.get("generation").and_then(Json::as_u64),"profileId":request.pointer("/execution/profileId").and_then(Json::as_str).filter(|s|id(s)),
        "status":status,"reason":reason,"selectedMove":null,"search":{},"diagnostics":{}})
}
fn completion_status(time_mode:bool,complete:bool,count:usize,closed:bool,budget:bool,cancelled:bool)->(&'static str,&'static str) {
    if cancelled {("incomplete","cancelled")}
    else if complete&&count==0 {("root-no-move","root-no-legal-action")}
    else if complete&&closed {("move","finite-tree-complete")}
    else if complete&&budget {("move",if time_mode {"time-selection-cap"}else{"selection-budget"})}
    else if complete&&time_mode {("move","deadline-budget")}
    else {("incomplete","deadline")}
}
pub fn decide(raw:Json,profile:&Profile,cancel:Arc<AtomicBool>)->Json {
    let request:Request=match serde_json::from_value(raw.clone()) {Ok(v)=>v,Err(_)=>return error(&raw,"error","invalid-input")};
    let unsupported=request.schema_version!=1||request.execution!=*profile||!profile.valid()
        ||request.rules.normalized_options_hash!=RULE_HASH
        ||request.rules.id!=format!("tetrio-s2-v19-{}-beta-1-5-0", &RULE_HASH[7..])
        ||request.randomizer.model!="seven_bag"||!matches!(request.randomizer.knowledge.as_str(),"unknown"|"known-set")
        ||request.movement!="native-s2-final-placement/1"||request.visible_height!=20
        ||request.lock_time.frame_semantics!="engine-frame"
        ||!matches!(request.lock_time.clock_model.as_str(),"synthetic-placement-lock/1"|"replay-clock/1")
        ||request.root_amounts.id!="s2-native-root-amounts/1";
    if unsupported {return error(&raw,"unsupported","unsupported-version-model-or-profile")}
    let mut bag=std::collections::HashSet::new();
    if request.kind!="s2_decide"||!id(&request.request_id)||!id(&request.position_id)
        ||request.root_amounts.entries.len()+request.root_amounts.overflow_signatures.len()!=51
        ||request.randomizer.bag.iter().any(|p|!bag.insert(*p))
        ||(request.randomizer.knowledge=="unknown"&&!request.randomizer.bag.is_empty()) {
        return error(&raw,"error","invalid-input")
    }
    // All 51 signatures must be covered exactly once; arithmetic checks only apply to used rows.
    let mut signatures=std::collections::HashSet::new();
    for signature in request.root_amounts.entries.iter().map(|r|r.signature).chain(request.root_amounts.overflow_signatures.iter().copied()) {
        if signature.validate().is_err()||!signatures.insert(signature) {return error(&raw,"error","invalid-input")}
    }
    let result=(||->Result<Json,Error> {
        let state=State::from_json(&request.state.to_string())?;
        let multiplier=parse_nonnegative_f64(&request.rules.multiplier_decimal)?;
        let cap=parse_nonnegative_f64(&request.rules.cap_decimal)?;
        if state.incoming.due_this_lock_rows as f64>cap.floor() {return Err(Error::InvalidInput)}
        let _public_clock=(request.lock_time.logical_frame,request.lock_time.pieces_placed,request.generation);
        let start=Instant::now();
        let stopped=||cancel.load(Ordering::Acquire)||start.elapsed().as_millis()>=profile.budget.max_millis as u128;
        let mut search=Search::new(state,multiplier,request.root_amounts.entries,profile.seed.parse().map_err(|_|Error::InvalidInput)?)?;
        search.reserve_budget(profile.budget.selections);
        while search.stats.selections<profile.budget.selections&&!search.closed() {
            if !search.step(&stopped)? {break}
        }
        let complete=search.root_complete();let count=search.root_count();
        let budget=search.stats.selections==profile.budget.selections;
        let cancelled=cancel.load(Ordering::Acquire);
        let (status,reason)=completion_status(profile.budget.mode=="time",complete,count,search.closed(),budget,cancelled);
        let mut response=error(&raw,status,reason);
        response["execution"]=json!(profile);
        response["selectedMove"]=if status=="move" {search.selected()?}else{Json::Null};
        response["search"]=json!({"nodes":search.stats.nodes,"requestedSelections":profile.budget.selections,
            "actualSelections":search.stats.selections,"rootGenerated":count,"rootLegal":count,
            "rootExpansionComplete":complete,"termination":reason});
        response["metrics"]=json!({"phaseMicros":search.phase_micros.map(|v|v as u64)});
        response["diagnostics"]=search.diagnostics(request.diagnostics)?;
        response["diagnostics"]["futureModel"]=json!("frozen-root-time-no-arrivals-standard-cancel/1");
        Ok(response)
    })();
    match result {Ok(v)=>v,Err(e)=>error(&raw,"error",match e {Error::NumericOverflow=>"numeric-overflow",Error::OracleMismatch=>"oracle-mismatch",Error::IllegalPlacement=>"illegal-placement",Error::InvalidInput=>"invalid-input"})}
}

#[cfg(all(feature="native-tslot-preview",not(feature="native-tslot-bonus-distance")))]
pub const CONFIG_HASH:&str="sha256:413f08d64dcfb3be18eed34be5091fbf0c106c1d29f164054621425389e99847";
#[cfg(all(feature="native-tslot-preview",not(feature="native-tslot-bonus-distance")))]
pub const CONFIG:&str=include_str!("policy-tslot-preview.json");

#[cfg(test)]
mod completion_tests {
    use super::*;
    #[test]
    fn deadline_returns_only_completed_time_roots_and_cancel_wins() {
        assert_eq!(completion_status(true,true,2,false,false,false),("move","deadline-budget"));
        assert_eq!(completion_status(true,true,2,false,true,false),("move","time-selection-cap"));
        assert_eq!(completion_status(false,true,2,false,true,false),("move","selection-budget"));
        assert_eq!(completion_status(false,true,2,false,false,false),("incomplete","deadline"));
        assert_eq!(completion_status(true,false,0,false,false,false),("incomplete","deadline"));
        for closed in [false,true] {for budget in [false,true] {
            assert_eq!(completion_status(true,true,2,closed,budget,true),("incomplete","cancelled"));
        }}
        assert_eq!(completion_status(true,true,0,true,false,false),("root-no-move","root-no-legal-action"));
        assert_eq!(completion_status(true,true,2,true,false,false),("move","finite-tree-complete"));
    }
}

#[cfg(feature="native-tslot-bonus-distance")]
pub const CONFIG:&str=include_str!("policy-tslot-bonus-distance.json");
#[cfg(feature="native-tslot-bonus-distance")]
pub const CONFIG_HASH:&str="sha256:29a39755624eab231731f45bc9aea9c0bd3e2f67319b69666a8b96786ab6ad54";
