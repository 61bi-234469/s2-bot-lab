//! Request-owned integration using the existing CC2 known-layer DAG.
//! Shared by the production S2 transport and the fixed-state diagnostic.
use crate::dag::{ChildData, Dag};
use crate::data::Piece;
use crate::native_s2::{self, Error};
use crate::s2_core::{Action, AmountTable, Context, Horizon, PressureView};
use crate::s2_eval::{self, EdgeFeatures, LeafFeatures, Policy, PolicyInput, Value};
use enum_map::EnumMap;
use rand::{rngs::StdRng, SeedableRng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone,Debug,PartialEq,Eq,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Limits {
    pub max_nodes:usize,pub max_edges:usize,pub max_batch_actions:usize,pub max_memory_bytes:usize,
    pub allow_capacity_snapshot:bool,
}
impl Default for Limits {
    fn default()->Self {Self {max_nodes:1_000_000,max_edges:2_000_000,max_batch_actions:4096,
        max_memory_bytes:512*1024*1024,allow_capacity_snapshot:false}}
}
impl Limits {
    pub fn valid(&self)->bool {(1..=1_000_000).contains(&self.max_nodes)&&(1..=2_000_000).contains(&self.max_edges)
        &&(1..=4096).contains(&self.max_batch_actions)&&(1..=1024*1024*1024).contains(&self.max_memory_bytes)}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConversionScope {
    AllEdges,
    RootOnly,
}
impl ConversionScope {
    fn parse(value:Option<&str>)->Result<Self,String> {match value.unwrap_or("all-edges") {
        "all-edges"=>Ok(Self::AllEdges),"root-only"=>Ok(Self::RootOnly),_=>Err("unsupported conversion scope".into())}}
    fn includes_at(self,depth:u16)->bool {matches!(self,Self::AllEdges)||depth==0}
    fn as_str(self)->&'static str {match self {Self::AllEdges=>"all-edges",Self::RootOnly=>"root-only"}}
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Statistics {
    pub selection_attempts:u64, pub committed_expansions:u64,
    pub evaluated_edges:u64,pub committed_edges:u64, pub nodes:usize, pub registered_layers:usize,
    pub unknown_tank_edges:u64, pub known_next_edges:u64, pub depth_limit_edges:u64,
    pub index_capacity:usize, pub index_allocation_estimate_bytes:usize,
    pub arena_allocated_bytes:usize,pub node_storage_estimate_bytes:usize,
    pub initialized_layers:usize,
    pub memory_charge_bytes:usize,pub peak_memory_charge_bytes:usize,pub parent_copy_slots:u64,
}
struct RootInfo {
    action:Action, leaf:LeafFeatures, edge:EdgeFeatures, post_state_eval:Value,
    pressure:PressureView,
}
#[derive(Clone)]
struct RootScore {index:usize, q:Value, continuation:Value, reward:f64, inside_margin:bool}
#[derive(Clone)]
struct Snapshot {version:u64, roots:Vec<RootScore>}

#[derive(Clone, Copy, Default)]
struct RewardMetric { occurrences:u64, feature_total:f64, contribution_total:f64 }

#[derive(Clone, Copy, Default)]
struct BranchMetric { occurrences:u64, conversion_units_total:f64, contribution_total:f64 }

#[derive(Clone)]
struct RewardBreakdown {
    evaluated_edges:u64,
    total_reward:f64,
    components:[RewardMetric;6],
    normal_clear:RewardMetric,
    normal_clear_line_counts:[u64;5],
    conversion_branches:BTreeMap<String,BranchMetric>,
}
impl Default for RewardBreakdown {
    fn default()->Self {Self {evaluated_edges:0,total_reward:0.,components:[RewardMetric::default();6],normal_clear:RewardMetric::default(),normal_clear_line_counts:[0;5],conversion_branches:BTreeMap::new()}}
}
impl RewardBreakdown {
    fn add_edge(&mut self,features:&EdgeFeatures,contributions:[f64;6],normal_clear:Option<(f64,f64)>,reward:f64) {
        let values=[features.outgoing_after_cancel,features.cancelled_rows,features.conversion_units,
            features.tank_rows,features.soft_drops,features.wasted_t];
        self.evaluated_edges+=1;self.total_reward+=reward;
        for index in 0..6 {
            self.components[index].feature_total+=values[index];
            self.components[index].contribution_total+=contributions[index];
            if values[index]!=0. {self.components[index].occurrences+=1;}
        }
        if let Some((units,contribution))=normal_clear {
            self.normal_clear.occurrences+=1;
            self.normal_clear.feature_total+=units;
            self.normal_clear.contribution_total+=contribution;
            self.normal_clear_line_counts[features.clear_lines as usize]+=1;
        }
        let branch=self.conversion_branches.entry(features.conversion_branch.to_string()).or_default();
        branch.occurrences+=1;branch.conversion_units_total+=features.conversion_units;
        branch.contribution_total+=contributions[2];
    }
    fn merge(&mut self,other:&Self) {
        self.evaluated_edges+=other.evaluated_edges;self.total_reward+=other.total_reward;
        for (left,right) in self.components.iter_mut().zip(other.components) {
            left.occurrences+=right.occurrences;left.feature_total+=right.feature_total;
            left.contribution_total+=right.contribution_total;
        }
        self.normal_clear.occurrences+=other.normal_clear.occurrences;
        self.normal_clear.feature_total+=other.normal_clear.feature_total;
        self.normal_clear.contribution_total+=other.normal_clear.contribution_total;
        for (left,right) in self.normal_clear_line_counts.iter_mut().zip(other.normal_clear_line_counts) { *left+=right; }
        for (key,right) in &other.conversion_branches {
            let left=self.conversion_branches.entry(key.clone()).or_default();
            left.occurrences+=right.occurrences;left.conversion_units_total+=right.conversion_units_total;
            left.contribution_total+=right.contribution_total;
        }
    }
    fn json(&self)->Json {
        let names=["outgoingAfterCancel","cancelledRows","conversionUnits","tankRows","softDrops","wastedT"];
        let components=names.into_iter().zip(self.components).map(|(name,metric)|
            (name.to_string(),json!({"occurrences":metric.occurrences,"featureTotal":metric.feature_total,
                "contributionTotal":metric.contribution_total}))).collect::<serde_json::Map<_,_>>();
        let branches=self.conversion_branches.iter().map(|(name,metric)|
            (name.clone(),json!({"occurrences":metric.occurrences,"conversionUnitsTotal":metric.conversion_units_total,
                "contributionTotal":metric.contribution_total}))).collect::<serde_json::Map<_,_>>();
        json!({"evaluatedEdges":self.evaluated_edges,"totalReward":self.total_reward,
            "components":components,"actionReward":{"occurrences":self.normal_clear.occurrences,
                "featureTotal":self.normal_clear.feature_total,"contributionTotal":self.normal_clear.contribution_total,
                "lineCounts":self.normal_clear_line_counts},
            "conversionBranches":branches})
    }
}

// This trace is deliberately downstream of the existing selector and commit
// path. It records only committed work and assigns each expanded shared node
// to one deterministic owner, so a shared DAG node is never counted twice.
struct RootWorkTrace {
    max_depth:usize,
    opportunities:BTreeMap<[i64;17],Vec<u64>>,
    reachable:BTreeMap<(usize,[i64;30]),BTreeSet<[i64;17]>>,
    expanded:BTreeSet<(usize,[i64;30])>,
    node_rewards:BTreeMap<(usize,[i64;30]),RewardBreakdown>,
    root_rewards:BTreeMap<[i64;17],RewardBreakdown>,
    reward_breakdown:RewardBreakdown,
    normal_clear_by_depth:Vec<RewardMetric>,
    normal_clear_line_counts_by_depth:Vec<[u64;5]>,
}
impl RootWorkTrace {
    fn new(max_depth:usize)->Self {Self {max_depth,opportunities:BTreeMap::new(),reachable:BTreeMap::new(),
        expanded:BTreeSet::new(),node_rewards:BTreeMap::new(),root_rewards:BTreeMap::new(),reward_breakdown:RewardBreakdown::default(),
        normal_clear_by_depth:vec![RewardMetric::default();max_depth+1],normal_clear_line_counts_by_depth:vec![[0;5];max_depth+1]}}
    fn record_committed(&mut self,root_action:Option<[i64;17]>,path_keys:&[[i64;30]],reward:RewardBreakdown,
        root_rewards:BTreeMap<[i64;17],RewardBreakdown>) {
        assert!(!path_keys.is_empty());self.reward_breakdown.merge(&reward);
        let depth=path_keys.len()-1;assert!(depth<=self.max_depth);
        self.normal_clear_by_depth[depth].occurrences+=reward.normal_clear.occurrences;
        self.normal_clear_by_depth[depth].feature_total+=reward.normal_clear.feature_total;
        self.normal_clear_by_depth[depth].contribution_total+=reward.normal_clear.contribution_total;
        for (left,right) in self.normal_clear_line_counts_by_depth[depth].iter_mut().zip(reward.normal_clear_line_counts) { *left+=right; }
        if let Some(root_key)=root_action {
            let opportunities=self.opportunities.entry(root_key).or_insert_with(||vec![0;self.max_depth+1]);
            opportunities[depth]+=1;
            for (depth,key) in path_keys.iter().enumerate().skip(1) {
                self.reachable.entry((depth,*key)).or_default().insert(root_key);
            }
            let node=(depth,*path_keys.last().unwrap());
            assert!(self.expanded.insert(node));
            self.node_rewards.entry(node).or_default().merge(&reward);
        } else {
            for (key,value) in root_rewards {
                self.root_rewards.entry(key).or_default().merge(&value);
            }
        }
    }
    fn json(&self,scores:&[RootScore],root_info:&[RootInfo],limit:usize,committed_expansions:u64)->Json {
        let mut owner_by_node=BTreeMap::new();let mut shared=0u64;
        for node in &self.expanded {
            let Some(roots)=self.reachable.get(node) else {continue;};
            if roots.len()>1 {shared+=1;}
            if let Some(owner)=roots.iter().next() {owner_by_node.insert(*node,*owner);}
        }
        let mut owned=BTreeMap::<[i64;17],u64>::new();
        let mut attributed=BTreeMap::<[i64;17],RewardBreakdown>::new();
        for (key,value) in &self.root_rewards {attributed.insert(*key,value.clone());}
        for node in &self.expanded {
            if let Some(owner)=owner_by_node.get(node) {
                *owned.entry(*owner).or_default()+=1;
                if let Some(reward)=self.node_rewards.get(node) {attributed.entry(*owner).or_default().merge(reward);}
            }
        }
        let selection_opportunities=self.opportunities.values().map(|values|values.iter().sum::<u64>()).sum::<u64>();
        let owned_total=self.expanded.len() as u64;
        assert_eq!(selection_opportunities,owned_total);
        assert_eq!(owned.values().sum::<u64>(),owned_total);
        let roots=scores.iter().take(limit).enumerate().map(|(rank,score)| {
            let info=&root_info[score.index];let key=info.action.key();
            let opportunities=self.opportunities.get(&key).cloned().unwrap_or_else(||vec![0;self.max_depth+1]);
            let reached_depth=opportunities.iter().rposition(|count|*count>0).unwrap_or(0);
            let reachable_node_count=self.reachable.iter().filter(|(_,roots)|roots.contains(&key)).count() as u64;
            let reward=attributed.get(&key).cloned().unwrap_or_default();
            json!({"rank":rank+1,"actionKey":key,"selectionOpportunities":opportunities.iter().sum::<u64>(),
                "opportunitiesByDepth":opportunities,"reachedDepth":reached_depth,
                "reachableNodeCount":reachable_node_count,"ownedNodeExpansions":owned.get(&key).copied().unwrap_or(0),
                "rewardBreakdown":reward.json()})
        }).collect::<Vec<_>>();
        let saved_opportunities=roots.iter().map(|root|root["selectionOpportunities"].as_u64().unwrap()).sum::<u64>();
        let saved_owned=roots.iter().map(|root|root["ownedNodeExpansions"].as_u64().unwrap()).sum::<u64>();
        let normal_clear_by_depth=self.normal_clear_by_depth.iter().enumerate().map(|(depth,metric)|
            json!({"depth":depth,"occurrences":metric.occurrences,"featureTotal":metric.feature_total,"contributionTotal":metric.contribution_total,
                "lineCounts":self.normal_clear_line_counts_by_depth[depth]})).collect::<Vec<_>>();
        json!({"schema":"s2-root-work-trace/1",
            "attribution":"shared-depth-state-node-expansion-owner=lexicographically-first-root-action-key",
            "rootCandidates":roots,"rootCandidateCount":scores.len(),
            "uniqueNonRootExpandedNodes":owned_total,"sharedNonRootExpandedNodes":shared,
            "ownedNodeExpansionsTotal":owned_total,"selectionOpportunities":selection_opportunities,
            "unreportedRootCandidates":scores.len().saturating_sub(roots.len()),
            "unreportedSelectionOpportunities":selection_opportunities.saturating_sub(saved_opportunities),
            "unreportedOwnedNodeExpansions":owned_total.saturating_sub(saved_owned),
            "rewardBreakdown":self.reward_breakdown.json(),"normalClearByDepth":normal_clear_by_depth,
            "committedExpansions":committed_expansions})
    }
}

pub struct Engine {
    context:Context, policy:Policy, dag:Dag<Value>, rng:StdRng,
    pub stats:Statistics,
    root_info:Vec<RootInfo>, root_index:BTreeMap<[i64;17],usize>, snapshot:Option<Snapshot>,
    failure:Option<Error>,
    limits:Option<Limits>,capacity_reached:bool,
    committed_layer_edges:Vec<usize>,
    pub max_commit_micros:u64,
    root_work:Option<Box<RootWorkTrace>>,
    conversion_scope:ConversionScope,
}
impl Engine {
    pub fn new(context:Context,policy:Policy,seed:u64)->Self {
        let committed_layer_edges=vec![0;context.max_depth() as usize+1];
        // Reserve all possible layer/shard owners, the immutable context, input
        // JSON, and bounded board movegen workspace. This is accounting, not RSS.
        let base=Dag::<Value>::allocation_units().layer.checked_mul(context.max_depth() as usize+1)
            .and_then(|n|n.checked_add(2*1024*1024+std::mem::size_of::<Self>()
                +std::mem::size_of::<Context>()+13*std::mem::size_of::<Piece>()
                +51*std::mem::size_of::<native_s2::RootAmounts>()))
            .and_then(|n|committed_layer_edges.capacity().checked_mul(std::mem::size_of::<usize>()).and_then(|v|n.checked_add(v)))
            .unwrap_or(usize::MAX);
        let dag=Dag::new_s2(context.root());
        let mut engine=Self {context,policy,dag,rng:StdRng::seed_from_u64(seed),
            stats:Statistics {nodes:1,registered_layers:1,memory_charge_bytes:base,peak_memory_charge_bytes:base,..Statistics::default()},
            root_info:vec![],root_index:BTreeMap::new(),snapshot:None,failure:None,limits:None,capacity_reached:false,committed_layer_edges,max_commit_micros:0,root_work:None,
            conversion_scope:ConversionScope::AllEdges};
        engine.refresh_storage();engine
    }
    pub fn with_conversion_scope(context:Context,policy:Policy,seed:u64,conversion_scope:ConversionScope)->Self {
        let mut engine=Self::new(context,policy,seed);engine.conversion_scope=conversion_scope;engine
    }
    pub fn with_conversion_scope_and_trace(context:Context,policy:Policy,seed:u64,conversion_scope:ConversionScope,trace_root_work:bool)->Self {
        let mut engine=Self::with_conversion_scope(context,policy,seed,conversion_scope);
        if trace_root_work {engine.root_work=Some(Box::new(RootWorkTrace::new(engine.context.max_depth() as usize)));}
        engine
    }
    pub fn with_limits(context:Context,policy:Policy,seed:u64,limits:Limits)->Self {
        Self::with_limits_and_trace(context,policy,seed,limits,false)
    }
    pub fn with_limits_and_trace(context:Context,policy:Policy,seed:u64,limits:Limits,trace_root_work:bool)->Self {
        Self::with_limits_and_trace_and_conversion_scope(context,policy,seed,limits,trace_root_work,ConversionScope::AllEdges)
    }
    pub fn with_limits_and_trace_and_conversion_scope(context:Context,policy:Policy,seed:u64,limits:Limits,trace_root_work:bool,conversion_scope:ConversionScope)->Self {
        assert!(limits.valid());let mut engine=Self::with_conversion_scope(context,policy,seed,conversion_scope);
        engine.capacity_reached=engine.stats.memory_charge_bytes>limits.max_memory_bytes;
        if trace_root_work {engine.root_work=Some(Box::new(RootWorkTrace::new(engine.context.max_depth() as usize)));}
        engine.limits=Some(limits);engine
    }
    pub fn capacity_reached(&self)->bool {self.capacity_reached}
    fn batch_charge(actions:usize)->Option<usize> {
        // Actions + ChildData/transition features + allocation-quote map +
        // child sorting buffer. Vec growth and old/new root snapshots overlap.
        actions.checked_mul(4*(std::mem::size_of::<Action>()+std::mem::size_of::<ChildData<Value>>()
            +std::mem::size_of::<RootInfo>()+std::mem::size_of::<RootScore>()+256))
    }
    pub fn complete(&self)->bool {self.dag.is_complete()}
    pub fn root_complete(&self)->bool {self.snapshot.is_some()}
    pub fn root_count(&self)->usize {self.root_info.len()}
    pub fn step(&mut self,stopped:&impl Fn()->bool)->Result<bool,Error> {
        if let Some(error)=self.failure {return Err(error);}
        let result=self.step_inner(stopped);
        if let Err(error)=result {self.failure=Some(error);self.snapshot=None;}
        // Aborted quotes can initialize an empty next layer without committing
        // any search edges. Allocation diagnostics must still include it.
        if !matches!(result,Ok(true)) {self.refresh_storage();}
        result
    }
    fn step_inner(&mut self,stopped:&impl Fn()->bool)->Result<bool,Error> {
        if stopped()||self.complete()||self.capacity_reached {return Ok(false);}
        self.stats.selection_attempts+=1;
        let selection=self.dag.select(false,self.policy.exploration(),&mut self.rng).ok_or(Error::InvalidInput)?;
        let depth=u16::try_from(selection.depth()).map_err(|_|Error::NumericOverflow)?;
        let trace_root_action=self.root_work.as_ref().and_then(|_|selection.root_action().map(|action|action.key()));
        let trace_path_keys=self.root_work.as_ref().map(|_|selection.path_states().iter().map(|state|state.key()).collect::<Vec<_>>());
        let (state,piece)=selection.state();
        let prepared=self.context.prepare(state,depth)?;
        if stopped() {return Ok(false);}
        let actions=prepared.actions()?;
        let scratch=Self::batch_charge(actions.len()).unwrap_or(usize::MAX);
        let initial_peak=self.stats.memory_charge_bytes.checked_add(scratch).unwrap_or(usize::MAX);
        if self.limits.as_ref().map_or(false,|l|actions.len()>l.max_batch_actions||initial_peak>l.max_memory_bytes) {
            self.capacity_reached=true;return Ok(false);
        }
        self.stats.peak_memory_charge_bytes=self.stats.peak_memory_charge_bytes.max(initial_peak);
        let mut children:EnumMap<Piece,Vec<ChildData<Value>>>=EnumMap::default();
        let mut root_info=vec![];
        let mut horizons=[0u64;3];
        let mut reward_trace=RewardBreakdown::default();
        let mut root_rewards=BTreeMap::<[i64;17],RewardBreakdown>::new();
        for action in actions {
            if stopped() {return Ok(false);}
            let transition=prepared.transition(action)?;
            let leaf=s2_eval::leaf_features(&self.context,transition.next,&self.policy)?;
            let edge=s2_eval::edge_features(&self.context,state,action,&transition)?;
            let eval=Value::finite(self.policy.leaf(&leaf)?)?;
            let include_conversion=self.conversion_scope.includes_at(depth);
            let normal_clear=self.policy.normal_clear_detail(&edge);
            let reward=self.policy.edge_scoped(&edge,include_conversion)?;
            if self.root_work.is_some() {
                let contributions=self.policy.edge_contributions_scoped(&edge,include_conversion);
                reward_trace.add_edge(&edge,contributions,normal_clear,reward);
                if depth==0 {root_rewards.entry(action.key()).or_default().add_edge(&edge,contributions,normal_clear,reward);}
            }
            self.stats.evaluated_edges+=1;
            if transition.amounts.tank_rows > 0 {
                horizons[0] += 1;
            } else {
                match transition.next.horizon {
                    Horizon::KnownNextExhausted=>horizons[1]+=1,
                    Horizon::DepthLimit=>horizons[2]+=1,
                    Horizon::Open=>{},
                }
            }
            children[piece.ok_or(Error::InvalidInput)?].push(ChildData {resulting_state:transition.next,mv:action,eval,reward,
                root_priority:self.policy.risk_enabled()&&transition.pressure.inside_margin()});
            if depth==0 {root_info.push(RootInfo {action,leaf,edge,post_state_eval:eval,pressure:transition.pressure});}
        }
        if stopped() {return Ok(false);}
        let edges=children.values().map(Vec::len).sum::<usize>();
        let units=Dag::<Value>::allocation_units();
        let charge=(||->Option<(usize,usize,usize,usize)> {
            let quote=selection.allocation_quote(&children)?;
            let nodes=self.stats.nodes.checked_add(quote.new_nodes)?;
            let all_edges=usize::try_from(self.stats.committed_edges).ok()?.checked_add(edges)?;
            let root_storage=if depth==0 {edges.checked_mul(2*(std::mem::size_of::<RootInfo>()+std::mem::size_of::<RootScore>()+192))?}else{0};
            let resident=self.stats.memory_charge_bytes.checked_add(edges.checked_mul(units.node_and_edge)?)?
                .checked_add(quote.parent_allocation_slots.checked_mul(units.parent_slot)?)?.checked_add(root_storage)?;
            let layer_edges=self.committed_layer_edges[depth as usize].checked_add(edges)?;
            // Backup visits one layer at a time. Each work vector and its
            // insertion-time dedup set contain at most that layer's edges.
            // The existing unit covers both adjacent vectors, the set and
            // allocation growth; preserve that slack for the largest layer.
            let backup_edges=self.committed_layer_edges.iter().copied().max().unwrap_or(0).max(layer_edges);
            let peak=resident.checked_add(scratch)?.checked_add(backup_edges.checked_mul(units.backup_edge)?)?;
            if self.limits.as_ref().map_or(false,|l|nodes>l.max_nodes||all_edges>l.max_edges||peak>l.max_memory_bytes) {return None;}
            Some((resident,peak,quote.parent_copy_slots,layer_edges))
        })();
        let Some((resident,peak,parent_slots,layer_edges))=charge else {self.capacity_reached=true;return Ok(false);};
        if stopped() {return Ok(false);}
        let commit_started=std::time::Instant::now();
        selection.expand(children); // atomic publication and complete backup
        if let Some(root_work)=self.root_work.as_mut() {
            root_work.record_committed(trace_root_action,trace_path_keys.as_deref().ok_or(Error::InvalidInput)?,reward_trace,root_rewards);
        }
        self.committed_layer_edges[depth as usize]=layer_edges;
        self.stats.committed_expansions+=1;
        self.stats.committed_edges+=edges as u64;
        self.stats.memory_charge_bytes=resident;self.stats.peak_memory_charge_bytes=self.stats.peak_memory_charge_bytes.max(peak);
        self.stats.parent_copy_slots+=parent_slots as u64;
        self.stats.registered_layers=self.stats.registered_layers.max(depth as usize+2);
        self.stats.unknown_tank_edges+=horizons[0];self.stats.known_next_edges+=horizons[1];self.stats.depth_limit_edges+=horizons[2];
        if depth==0 {
            self.root_index=root_info.iter().enumerate().map(|(i,r)|(r.action.key(),i)).collect();
            if self.root_index.len()!=root_info.len() {return Err(Error::InvalidInput);}
            self.root_info=root_info;
        }
        self.publish_snapshot()?;
        self.max_commit_micros=self.max_commit_micros.max(commit_started.elapsed().as_micros() as u64);
        Ok(true)
    }
    fn publish_snapshot(&mut self)->Result<(),Error> {
        if !self.dag.root_complete() {return Ok(());}
        let mut roots=vec![];
        for edge in self.dag.root_edges() {
            if edge.value==Value::NumericError||edge.continuation==Value::NumericError {return Err(Error::NumericOverflow);}
            if edge.value!=edge.continuation+edge.reward {return Err(Error::InvalidInput);}
            let index=*self.root_index.get(&edge.action.key()).ok_or(Error::InvalidInput)?;
            roots.push(RootScore {index,q:edge.value,continuation:edge.continuation,reward:edge.reward,inside_margin:edge.inside_margin});
        }
        self.refresh_storage();
        self.snapshot=Some(Snapshot {version:self.stats.committed_expansions,roots});
        Ok(())
    }
    fn refresh_storage(&mut self) {
        let s=self.dag.initialized_storage();
        self.stats.nodes=s.keys;self.stats.index_capacity=s.index_capacity;self.stats.index_allocation_estimate_bytes=s.index_bytes;
        self.stats.arena_allocated_bytes=s.arena_bytes;self.stats.node_storage_estimate_bytes=s.node_storage;
        self.stats.initialized_layers=s.initialized_layers;
    }
    fn candidate(&self,score:&RootScore)->Result<Json,Error> {
        let info=&self.root_info[score.index];
        let mut result=json!({"actionKey":info.action.key(),"holdUsed":info.action.hold_used(),"witness":info.action.witness_json(),
            "postStateEval":info.post_state_eval.diagnostic()?,"reward":score.reward,
            "continuationValue":score.continuation.diagnostic()?,"q":score.q.diagnostic()?,
            "insideMargin":score.inside_margin,"pressure":info.pressure,"leafFeatures":info.leaf,"edgeFeatures":info.edge});
        if let Some((units,contribution))=self.policy.normal_clear_detail(&info.edge) {
            result["actionReward"]=json!({"schema":"s2-cc2-action-reward/1","group":"normal-clear-v1",
                "clearLines":info.edge.clear_lines,"canonicalSpin":"none","perfectClear":false,
                "units":units,"contribution":contribution});
        }
        Ok(result)
    }
    pub fn selected(&self)->Result<Json,Error> {
        if let Some(error)=self.failure {return Err(error);}
        self.snapshot.as_ref().and_then(|s|s.roots.first()).map_or(Ok(Json::Null),|r|self.candidate(r))
    }
    pub fn diagnostics(&self,detailed:bool)->Result<Json,Error> {
        self.diagnostics_bounded(if detailed {32}else{1},true)
    }
    pub fn diagnostics_bounded(&self,limit:usize,features:bool)->Result<Json,Error> {
        self.diagnostics_bounded_with_options(limit,features,false)
    }
    pub fn diagnostics_bounded_with_options(&self,limit:usize,features:bool,include_root_work:bool)->Result<Json,Error> {
        let scores=self.snapshot.as_ref().map_or(&[][..],|s|s.roots.as_slice());
        let saved=scores.iter().take(limit).map(|s|self.candidate(s).map(|mut c| {
            if !features {c.as_object_mut().unwrap().remove("leafFeatures");c.as_object_mut().unwrap().remove("edgeFeatures");}
        c
        })).collect::<Result<Vec<_>,_>>()?;
        let mut result=json!({"snapshotVersion":self.snapshot.as_ref().map(|s|s.version),"rootCandidates":saved,
            "rootCandidateCount":scores.len(),"savedCandidateCount":saved.len(),"omittedCandidateCount":scores.len()-saved.len(),
            "featureVersion":self.policy.feature_version(),"amountModel":"canonical-u32-outgoing-all-remaining-due-next-lock/1",
            "clockModel":"frozen-root-rules/1","randomizerModel":"known-next-only/1",
            "riskEnabled":self.policy.risk_enabled(),"tsdWitnessModel":"normal-entry-first-64-public-t/1"});
        if include_root_work {
            result["rootWork"]=self.root_work.as_ref().map_or_else(||json!({}),|trace|
                trace.json(scores,&self.root_info,limit,self.stats.committed_expansions));
        }
        Ok(result)
    }
}

pub const DIAGNOSTIC_ID:&str="s2-cc2-search-diagnostic/1";
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Request {
    schema:String, state:Json, root_amounts:AmountTable, multiplier_decimal:String,
    policy:PolicyInput, max_depth:u16, seed:String, selections:u64, max_millis:u64,
    mode:String, diagnostics:bool, speculate:bool,
    #[serde(default)] limits:Option<Limits>,
    #[serde(default)] conversion_scope:Option<String>,
    #[serde(default)] root_work:bool,
}
pub fn diagnose(raw:Json)->Result<Json,String> {
    let input:Request=serde_json::from_value(raw).map_err(|e|e.to_string())?;
    if input.schema!=DIAGNOSTIC_ID||input.speculate||!(1..=128).contains(&input.max_depth)
        ||!(1..=4096).contains(&input.selections)||!(1..=30_000).contains(&input.max_millis)
        ||!matches!(input.mode.as_str(),"selection"|"time") {return Err("unsupported diagnostic profile".into());}
    let seed=input.seed.parse::<u64>().map_err(|_|"invalid seed")?;
    if seed.to_string()!=input.seed {return Err("non-canonical seed".into());}
    let conversion_scope=ConversionScope::parse(input.conversion_scope.as_deref())?;
    if let Some(limits)=&input.limits {if !limits.valid(){return Err("invalid diagnostic limits".into());}}
    let result=(||->Result<Json,Error> {
        let start=std::time::Instant::now();
        let root=native_s2::State::from_json(&input.state.to_string())?;
        if root.known_next.len()>13 {return Err(Error::InvalidInput);}
        let multiplier=native_s2::parse_nonnegative_f64(&input.multiplier_decimal)?;
        let context=Context::new(root,multiplier,input.max_depth,input.root_amounts)?;
        let policy=Policy::new(&input.policy)?;
        let mut engine=match input.limits.clone() {
            Some(limits)=>Engine::with_limits_and_trace_and_conversion_scope(context,policy,seed,limits,input.root_work,conversion_scope),
            None=>Engine::with_conversion_scope_and_trace(context,policy,seed,conversion_scope,input.root_work),
        };
        let stopped=||start.elapsed().as_millis()>=u128::from(input.max_millis);
        let mut interrupted=false;
        while engine.stats.selection_attempts<input.selections&&!engine.complete() {
            if !engine.step(&stopped)? {interrupted=true;break;}
        }
        let (status,reason)=if !engine.root_complete() {("incomplete","root-incomplete")}
            else if engine.root_count()==0 {("root-no-move","no-legal-placement")}
            else if engine.complete() {("move","finite-tree-complete")}
            else if !interrupted&&engine.stats.selection_attempts>=input.selections {("move","selection-budget")}
            else if input.mode=="time" {("move","deadline-budget")}
            else {("incomplete","deadline")};
        let mut output=json!({"diagnostic":DIAGNOSTIC_ID,"status":status,"reason":reason,"releaseEvidence":false,"strengthQualified":false,
            "selectedMove":if status=="move" {engine.selected()?}else{Json::Null},
            "search":engine.stats,"diagnostics":engine.diagnostics_bounded_with_options(32,input.diagnostics,input.root_work)?});
        if input.conversion_scope.is_some() {output["conversionScope"]=json!(conversion_scope.as_str());}
        if let Some(ref limits)=input.limits {
            output["limits"]=serde_json::to_value(limits).map_err(|_|Error::InvalidInput)?;
        }
        if input.limits.is_some()||input.conversion_scope.is_some() {
            output["search"]["requestedSelections"]=json!(input.selections);
            output["search"]["rootExpansionComplete"]=json!(engine.root_complete());
            output["search"]["treeComplete"]=json!(engine.complete());
            output["search"]["capacityReached"]=json!(engine.capacity_reached());
            output["search"]["rootLegal"]=json!(engine.root_count());
            output["search"]["termination"]=json!(reason);
        }
        Ok(output)
    })();
    result.map_err(|e|format!("{e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_s2::{Chain,Incoming};
    fn engine_with_trace(trace_root_work:bool)->Engine {
        let root=native_s2::State {board:Default::default(),materialized_g:Default::default(),
            current:Some(Piece::T),hold:Some(Piece::I),hold_available:true,known_next:vec![Piece::O,Piece::J,Piece::T],
            chain:Chain {combo:0,b2b:0},incoming:Incoming {pending_rows:0,due_this_lock_rows:0},horizon:native_s2::Horizon::Open};
        let amounts=crate::s2_core::modelled_amounts(root.chain,root.incoming,1.).unwrap();
        let context=Context::new(root,1.,2,amounts).unwrap();
        let policy=Policy::new(&s2_eval::prototype()).unwrap();
        Engine::with_limits_and_trace(context,policy,42,Limits::default(),trace_root_work)
    }
    fn engine()->Engine {
        engine_with_trace(false)
    }
    #[test]
    fn conversion_scope_is_root_only_after_depth_zero() {
        assert_eq!(ConversionScope::parse(None).unwrap(),ConversionScope::AllEdges);
        assert_eq!(ConversionScope::parse(Some("all-edges")).unwrap(),ConversionScope::AllEdges);
        assert_eq!(ConversionScope::parse(Some("root-only")).unwrap(),ConversionScope::RootOnly);
        assert!(ConversionScope::parse(Some("deep-only")).is_err());
        assert!(ConversionScope::RootOnly.includes_at(0));
        assert!(!ConversionScope::RootOnly.includes_at(1));
        assert!(ConversionScope::AllEdges.includes_at(14));
    }
    #[test]
    fn root_only_preserves_root_reward_but_removes_deep_conversion_from_backup() {
        let mut board=crate::data::Board::default();
        for x in 0..10 { if !(4..=5).contains(&x) { board.cols[x]=(1<<4)-1; } }
        let fixture=|| native_s2::State {board,materialized_g:Default::default(),current:Some(Piece::O),hold:Some(Piece::T),
            hold_available:true,known_next:vec![Piece::O,Piece::O,Piece::O,Piece::O],
            chain:Chain {combo:1,b2b:0},incoming:Incoming {pending_rows:0,due_this_lock_rows:0},horizon:native_s2::Horizon::Open};
        let policy_input=s2_eval::prototype();
        let limits=Limits::default();
        let make=|scope| { let root=fixture(); let amounts=crate::s2_core::modelled_amounts(root.chain,root.incoming,1.).unwrap();
            Engine::with_limits_and_trace_and_conversion_scope(
            Context::new(root,1.,2,amounts).unwrap(),
            Policy::new(&policy_input).unwrap(),42,limits.clone(),true,scope)
        };
        let mut all=make(ConversionScope::AllEdges);
        let mut root_only=make(ConversionScope::RootOnly);
        for _ in 0..256 { if all.complete() && root_only.complete() { break; } let _=all.step(&||false).unwrap(); let _=root_only.step(&||false).unwrap(); }
        assert!(all.root_complete() && root_only.root_complete());
        let all_trace=all.root_work.as_ref().unwrap();
        let deep_conversion=all_trace.node_rewards.iter().filter(|((depth,_),reward)| *depth>=1 && reward.components[2].feature_total!=0.).count();
        assert!(deep_conversion>0,"fixture must exercise a deep conversion edge");
        assert!(all_trace.root_rewards.iter().any(|(_,reward)| reward.components[2].feature_total!=0.));
        let all_roots=all.snapshot.as_ref().unwrap();let root_roots=root_only.snapshot.as_ref().unwrap();
        assert_eq!(all_roots.roots.len(),root_roots.roots.len());
        let root_only_by_key=root_roots.roots.iter().map(|score| (root_only.root_info[score.index].action.key(),score)).collect::<std::collections::BTreeMap<_,_>>();
        let mut changed=false;
        for left in &all_roots.roots {
            let key=all.root_info[left.index].action.key();let right=root_only_by_key[&key];
            assert_eq!(left.reward,right.reward,"root reward must remain scoped at depth zero");
            if left.q!=right.q || left.continuation!=right.continuation {changed=true;}
        }
        assert!(changed,"deep conversion contribution must reach continuation/root Q");
    }
    #[test]
    fn only_complete_batches_update_snapshot_and_detail_never_reselects() {
        for stop_at in [1,2,3,5,10] {
            let mut engine=engine();let count=std::cell::Cell::new(0);
            assert!(!engine.step(&||{count.set(count.get()+1);count.get()>=stop_at}).unwrap());
            assert!(!engine.root_complete());assert_eq!(engine.selected().unwrap(),Json::Null);
            assert_eq!(engine.stats.committed_expansions,0);
            assert!(engine.committed_layer_edges.iter().all(|n|*n==0));
            assert!(engine.step(&||false).unwrap());
            let old=engine.selected().unwrap();let summary=engine.diagnostics(false).unwrap();
            let layer_edges=engine.committed_layer_edges.clone();
            assert_eq!(engine.diagnostics(true).unwrap()["rootCandidates"][0],old);
            let count=std::cell::Cell::new(0);
            assert!(!engine.step(&||{count.set(count.get()+1);count.get()>=5}).unwrap());
            assert_eq!(engine.selected().unwrap(),old);
            assert_eq!(engine.diagnostics(false).unwrap(),summary);
            assert_eq!(engine.committed_layer_edges,layer_edges);
        }
    }
    #[test]
    fn shared_cc2_search_finishes_finite_tree_and_preserves_f64_q_identity() {
        let mut engine=engine();let mut steps=0;
        while !engine.complete()&&steps<1000 {assert!(engine.step(&||false).unwrap());steps+=1;}
        assert!(engine.complete());assert!(steps>1&&steps<1000);
        let selected=engine.selected().unwrap();assert!(!selected.is_null());
        assert_eq!(selected["q"]["value"].as_f64().unwrap(),selected["continuationValue"]["value"].as_f64().unwrap()+selected["reward"].as_f64().unwrap());
        assert_eq!(engine.stats.committed_expansions,steps);
        assert!(engine.stats.nodes>engine.root_count());
        assert!(engine.stats.depth_limit_edges>0);
        assert!(engine.stats.index_allocation_estimate_bytes>=engine.stats.nodes*std::mem::size_of::<crate::s2_core::State>());
        assert!(engine.stats.arena_allocated_bytes+engine.stats.node_storage_estimate_bytes<=engine.stats.memory_charge_bytes);
    }
    #[test]
    fn tanked_integrated_children_remain_expandable_with_scalar_pressure() {
        let root=native_s2::State {board:Default::default(),materialized_g:Default::default(),
            current:Some(Piece::T),hold:Some(Piece::I),hold_available:true,known_next:vec![Piece::O,Piece::J],
            chain:Chain {combo:0,b2b:0},incoming:Incoming {pending_rows:5,due_this_lock_rows:5},horizon:native_s2::Horizon::Open};
        let amounts=crate::s2_core::modelled_amounts(root.chain,root.incoming,1.).unwrap();
        let context=Context::new(root,1.,3,amounts).unwrap();
        let policy=Policy::new(&s2_eval::prototype()).unwrap();
        let mut engine=Engine::new(context,policy,42);
        assert!(engine.step(&||false).unwrap());
        assert!(engine.stats.unknown_tank_edges>0);
        assert!(engine.step(&||false).unwrap(),"a tanked child must remain open");
        assert_eq!(engine.stats.committed_expansions,2);
    }
    #[test]
    fn capacity_discards_root_and_deep_batches_without_replacing_complete_snapshot() {
        for field in 0..4 {
            let mut e=engine();let mut limits=Limits::default();
            match field {0=>limits.max_nodes=1,1=>limits.max_edges=1,2=>limits.max_batch_actions=1,_=>limits.max_memory_bytes=1}
            e.limits=Some(limits);
            assert!(!e.step(&||false).unwrap());assert!(e.capacity_reached());assert!(!e.root_complete());
            assert_eq!(e.stats.committed_edges,0);assert_eq!(e.stats.committed_expansions,0);
            assert!(e.committed_layer_edges.iter().all(|n|*n==0));
            assert!(e.stats.index_capacity>0&&e.stats.index_allocation_estimate_bytes>0&&e.stats.node_storage_estimate_bytes>0);
            assert_eq!(e.stats.initialized_layers,if field<2 {2}else{1});
        }
        let mut oracle=engine();assert!(oracle.step(&||false).unwrap());
        let mut e=engine();e.limits=Some(Limits {max_edges:oracle.root_count(),..Limits::default()});
        assert!(e.step(&||false).unwrap());let snapshot=e.selected().unwrap();let charge=e.stats.memory_charge_bytes;
        let layer_edges=e.committed_layer_edges.clone();
        assert!(!e.step(&||false).unwrap());assert!(e.capacity_reached());
        assert_eq!(e.selected().unwrap(),snapshot);assert_eq!(e.stats.committed_expansions,1);
        assert_eq!(e.stats.memory_charge_bytes,charge);assert!(e.stats.evaluated_edges>e.stats.committed_edges);
        assert_eq!(e.committed_layer_edges,layer_edges);
        assert!(!e.step(&||false).unwrap());
    }
    #[test]
    fn sufficient_capacity_preserves_search_and_accounts_actual_storage() {
        let mut a=engine();let mut b=engine();b.limits=Some(Limits::default());
        for _ in 0..32 {
            assert_eq!(a.step(&||false).unwrap(),b.step(&||false).unwrap());
            assert_eq!(a.selected().unwrap(),b.selected().unwrap());
            assert_eq!(a.diagnostics(true).unwrap(),b.diagnostics(true).unwrap());
            assert_eq!(b.committed_layer_edges.iter().sum::<usize>() as u64,b.stats.committed_edges);
        }
        assert!(!b.capacity_reached());
        assert!(b.stats.peak_memory_charge_bytes>=b.stats.memory_charge_bytes);
        assert!(b.stats.memory_charge_bytes>=b.stats.arena_allocated_bytes+b.stats.node_storage_estimate_bytes);
    }
    #[test]
    fn root_work_trace_preserves_fixed_work_and_assigns_shared_nodes_once() {
        let mut off=engine_with_trace(false);let mut on=engine_with_trace(true);
        for _ in 0..32 {
            assert_eq!(off.step(&||false).unwrap(),on.step(&||false).unwrap());
            assert_eq!(off.stats,on.stats);
            assert_eq!(off.selected().unwrap(),on.selected().unwrap());
            assert_eq!(off.diagnostics(true).unwrap(),on.diagnostics(true).unwrap());
        }
        let diagnostic=on.diagnostics_bounded_with_options(32,true,true).unwrap();
        let trace=&diagnostic["rootWork"];
        assert_eq!(trace["selectionOpportunities"].as_u64().unwrap(),on.stats.committed_expansions.saturating_sub(1));
        assert_eq!(trace["uniqueNonRootExpandedNodes"],trace["ownedNodeExpansionsTotal"]);
        assert_eq!(trace["ownedNodeExpansionsTotal"].as_u64().unwrap(),
            trace["rootCandidates"].as_array().unwrap().iter().map(|root|root["ownedNodeExpansions"].as_u64().unwrap()).sum::<u64>()
                +trace["unreportedOwnedNodeExpansions"].as_u64().unwrap());
        assert_eq!(trace["rewardBreakdown"]["evaluatedEdges"].as_u64().unwrap(),on.stats.evaluated_edges);
    }
    #[test]
    fn normal_clear_action_reward_trace_separates_root_and_deep_work() {
        let mut board=crate::data::Board::default();
        for x in 0..10 { if !(4..=5).contains(&x) { board.cols[x]=(1<<6)-1; } }
        let root=native_s2::State {board,materialized_g:Default::default(),current:Some(Piece::O),hold:Some(Piece::T),
            hold_available:true,known_next:vec![Piece::O,Piece::O,Piece::O,Piece::O],chain:Chain {combo:1,b2b:0},
            incoming:Incoming {pending_rows:0,due_this_lock_rows:0},horizon:native_s2::Horizon::Open};
        let amounts=crate::s2_core::modelled_amounts(root.chain,root.incoming,1.).unwrap();
        let mut input=s2_eval::prototype();
        input.action_reward=Some(s2_eval::ActionRewardInput {schema:"s2-cc2-action-reward/1".into(),group:"normal-clear-v1".into(),
            table:vec!["0.0".into(),"0.8".into(),"1.6".into(),"2.3".into(),"2.8".into()],scale:"1.0".into(),number_format:"f32-then-f64".into()});
        let seed=0;
        let mut engine=Engine::with_limits_and_trace(Context::new(root.clone(),1.,2,amounts.clone()).unwrap(),Policy::new(&input).unwrap(),seed,Limits::default(),true);
        let mut disabled=Engine::with_limits_and_trace(Context::new(root,1.,2,amounts).unwrap(),Policy::new(&s2_eval::prototype()).unwrap(),seed,Limits::default(),true);
        for _ in 0..256 { let _=engine.step(&||false).unwrap(); let _=disabled.step(&||false).unwrap(); }
        let diagnostic=engine.diagnostics_bounded_with_options(engine.root_count(),true,true).unwrap();
        let disabled_diagnostic=disabled.diagnostics_bounded_with_options(disabled.root_count(),true,true).unwrap();
        let trace=diagnostic["rootWork"].clone();
        let disabled_trace=disabled_diagnostic["rootWork"].clone();
        let depths=trace["normalClearByDepth"].as_array().unwrap();
        let root_metric=&depths[0];
        let deep_occurrences=depths.iter().skip(1).map(|metric|metric["occurrences"].as_u64().unwrap()).sum::<u64>();
        assert!(root_metric["occurrences"].as_u64().unwrap()>0,"root must contain a non-PC normal clear");
        assert!(deep_occurrences>0,"deep work must contain a non-PC normal clear");
        let total_line_counts=depths.iter().map(|metric|metric["lineCounts"].as_array().unwrap().iter().map(|count|count.as_u64().unwrap()).sum::<u64>()).sum::<u64>();
        assert_eq!(trace["rewardBreakdown"]["actionReward"]["occurrences"].as_u64().unwrap(),total_line_counts);
        assert_eq!(disabled_trace["rewardBreakdown"]["actionReward"]["occurrences"].as_u64().unwrap(),0);
        let rewarded=diagnostic["rootCandidates"].as_array().unwrap().iter().find(|candidate|candidate.get("actionReward").is_some()).expect("candidate reward must be exposed");
        let matching_disabled=disabled_diagnostic["rootCandidates"].as_array().unwrap().iter().find(|candidate|candidate["actionKey"]==rewarded["actionKey"]).expect("disabled candidate must share action key");
        assert!(rewarded["actionReward"]["contribution"].as_f64().unwrap()>0.);
        assert_eq!(rewarded["continuationValue"],matching_disabled["continuationValue"],"root action reward must remain outside continuation");
        assert_ne!(rewarded["q"],matching_disabled["q"],"root Q must include root action reward");
        assert_eq!(trace["rewardBreakdown"]["actionReward"]["occurrences"].as_u64().unwrap(),root_metric["occurrences"].as_u64().unwrap()+deep_occurrences);
        assert_eq!(depths.len(),3,"depth trace must cover root and the configured deep horizon");
    }
    #[test]
    fn layer_accounting_preserves_unlimited_search_under_fixed_limits() {
        let input=|| {
            let root=native_s2::State {board:Default::default(),materialized_g:Default::default(),
                current:Some(Piece::T),hold:Some(Piece::I),hold_available:true,
                known_next:vec![Piece::O,Piece::J,Piece::T,Piece::L,Piece::S,Piece::Z,Piece::I,
                    Piece::O,Piece::L,Piece::S,Piece::T,Piece::Z,Piece::J],
                chain:Chain {combo:0,b2b:0},incoming:Incoming {pending_rows:0,due_this_lock_rows:0},horizon:native_s2::Horizon::Open};
            let amounts=crate::s2_core::modelled_amounts(root.chain,root.incoming,1.).unwrap();
            let context=Context::new(root,1.,14,amounts).unwrap();
            let policy=Policy::new(&s2_eval::prototype()).unwrap();
            (context,policy)
        };
        let (context,policy)=input();let mut a=Engine::new(context,policy,5994928009864282113);
        let (context,policy)=input();let mut b=Engine::with_limits(context,policy,5994928009864282113,Limits::default());
        for _ in 0..512 {
            assert!(a.step(&||false).unwrap());assert!(b.step(&||false).unwrap());
            assert_eq!(a.diagnostics(true).unwrap(),b.diagnostics(true).unwrap());
            assert_eq!(a.stats,b.stats);
            assert_eq!(b.committed_layer_edges.iter().sum::<usize>() as u64,b.stats.committed_edges);
            assert!(b.stats.peak_memory_charge_bytes<=Limits::default().max_memory_bytes);
            assert!(b.stats.memory_charge_bytes>=b.stats.arena_allocated_bytes+b.stats.node_storage_estimate_bytes);
        }
        assert!(!b.capacity_reached());assert_eq!(b.stats.committed_expansions,512);
    }
}
