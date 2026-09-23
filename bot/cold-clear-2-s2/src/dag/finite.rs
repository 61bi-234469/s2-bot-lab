//! Known-only ADR-063 DAG. Legacy speculative layers cannot represent this state.
//! Shares rank exploration, but closes finite frontiers instead of retrying them.
use std::collections::BTreeSet;
use ahash::AHashMap as HashMap;
use std::rc::Rc;
use rand::{Rng, SeedableRng};
use serde_json::{json, Value as Json};
use crate::bot::Statistics;
use crate::data::{Piece, Rotation};
use crate::movegen::NativeS2Move;
use crate::native_s2::{Error, Horizon, RootAmounts, State, Value};
mod formation;
mod value;

type Result<T> = std::result::Result<T, Error>;
type TieKey = (bool,u8,u8,i8,i8,bool,Option<usize>,Option<(i8,i8)>,Option<(u8,i8,i8)>);
#[derive(Clone)]
struct Edge { child: usize, key:TieKey, witness:Option<Box<NativeS2Move>>, reward: f64, outgoing:u32, cached:Value }

// Presentation/final decision only. Never reorder the search's edges or consume RNG.
fn final_root_index(edges:&[Edge],prefer_outgoing:bool)->Option<usize> {
    let first=edges.first()?;
    let mut best=0;
    if prefer_outgoing && first.cached!=Value::LOSS {
        for (i,edge) in edges.iter().enumerate().take_while(|(_,e)|e.cached==first.cached) {
            // Strict comparison preserves the existing TieKey order on equal outgoing.
            if edge.outgoing>edges[best].outgoing {best=i;}
        }
    }
    Some(best)
}
struct Node {
    state: Rc<State>, eval: Value, value: Value, children: Option<Vec<Edge>>,
    parents: Vec<usize>, closed: bool, depth: usize,
    formation: formation::Credit,
}
pub(crate) struct Search {
    nodes: Vec<Node>, index: HashMap<Rc<State>, usize>, rng: rand::rngs::StdRng,
    pub stats: Statistics, pub lookups: u64, pub hits: u64, transition_reuses:u64, multiplier: f64,
    pub phase_micros:[u128;4],
    amounts: Vec<RootAmounts>,
    #[cfg(test)] cache_transitions:bool,
}
#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase")]
struct Policy { holes:f64,coveredness:f64,row_transitions:f64,height:f64,height_above10:f64,
    height_above15:f64,b2b_resource:f64,outgoing:f64,cancelled:f64,wasted_t:f64,softdrop:f64,exploration:f64,
    #[serde(default)] pressure_height_recovery:bool,
    #[serde(default)] root_first_expansion:bool,
    #[serde(default)] root_attack_tiebreak:bool,
    #[serde(default)] tsd_formation:bool,
    #[serde(default)] tslot_preview:bool,
    #[serde(default)] tslot_bonus_distance_alpha:Option<f64>,
    #[serde(default)] tsd_formation_bonus:f64,
    #[serde(default)] tsd_structure_relief_scale:f64 }
static POLICY: once_cell::sync::Lazy<Policy> = once_cell::sync::Lazy::new(|| serde_json::from_str(crate::native_s2::transport::CONFIG).expect("embedded policy"));
fn height_value(h: f64) -> f64 { let p=&*POLICY;p.height*h+p.height_above10*(h-10.0).max(0.0)+p.height_above15*(h-15.0).max(0.0) }
// Credit only visible, anchored top-four-row I wells. No future hole or board is generated.
// Capping at the charged tank burden prevents receiving garbage from improving static value.
fn pressure_height_credit(state:&State)->f64 {
    let tank=match state.horizon {Horizon::UnknownTank{rows} if rows>0=>rows as u64,_=>return 0.0};
    if state.current.is_none() || !(state.current==Some(Piece::I)
        || (state.hold_available && state.hold==Some(Piece::I))) {return 0.0;}
    let heights=state.board.cols.map(|c|64-c.leading_zeros());
    let h=*heights.iter().max().unwrap();
    if h<5 || h as u64+tank>16 {return 0.0;}
    let top_four=15_u64<<(h-4);
    if !(0..10).any(|x|heights[x]==h-4
        &&(0..10).all(|other|other==x || state.board.cols[other]&top_four==top_four)) {return 0.0;}
    let after=h as f64+tank as f64;
    (height_value(after-4.0)-height_value(after)).min(height_value(h as f64)-height_value(after))
}
fn board_features(board:&crate::data::Board)->(u32,u32,u32,f64) {
    let heights=board.cols.map(|c|64-c.leading_zeros());
    let mut holes=0;let mut covered=0;
    for (x,&height) in heights.iter().enumerate() {
        let mut mask=((1_u64<<height)-1)&!board.cols[x];holes+=mask.count_ones();
        while mask!=0 {let y=mask.trailing_zeros();covered+=(height-y).min(10);mask&=mask-1;}
    }
    const MASK:u64=(1_u64<<40)-1;
    let mut transitions=(!board.cols[0]&MASK).count_ones()+(!board.cols[9]&MASK).count_ones();
    for x in 1..10 {transitions+=(board.cols[x-1]^board.cols[x]).count_ones();}
    let height=*heights.iter().max().unwrap() as f64;
    (holes,covered,transitions,height)
}
#[cfg(test)]
pub(crate) fn evaluate(state: &State) -> Result<Value> { Ok(evaluate_with_credit(state)?.0) }
fn evaluate_with_credit(state:&State)->Result<(Value,formation::Credit)> {
    let p=&*POLICY;
    let base=value::LeafTerms::new(state).total();
    let credit=if p.tslot_preview {formation::preview(state)} else if p.tsd_formation {formation::credit(state)?} else {formation::Credit::default()};
    let remaining=credit.distance_discount.as_ref().map_or_else(||credit.total(),|d|d.applied_bonus+credit.structure_relief);
    let value=if p.tsd_formation {Value::finite(base+remaining)?} else {Value::finite(base)?};
    Ok((value,credit))
}
fn piece_order(p: Piece)->u8 { match p {Piece::I=>0,Piece::J=>1,Piece::L=>2,Piece::O=>3,Piece::S=>4,Piece::T=>5,Piece::Z=>6} }
fn rotation_order(r: Rotation)->u8 { match r {Rotation::North=>0,Rotation::East=>1,Rotation::South=>2,Rotation::West=>3} }
fn tie(hold:bool,m:&NativeS2Move) -> TieKey {
    (hold,piece_order(m.location.piece),rotation_order(m.location.rotation),m.location.x,m.location.y,
     m.rotation_from.is_some(),m.native_kick_index,m.native_kick_offset,
     m.rotation_from.map(|p|(rotation_order(p.rotation),p.x,p.y)))
}
impl Search {
    pub fn new(state: State, multiplier: f64, amounts: Vec<RootAmounts>, seed:u64)->Result<Self> {
        let (eval,formation)=evaluate_with_credit(&state)?; let state=Rc::new(state); let mut index=HashMap::default(); index.insert(state.clone(),0);
        Ok(Self { nodes:vec![Node {state,eval,formation,value:eval,children:None,parents:vec![],closed:false,depth:0}],
            index,rng:rand::rngs::StdRng::seed_from_u64(seed),stats:Statistics::default(),lookups:0,hits:0,transition_reuses:0,multiplier,amounts,phase_micros:[0;4], #[cfg(test)] cache_transitions:true })
    }
    fn cache_enabled(&self)->bool { #[cfg(test)] {self.cache_transitions} #[cfg(not(test))] {true} }
    pub fn reserve_budget(&mut self,selections:u64) {
        let capacity=selections.saturating_mul(64).min(32768) as usize;
        self.nodes.reserve(capacity);self.index.reserve(capacity);
    }
    pub fn closed(&self)->bool { self.nodes[0].closed }
    pub fn root_complete(&self)->bool { self.nodes[0].children.is_some() }
    pub fn root_count(&self)->usize { self.nodes[0].children.as_ref().map_or(0,Vec::len) }
    // One successful selection expands exactly one open node. No failed-selection spinning.
    pub fn step(&mut self, stopped: &impl Fn()->bool)->Result<bool> {
        if self.closed() || stopped() {return Ok(false)}
        let phase=std::time::Instant::now();
        let mut id=0;
        while let Some(children)=&self.nodes[id].children {
            // Give each unexpanded open root state one opportunity before rank sampling.
            // Existing edge order is dynamic Q/tie order; witnesses remain intact.
            if id==0 && POLICY.root_first_expansion {
                if let Some(edge)=children.iter().find(|e|!self.nodes[e.child].closed
                    && self.nodes[e.child].children.is_none()) {
                    id=edge.child;
                    break;
                }
            }
            // Rank distinct states by their best edge; retain every witness for propagation.
            let mut seen=BTreeSet::new();
            let open:Vec<_>=children.iter()
                .filter(|c|!self.nodes[c.child].closed && seen.insert(c.child)).collect();
            if open.is_empty() {return Err(Error::InvalidInput)}
            let sample:f64=self.rng.gen(); id=open[super::rank_index(sample,POLICY.exploration,open.len())].child;
        }
        let state=self.nodes[id].state.clone(); let depth=self.nodes[id].depth+1;
        self.phase_micros[0]+=phase.elapsed().as_micros();
        let phase=std::time::Instant::now();
        let moves=state.root_moves()?;
        self.phase_micros[1]+=phase.elapsed().as_micros();
        let phase=std::time::Instant::now(); let mut edges=Vec::with_capacity(moves.len());
        let committed_nodes=self.nodes.len();
        let committed_counters=(self.lookups,self.hits,self.transition_reuses);
        // Witnesses with identical locked cells/spin share the transition, never the edge reward.
        let mut transitions=HashMap::with_capacity_and_hasher(moves.len()/4+16,ahash::RandomState::default());
        for (ordinal,(hold,mv)) in moves.into_iter().enumerate() {
            // Bounded cooperative cancellation; at most 16 constant-size lock transitions per poll.
            if ordinal%16==0 && stopped() {
                // Provisional nodes belong only to this uncommitted expansion.
                // Parent links are installed below, after every edge is ready.
                for node in self.nodes.drain(committed_nodes..) {self.index.remove(&node.state);}
                (self.lookups,self.hits,self.transition_reuses)=committed_counters;
                return Ok(false)
            }
            let key=(hold,mv.location.canonical_form(),mv.spin);
            if let Some(&(child,base_reward,outgoing))=transitions.get(&key).filter(|_|self.cache_enabled()) {
                self.lookups+=1;self.hits+=1;self.transition_reuses+=1;
                let reward=base_reward+POLICY.softdrop*mv.soft_drops as f64;
                edges.push(Edge{child,key:tie(hold,&mv),witness:if id==0 {Some(Box::new(mv))}else{None},reward,outgoing,cached:self.nodes[child].value.add_reward(reward)?});
                continue;
            }
            let (next,clear,attack)=if id==0 {state.lock(&mv,hold,self.multiplier,&self.amounts)?}
                else {state.lock_future(&mv,hold,self.multiplier)?};
            let tank=match next.horizon {Horizon::UnknownTank{rows}=>rows,_=>0};
            let cancelled=state.incoming.pending_rows-next.incoming.pending_rows-tank;
            let outgoing=if id==0 {self.amounts.iter().find(|a|a.signature==clear).ok_or(Error::OracleMismatch)?.outgoing_after_cancel}
                else {attack.outgoing_before_cancel-cancelled};
            let wasted_t=mv.location.piece==Piece::T && (clear.lines<2 || clear.spin!=crate::native_s2::CanonicalSpin::Normal);
            let terms=value::RewardTerms::new(outgoing,cancelled,wasted_t,mv.soft_drops);
            let base_reward=terms.base();
            let reward=base_reward+terms.softdrop;
            Value::finite(reward)?;
            self.lookups+=1;
            let child=if let Some(&existing)=self.index.get(&next) { self.hits+=1; existing } else {
                let (eval,formation)=evaluate_with_credit(&next)?; let closed=next.horizon!=Horizon::Open;
                let child=self.nodes.len(); let next=Rc::new(next); self.index.insert(next.clone(),child);
                self.nodes.push(Node{state:next,eval,formation,value:eval,children:None,parents:vec![],closed,depth}); child
            };
            transitions.insert(key,(child,base_reward,outgoing));
            edges.push(Edge{child,key:tie(hold,&mv),witness:if id==0 {Some(Box::new(mv))}else{None},reward,outgoing,cached:self.nodes[child].value.add_reward(reward)?});
        }
        self.phase_micros[2]+=phase.elapsed().as_micros();
        for edge in &edges {
            if !self.nodes[edge.child].parents.contains(&id) {self.nodes[edge.child].parents.push(id)}
        }
        self.nodes[id].children=Some(edges);
        self.stats.selections+=1; self.stats.expansions+=1; self.stats.nodes=self.nodes.len() as u64;
        let phase=std::time::Instant::now();self.propagate(id)?;
        self.phase_micros[3]+=phase.elapsed().as_micros();Ok(true)
    }
    fn propagate(&mut self,start:usize)->Result<()> {
        // Every active edge consumes known NEXT; process shorter queues first so a shared
        // ancestor is reduced only after all changed descendants, as in layered DAG backprop.
        let mut queue=BTreeSet::from([(self.nodes[start].state.known_next.len(),start)]);
        while let Some((_,id))=queue.pop_first() {
            let mut edges=self.nodes[id].children.take().ok_or(Error::InvalidInput)?;
            for e in &mut edges {e.cached=self.nodes[e.child].value.add_reward(e.reward)?;}
            edges.sort_unstable_by(|a,b|b.cached.cmp(&a.cached).then_with(||a.key.cmp(&b.key)));
            let value=edges.first().map_or(Value::LOSS,|e|e.cached);
            let closed=edges.iter().all(|e|self.nodes[e.child].closed);
            let changed=value!=self.nodes[id].value || closed!=self.nodes[id].closed;
            self.nodes[id].value=value;self.nodes[id].closed=closed;
            self.nodes[id].children=Some(edges);
            if changed {for &parent in &self.nodes[id].parents {queue.insert((self.nodes[parent].state.known_next.len(),parent));}}
        }
        Ok(())
    }
    fn candidate(&self,e:&Edge)->Result<Json> {
        let mut result=json!({"holdUsed":e.key.0,"witness":e.witness,"postStateEval":self.nodes[e.child].eval.diagnostic(),
            "reward":e.reward,"continuationValue":self.nodes[e.child].value.diagnostic(),
            "q":self.nodes[e.child].value.add_reward(e.reward)?.diagnostic()});
        if POLICY.tsd_formation {result["formation"]=serde_json::to_value(&self.nodes[e.child].formation).map_err(|_|Error::InvalidInput)?;}
        Ok(result)
    }
    pub fn selected(&self)->Result<Json> {
        let edges=self.nodes[0].children.as_deref().unwrap_or(&[]);
        final_root_index(edges,POLICY.root_attack_tiebreak).map_or(Ok(Json::Null),|i|self.candidate(&edges[i]))
    }
    pub fn diagnostics(&self,detailed:bool)->Result<Json> {
        let candidates=self.nodes[0].children.as_ref().map_or(&[][..],|c|&c[..]);
        let selected=final_root_index(candidates,POLICY.root_attack_tiebreak);
        let saved:Vec<_>=selected.into_iter().chain((0..candidates.len()).filter(|i|Some(*i)!=selected))
            .take(if detailed {32}else{1}).map(|i|self.candidate(&candidates[i])).collect::<Result<_>>()?;
        let mut depths:Vec<_>=self.nodes.iter().filter(|n|n.children.is_none()).map(|n|n.depth).collect(); depths.sort_unstable();
        let mut result=json!({"rootCandidates":saved,"rootCandidateCount":candidates.len(),"savedCandidateCount":saved.len(),
            "transitionCacheHits":self.transition_reuses,"physicalStateMapLookups":self.lookups-self.transition_reuses,"transpositionLookups":self.lookups,"transpositionHits":self.hits,"transpositionInserts":self.nodes.len()-1,
            "leafDepthMin":depths.first(),"leafDepthMedian":depths.get(depths.len()/2),"leafDepthMax":depths.last(),
            "expansionDepth":self.nodes.iter().filter(|n|n.children.is_some()).map(|n|n.depth).max(),
            "tankLeaves":self.nodes.iter().filter(|n|matches!(n.state.horizon,Horizon::UnknownTank{..})).count(),
            "nextLeaves":self.nodes.iter().filter(|n|n.state.horizon==Horizon::KnownNextExhausted).count()});
        if POLICY.tsd_formation {result["formation"]=json!({"evaluatedStates":self.nodes.len(),
            "qualifiedStates":self.nodes.iter().filter(|n|n.formation.qualified).count(),
            "movegenCalls":self.nodes.iter().map(|n|n.formation.movegen_calls as u64).sum::<u64>()});}
        if detailed {result["rootIndex"]=self.root_index()?;result["rootValue"]=self.root_value();}
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_s2::{Chain, Incoming, Clear, CanonicalSpin, attack};
    pub(super) fn state()->State {
        State {board:Default::default(),materialized_g:Default::default(),current:Some(Piece::O),hold:None,
            hold_available:false,known_next:vec![],chain:Chain{combo:0,b2b:0},incoming:Incoming{pending_rows:0,due_this_lock_rows:0},horizon:Horizon::Open}
    }
    pub(super) fn amounts(s:&State)->Vec<RootAmounts> {
        let mut rows=vec![];
        for lines in 0..=4 {for spin in [CanonicalSpin::None,CanonicalSpin::Mini,CanonicalSpin::Normal] {
            for pc in [false,true] {for g in [false,true] {
                if lines==0&&(pc||g){continue}
                let signature=Clear{lines,spin,perfect_clear:pc,cleared_any_g:g};
                if let Ok((_,a))=attack(s.chain,signature,1.0) {
                    rows.push(RootAmounts{signature,outgoing_before_cancel:a.outgoing_before_cancel,cancelled_rows:0,
                        outgoing_after_cancel:a.outgoing_before_cancel,remaining_rows:0,tank_rows:0,due_rows_after_lock:0});
                }
            }}
        }}rows
    }
    #[test]
    fn duplicate_witnesses_preserve_child_sampling_and_rng() {
        let mut visited=BTreeSet::new();
        for seed in 0..32 {
            let run=|duplicates:usize| {
                let s=state();let mut search=Search::new(s.clone(),1.0,amounts(&s),seed).unwrap();
                search.step(&||false).unwrap();
                let template=search.nodes[0].children.as_ref().unwrap()[0].clone();
                // Equal state values but distinct IDs must remain separate sampling choices.
                let mut ids=Vec::new();
                for closed in [false,false,true] {
                    ids.push(search.nodes.len());
                    search.nodes.push(Node{state:Rc::new(s.clone()),formation:formation::Credit::default(),eval:Value::finite(0.0).unwrap(),
                        value:Value::finite(0.0).unwrap(),children:None,parents:vec![],closed,depth:1});
                }
                let edge=|child,reward| {let mut e=template.clone();e.child=child;e.reward=reward;e};
                let mut edges=vec![edge(ids[2],100.0),edge(ids[0],10.0),edge(ids[1],5.0),edge(ids[0],-10.0)];
                edges.extend((0..duplicates).map(|_|edge(ids[0],10.0)));
                search.nodes[0].children=Some(edges);search.propagate(0).unwrap();
                assert_eq!(search.root_count(),4+duplicates);
                assert_eq!(search.nodes[0].children.as_ref().unwrap()[1].child,ids[0]);
                assert!(search.nodes[0].children.as_ref().unwrap().iter().any(|e|e.child==ids[0]&&e.reward== -10.0));
                assert_eq!(search.selected().unwrap()["reward"],json!(100.0));
                assert!(search.step(&||false).unwrap());
                assert!(search.nodes[ids[2]].children.is_none(),"closed child expanded");
                let expanded:Vec<_>=ids[..2].iter().enumerate().filter(|(_,id)|search.nodes[**id].children.is_some()).map(|(rank,_)|rank).collect();
                assert_eq!(expanded.len(),1);
                assert_eq!(search.root_count(),4+duplicates);
                (expanded[0],search.rng.gen::<u64>())
            };
            let baseline=run(0);assert_eq!(baseline,run(8));visited.insert(baseline.0);
        }
        assert_eq!(visited,if POLICY.root_first_expansion {BTreeSet::from([0])}
            else {BTreeSet::from([0,1])},"exercise the configured root selection rule");
    }
    #[test]
    fn finite_next_horizon_closes_without_budget_spin_and_preserves_finite_values() {
        let s=state();let mut search=Search::new(s.clone(),1.0,amounts(&s),0).unwrap();
        assert!(search.step(&||false).unwrap());assert!(search.closed());assert!(search.root_count()>0);
        assert!(!search.step(&||false).unwrap());assert_eq!(search.stats.selections,1);
        assert_ne!(search.nodes[0].value,Value::LOSS);
    }
    #[test]
    fn root_first_expansion_matches_build_identity() {
        assert_eq!(POLICY.root_first_expansion,cfg!(feature="native-root-first-expansion"));
        assert_eq!(POLICY.root_attack_tiebreak,cfg!(feature="native-root-attack-tiebreak"));
        assert!(!(POLICY.root_first_expansion&&POLICY.pressure_height_recovery));
    }
    #[test]
    fn final_attack_tie_preserves_primary_q_old_ties_and_terminal_behavior() {
        let s=state();let mut search=Search::new(s.clone(),1.0,amounts(&s),0).unwrap();
        search.step(&||false).unwrap();
        let template=search.nodes[0].children.as_ref().unwrap()[0].clone();
        let make=|q,outgoing,reward|{let mut e=template.clone();e.cached=Value::finite(q).unwrap();e.outgoing=outgoing;e.reward=reward;e};
        // Large immediate reward (e.g. fully cancelled attack) is not outgoing.
        let mut edges=vec![make(1.0,0,100.0),make(1.0,5,0.0),make(1.0,5,10.0)];
        assert_eq!(final_root_index(&edges,false),Some(0));
        assert_eq!(final_root_index(&edges,true),Some(1));
        edges[0].cached=Value::finite(f64::from_bits(1.0_f64.to_bits()+1)).unwrap();
        assert_eq!(final_root_index(&edges,true),Some(0),"one ULP must not become a tie");
        for e in &mut edges {e.cached=Value::LOSS;}
        assert_eq!(final_root_index(&edges,true),Some(0));
        assert_eq!(final_root_index(&[],true),None);
    }
    #[test]
    fn cached_outgoing_is_after_cancellation_on_real_root_transitions() {
        let mut s=recovery_well(8,4);s.horizon=Horizon::Open;s.known_next=vec![Piece::T];
        s.incoming.pending_rows=8;
        let mut oracle=amounts(&s);
        for row in &mut oracle {
            row.cancelled_rows=row.outgoing_before_cancel.min(8);
            row.outgoing_after_cancel=row.outgoing_before_cancel-row.cancelled_rows;
            row.remaining_rows=8-row.cancelled_rows;
        }
        for cache in [false,true] {
            let mut search=Search::new(s.clone(),1.0,oracle.clone(),17).unwrap();search.cache_transitions=cache;
            search.step(&||false).unwrap();let mut cancelled_attack=false;
            for e in search.nodes[0].children.as_ref().unwrap() {
                let (_,clear,_)=s.lock(e.witness.as_ref().unwrap(),e.key.0,1.0,&oracle).unwrap();
                let row=oracle.iter().find(|a|a.signature==clear).unwrap();
                assert_eq!(e.outgoing,row.outgoing_after_cancel);
                cancelled_attack|=row.outgoing_before_cancel>0&&e.outgoing==0;
            }
            assert!(cancelled_attack);if cache {assert!(search.transition_reuses>0);}
        }
    }
    #[test]
    #[cfg(feature="native-root-attack-tiebreak")]
    fn final_attack_presentation_is_read_only_and_promotes_beyond_diagnostic_cap() {
        let mut s=state();s.known_next=vec![Piece::I,Piece::T,Piece::S];s.hold_available=true;
        let mut a=Search::new(s.clone(),1.0,amounts(&s),17).unwrap();
        let mut b=Search::new(s.clone(),1.0,amounts(&s),17).unwrap();
        a.step(&||false).unwrap();b.step(&||false).unwrap();
        assert!(a.root_count()>32);
        // Make tied root values and an outgoing winner beyond the displayed prefix.
        for search in [&mut a,&mut b] {
            let es=search.nodes[0].children.as_mut().unwrap();
            for (i,e) in es.iter_mut().enumerate(){e.cached=Value::finite(0.0).unwrap();e.outgoing=if i==33{5}else{0};}
        }
        let expected=a.candidate(&a.nodes[0].children.as_ref().unwrap()[33]).unwrap();
        assert_eq!(a.selected().unwrap(),expected);
        for detailed in [false,true] {
            let d=a.diagnostics(detailed).unwrap();let rows=d["rootCandidates"].as_array().unwrap();
            assert_eq!(rows.len(),if detailed{32}else{1});assert_eq!(rows[0],expected);
            if detailed {
                let expected_remainder=a.nodes[0].children.as_ref().unwrap()[..31].iter()
                    .map(|e|a.candidate(e).unwrap()).collect::<Vec<_>>();
                assert_eq!(&rows[1..],expected_remainder.as_slice());
            }
        }
        for _ in 0..16 {
            assert_eq!(a.step(&||false).unwrap(),b.step(&||false).unwrap());
            let _=a.selected().unwrap();let _=a.diagnostics(true).unwrap();
            assert_eq!(a.rng.clone().gen::<u64>(),b.rng.clone().gen::<u64>());
            assert_eq!(a.stats.selections,b.stats.selections);assert_eq!(a.nodes.len(),b.nodes.len());
            for (left,right) in a.nodes.iter().zip(&b.nodes) {
                assert_eq!(left.state,right.state);assert_eq!(left.value,right.value);assert_eq!(left.closed,right.closed);
                assert_eq!(left.children.as_ref().map(|es|es.iter().map(|e|(e.child,e.key,e.cached,e.outgoing)).collect::<Vec<_>>()),
                    right.children.as_ref().map(|es|es.iter().map(|e|(e.child,e.key,e.cached,e.outgoing)).collect::<Vec<_>>()));
            }
        }
    }
    #[test]
    #[cfg(feature="native-root-first-expansion")]
    fn root_first_expansion_covers_dynamic_prefix_without_rng_then_returns_to_sampling() {
        let mut s=state();s.known_next=vec![Piece::I,Piece::T,Piece::S,Piece::Z,Piece::J];
        s.hold_available=true;
        let mut search=Search::new(s.clone(),1.0,amounts(&s),17).unwrap();
        assert!(search.step(&||false).unwrap());
        let ids: BTreeSet<_>=search.nodes[0].children.as_ref().unwrap().iter().map(|e|e.child).collect();
        assert!(search.root_count()>ids.len(),"fixture exercises duplicate witnesses");
        let next_rng=search.rng.clone().gen::<u64>();let root_legal=search.root_count();
        let mut completed=0;
        loop {
            let eligible=search.nodes[0].children.as_ref().unwrap().iter()
                .find(|e|!search.nodes[e.child].closed&&search.nodes[e.child].children.is_none()).map(|e|e.child);
            let Some(id)=eligible else {break};
            assert!(search.step(&||false).unwrap());completed+=1;
            assert!(search.nodes[id].children.is_some(),"expand current Q/tie prefix first");
            assert_eq!(search.stats.selections,1+completed);
            assert_eq!(search.root_count(),root_legal);
            assert_eq!(search.rng.clone().gen::<u64>(),next_rng);
        }
        assert!(completed>1&&completed<=ids.len() as u64);
        assert!(ids.iter().all(|&id|search.nodes[id].closed||search.nodes[id].children.is_some()));
        assert!(!search.closed());assert!(search.step(&||false).unwrap());
        assert_ne!(search.rng.clone().gen::<u64>(),next_rng,"normal rank sampling resumes");
    }
    #[test]
    #[cfg(feature="native-root-first-expansion")]
    fn root_first_expansion_cancellation_does_not_complete_or_consume_rng() {
        let mut s=state();s.known_next=vec![Piece::I,Piece::T];
        let mut search=Search::new(s.clone(),1.0,amounts(&s),5).unwrap();search.step(&||false).unwrap();
        let id=search.nodes[0].children.as_ref().unwrap().iter().find(|e|!search.nodes[e.child].closed).unwrap().child;
        let before=search.rng.clone().gen::<u64>();
        assert!(!search.step(&||true).unwrap());
        let polls=std::cell::Cell::new(0);
        assert!(!search.step(&||{polls.set(polls.get()+1);polls.get()>=2}).unwrap());
        assert!(search.nodes[id].children.is_none());assert_eq!(search.stats.selections,1);
        assert_eq!(search.rng.clone().gen::<u64>(),before);
        assert!(search.step(&||false).unwrap());assert!(search.nodes[id].children.is_some());
        assert_eq!(search.stats.selections,2);
    }
    #[test]
    #[cfg(feature="native-root-first-expansion")]
    fn root_first_expansion_skips_shared_expanded_head() {
        let mut s=state();s.known_next=vec![Piece::I,Piece::T,Piece::S,Piece::Z];
        let mut search=Search::new(s.clone(),1.0,amounts(&s),1).unwrap();search.step(&||false).unwrap();
        let shared=search.nodes[0].children.as_ref().unwrap()[0].child;
        search.step(&||false).unwrap();assert!(search.nodes[shared].children.is_some());
        assert!(!search.nodes[shared].closed);
        let descendants:Vec<_>=search.nodes[shared].children.as_ref().unwrap().iter().map(|e|e.child).collect();
        let before:Vec<_>=descendants.iter().map(|&id|search.nodes[id].children.is_some()).collect();
        // Several root witnesses share this already expanded state, with a leading reward.
        for e in search.nodes[0].children.as_mut().unwrap().iter_mut().filter(|e|e.child==shared) {e.reward+=1000000.0;}
        search.propagate(0).unwrap();assert_eq!(search.nodes[0].children.as_ref().unwrap()[0].child,shared);
        assert!(search.nodes[0].children.as_ref().unwrap().iter().filter(|e|e.child==shared).count()>1);
        let next=search.nodes[0].children.as_ref().unwrap().iter().find(|e|!search.nodes[e.child].closed
            &&search.nodes[e.child].children.is_none()).unwrap().child;
        assert!(search.step(&||false).unwrap());assert!(search.nodes[next].children.is_some());
        assert_eq!(descendants.iter().map(|&id|search.nodes[id].children.is_some()).collect::<Vec<_>>(),before);
    }
    #[test]
    fn unused_overflow_signatures_do_not_reject_legal_no_clear() {
        let mut s=state();s.chain.combo=u32::MAX;s.chain.b2b=u32::MAX;
        let mut search=Search::new(s.clone(),1.0,amounts(&s),0).unwrap();
        search.step(&||false).unwrap();assert!(search.root_count()>0);
        let mut used=s.clone();used.current=Some(Piece::I);
        used.board.cols=[1,1,1,1,1,1,0,0,0,0];
        let mut search=Search::new(used.clone(),1.0,amounts(&used),0).unwrap();
        assert_eq!(search.step(&||false),Err(Error::NumericOverflow));
    }
    #[test]
    fn shared_child_propagates_distinct_inbound_rewards_and_all_loss_keeps_root() {
        let s=state();let mut search=Search::new(s.clone(),1.0,amounts(&s),0).unwrap();search.step(&||false).unwrap();
        let edge=search.nodes[0].children.as_ref().unwrap()[0].clone();
        let mut other=edge.clone();other.reward=edge.reward+42.0;
        search.nodes[0].children=Some(vec![edge.clone(),other]);
        search.nodes[edge.child].value=Value::finite(-1565.0).unwrap();search.propagate(0).unwrap();
        assert_eq!(search.nodes[0].value,Value::finite(-1565.0+edge.reward+42.0).unwrap());
        search.nodes[edge.child].value=Value::LOSS;search.propagate(0).unwrap();
        assert_eq!(search.root_count(),2);assert_eq!(search.nodes[0].value,Value::LOSS);
        assert!(!search.selected().unwrap().is_null());
    }
    #[test]
    fn tank_identity_and_height_burden_are_finite_and_not_expanded() {
        let mut a=state();a.horizon=Horizon::UnknownTank{rows:20};
        let mut b=a.clone();b.horizon=Horizon::UnknownTank{rows:30};
        assert_ne!(a,b);assert!(evaluate(&a).unwrap()>evaluate(&b).unwrap());
        assert!(evaluate(&b).unwrap()>Value::LOSS);
    }
    fn recovery_well(height:u32,gap:usize)->State {
        let mut s=state();s.current=Some(Piece::I);
        s.board.cols=[(1_u64<<height)-1;10];s.board.cols[gap]=(1_u64<<(height-4))-1;
        // Keep lower rows non-full while retaining the well's known support block.
        s.board.cols[(gap+1)%10]&=!((1_u64<<(height-4))-1);
        s.horizon=Horizon::UnknownTank{rows:1};s
    }
    #[test]
    fn pressure_credit_requires_anchored_well_known_i_and_safe_room() {
        let s=recovery_well(8,4);assert_eq!(pressure_height_credit(&s),5.0);
        let mut bad=s.clone();bad.current=Some(Piece::O);assert_eq!(pressure_height_credit(&bad),0.0);
        bad.hold=Some(Piece::I);bad.hold_available=true;assert_eq!(pressure_height_credit(&bad),5.0);
        bad.current=None;assert_eq!(pressure_height_credit(&bad),0.0);
        bad.current=Some(Piece::O);bad.hold_available=false;assert_eq!(pressure_height_credit(&bad),0.0);
        bad.hold=None;bad.hold_available=true;bad.known_next=vec![Piece::I];assert_eq!(pressure_height_credit(&bad),0.0);
        for horizon in [Horizon::Open,Horizon::KnownNextExhausted,Horizon::UnknownTank{rows:0}] {
            let mut b=s.clone();b.horizon=horizon;assert_eq!(pressure_height_credit(&b),0.0);
        }
        let no_anchor=recovery_well(4,4);assert_eq!(pressure_height_credit(&no_anchor),0.0);
        let mut covered=s.clone();covered.board.cols[4]|=1<<7;assert_eq!(pressure_height_credit(&covered),0.0);
        let mut split=s.clone();split.board.cols[5]&=!(1<<7);assert_eq!(pressure_height_credit(&split),0.0);
        let edge=recovery_well(15,9);assert!(pressure_height_credit(&edge)>0.0);
        let mut too_high=edge;too_high.horizon=Horizon::UnknownTank{rows:2};assert_eq!(pressure_height_credit(&too_high),0.0);
        let mut huge=s.clone();huge.horizon=Horizon::UnknownTank{rows:u32::MAX};assert_eq!(pressure_height_credit(&huge),0.0);
        let mut other_g=s.clone();other_g.materialized_g=other_g.board.clone();
        assert_eq!(pressure_height_credit(&other_g),pressure_height_credit(&s));
        assert!(cfg!(feature="native-pressure-height-recovery")==POLICY.pressure_height_recovery);
        let mut no_i=s.clone();no_i.current=Some(Piece::O);
        let delta=evaluate(&s).unwrap().diagnostic()["value"].as_f64().unwrap()-evaluate(&no_i).unwrap().diagnostic()["value"].as_f64().unwrap();
        assert_eq!(delta,if POLICY.pressure_height_recovery {5.0}else{0.0});
    }
    #[test]
    fn pressure_credit_never_rewards_more_tank_including_zero_and_cutoff() {
        for h in 5..=16 {for gap in [0,4,9] {
            let mut s=recovery_well(h,gap);let mut prior=height_value(h as f64);
            for t in 0..=20 {
                s.horizon=Horizon::UnknownTank{rows:t};
                let credit=pressure_height_credit(&s);let burden=height_value(h as f64)-height_value((h+t) as f64);
                assert!(credit>=0.0&&credit<=burden);
                let value=height_value((h+t) as f64)+credit;
                assert!(value<=prior,"height {}, tank {}, gap {}",h,t,gap);prior=value;
            }
        }}
    }
    #[test]
    fn pressure_well_clear_is_reachable_for_every_hidden_hole() {
        // Referee/component worlds only. None of these materialized shapes reach the credit function.
        for (h,t) in [(5,1),(8,4),(12,4),(15,1)] {for gap in [0,4,9] {for held in [false,true] {
            let mut pre=recovery_well(h,gap);pre.horizon=Horizon::UnknownTank{rows:t};
            if held {pre.current=Some(Piece::O);pre.hold=Some(Piece::I);pre.hold_available=true;}
            assert!(pressure_height_credit(&pre)>0.0);
            for hole in 0..10 {
                let mut materialized=pre.clone();materialized.horizon=Horizon::Open;
                materialized.board.cols=std::array::from_fn(|x|(pre.board.cols[x]<<t)|if x==hole {0}else{(1_u64<<t)-1});
                materialized.materialized_g.cols=std::array::from_fn(|x|if x==hole {0}else{(1_u64<<t)-1});
                let moves=materialized.root_moves().unwrap();
                let rows=((1_u64<<4)-1)<<(h-4+t);
                assert!(moves.iter().filter(|(hold,m)|*hold==held&&m.location.piece==Piece::I).any(|(_,m)|{
                    let mut board=materialized.board.clone();board.place(m.location);board.line_clears()==rows
                }),"height {}, tank {}, gap {}, held {}, hidden {}",h,t,gap,held,hole);
            }
        }}}
    }
    #[test]
    fn legacy_rank_formula_has_identical_edges_and_rng_consumption() {
        let mut rng=rand::rngs::StdRng::seed_from_u64(1);
        for count in [1,2,17,128] { for _ in 0..100 {
            let sample:f64=rng.gen();
            assert_eq!(super::super::rank_index(sample,1.4,count),((-sample.ln()/1.4)%count as f64) as usize);
        }}
    }
    #[test]
    fn transition_cache_preserves_all_root_values_order_rng_and_logical_statistics() {
        for hold in [None,Some(Piece::T)] {
            let mut s=state();s.hold_available=true;s.hold=hold;s.known_next=vec![Piece::I,Piece::T,Piece::O,Piece::S];
            let mut a=Search::new(s.clone(),1.0,amounts(&s),42).unwrap();
            let mut b=Search::new(s.clone(),1.0,amounts(&s),42).unwrap();b.cache_transitions=false;
            for _ in 0..32 {assert_eq!(a.step(&||false).unwrap(),b.step(&||false).unwrap());}
            let roots=|search:&Search| search.nodes[0].children.as_ref().unwrap().iter().map(|e|search.candidate(e).unwrap()).collect::<Vec<_>>();
            assert_eq!(roots(&a),roots(&b));assert_eq!(a.stats.nodes,b.stats.nodes);
            let outgoing=|search:&Search|search.nodes.iter().map(|n|n.children.as_ref().map(|es|es.iter().map(|e|e.outgoing).collect::<Vec<_>>())).collect::<Vec<_>>();
            assert_eq!(outgoing(&a),outgoing(&b));assert_eq!(a.selected().unwrap(),b.selected().unwrap());
            assert_eq!(a.stats.selections,b.stats.selections);assert_eq!((a.lookups,a.hits),(b.lookups,b.hits));
            assert_eq!(a.rng.gen::<u64>(),b.rng.gen::<u64>());assert!(a.transition_reuses>0);
            let mut changed=amounts(&s);
            for row in &mut changed {if row.signature.lines==4 {row.remaining_rows=u32::MAX;}}
            let mut c=Search::new(s.clone(),1.0,changed,42).unwrap();
            // Root has no clears, so these unreachable rows cannot affect any descendant either.
            for _ in 0..32 {c.step(&||false).unwrap();}
            assert_eq!(roots(&a),roots(&c));assert_eq!((a.lookups,a.hits),(c.lookups,c.hits));
        }
    }

}
