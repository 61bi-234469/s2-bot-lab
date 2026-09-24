//! Production leaf and edge value arithmetic, with optional read-only projections.
//! Changes to these terms change search policy. Diagnostic traversal alone must
//! preserve the complete root set and the existing selected/top-32 prefix.
use super::*;

#[derive(serde::Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct LeafTerms {
    holes:f64, coveredness:f64, row_transitions:f64,
    actual_height:f64, tank_height:f64, height_offset:f64,
    b2b_active:f64, b2b_surge:f64, pressure_recovery:Option<f64>,
}
impl LeafTerms {
    pub(super) fn new(state:&State)->Self {
        let p=&*POLICY;
        let (holes,covered,transitions,height)=board_features(&state.board);
        let tank=match state.horizon {Horizon::UnknownTank{rows}=>rows as f64,_=>0.0};
        Self {holes:p.holes*holes as f64,coveredness:p.coveredness*covered as f64,
            row_transitions:p.row_transitions*transitions as f64,
            actual_height:height_value(height),tank_height:height_value(height+tank),height_offset:height_value(height),
            b2b_active:p.b2b_resource*f64::from(u8::from(state.chain.b2b>0)),
            b2b_surge:p.b2b_resource*f64::from(u8::from(state.chain.b2b>=4)),
            pressure_recovery:if p.pressure_height_recovery {Some(pressure_height_credit(state))}else{None}}
    }
    pub(super) fn total(&self)->f64 {
        // Keep the original expression's floating-point operation order exactly.
        let base=self.holes+self.coveredness+self.row_transitions
            +self.actual_height+self.tank_height-self.height_offset+self.b2b_active+self.b2b_surge;
        if let Some(credit)=self.pressure_recovery {base+credit}else{base}
    }
}
impl Search {
    // Follow the already-sorted maximizing edges. This observes committed values;
    // it neither expands nodes nor applies the root-only presentation tie-break.
    fn value_path(&self,start:usize)->Result<Json> {
        let mut id=start;let mut seen=BTreeSet::new();let mut steps=Vec::new();
        loop {
            if !seen.insert(id) {return Err(Error::InvalidInput)}
            let node=&self.nodes[id];
            if let Some(edge)=node.children.as_ref().and_then(|c|c.first()) {
                steps.push(json!({"node":id,"child":edge.child,"key":edge.key,
                    "reward":edge.reward,"outgoing":edge.outgoing,"q":edge.cached.diagnostic()}));
                id=edge.child;
            } else {
                return Ok(json!({"steps":steps,"leaf":{"node":id,"depth":node.depth,
                    "horizon":node.state.horizon,"terminalLoss":node.children.is_some(),
                    "value":node.value.diagnostic(),"staticEval":node.eval.diagnostic(),
                    "leafTerms":LeafTerms::new(&node.state),"formation":node.formation}}));
            }
        }
    }
    pub(super) fn root_value(&self)->Json {
        let root=&self.nodes[0];
        json!({"formation":root.formation,"leafTerms":LeafTerms::new(&root.state),
            "postStateEval":root.eval.diagnostic()})
    }
    fn branch_frontier(&self,start:usize)->Json {
        let mut seen=BTreeSet::new();let mut stack=vec![start];
        let mut depths=Vec::new();let(mut expanded,mut open,mut tank,mut next,mut loss)=(0,0,0,0,0);
        while let Some(id)=stack.pop() {
            if !seen.insert(id) {continue}
            let node=&self.nodes[id];
            if let Some(children)=&node.children {
                expanded+=1;if children.is_empty(){loss+=1;depths.push(node.depth);}
                stack.extend(children.iter().map(|e|e.child));
            } else {
                depths.push(node.depth);
                match node.state.horizon {Horizon::Open=>open+=1,Horizon::UnknownTank{..}=>tank+=1,Horizon::KnownNextExhausted=>next+=1}
            }
        }
        json!({"reachableStates":seen.len(),"expandedStates":expanded,"openLeaves":open,"tankLeaves":tank,
            "nextLeaves":next,"terminalLosses":loss,"leafDepthMin":depths.iter().min(),"leafDepthMax":depths.iter().max()})
    }
    pub(super) fn root_index(&self)->Result<Json> {
        let mut frontiers=HashMap::default();
        let mut entries=Vec::new();
        for e in self.nodes[0].children.as_deref().unwrap_or(&[]) {
            let node=&self.nodes[e.child];
            let mv=e.witness.as_ref().ok_or(Error::InvalidInput)?;
            let root=&self.nodes[0].state;
            let (next,clear,_)=root.lock(mv,e.key.0,self.multiplier,&self.amounts)?;
            let tank=match next.horizon {Horizon::UnknownTank{rows}=>rows,_=>0};
            let cancelled=root.incoming.pending_rows-next.incoming.pending_rows-tank;
            let wasted_t=mv.location.piece==Piece::T&&(clear.lines<2||clear.spin!=crate::native_s2::CanonicalSpin::Normal);
            let reward=RewardTerms::new(e.outgoing,cancelled,wasted_t,mv.soft_drops);
            let frontier=frontiers.entry(e.child).or_insert_with(||self.branch_frontier(e.child));
            entries.push(json!({"key":e.key,"child":e.child,"reward":e.reward,"outgoing":e.outgoing,
                "rewardTerms":reward,"frontier":frontier,"valuePath":self.value_path(e.child)?,
                "spin":e.witness.as_ref().map(|w|w.spin),"softDrops":e.witness.as_ref().map(|w|w.soft_drops),
                "leafTerms":LeafTerms::new(&node.state),"formation":node.formation,
                "pieceResources":{"current":node.state.current,"hold":node.state.hold,
                    "holdAvailable":node.state.hold_available,"known":node.state.known_next},
                "postStateEval":node.eval.diagnostic(),"continuationValue":node.value.diagnostic(),
                "q":e.cached.diagnostic(),"horizon":node.state.horizon,
                "expanded":node.children.is_some(),"depth":node.depth}));
        }
        Ok(json!(entries))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct RewardTerms {outgoing:f64,cancelled:f64,wasted_t:f64,pub(super) softdrop:f64}
impl RewardTerms {
    pub(super) fn new(outgoing:u32,cancelled:u32,wasted_t:bool,soft_drops:u32)->Self {
        Self {outgoing:POLICY.outgoing*outgoing as f64,cancelled:POLICY.cancelled*cancelled as f64,
            wasted_t:POLICY.wasted_t*f64::from(u8::from(wasted_t)),softdrop:POLICY.softdrop*soft_drops as f64}
    }
    pub(super) fn base(&self)->f64 {self.outgoing+self.cancelled+self.wasted_t}
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::tests::{state,amounts};

    #[test]
    fn value_paths_reconstruct_propagated_q_without_changing_search() {
        let mut s=state();s.known_next=vec![Piece::I,Piece::T];s.hold_available=true;
        let mut observed=Search::new(s.clone(),1.0,amounts(&s),42).unwrap();
        let mut control=Search::new(s.clone(),1.0,amounts(&s),42).unwrap();
        for _ in 0..32 {
            assert_eq!(observed.step(&||false).unwrap(),control.step(&||false).unwrap());
            let diagnostic=observed.diagnostics(true).unwrap();
            for row in diagnostic["rootIndex"].as_array().unwrap() {
                let path=&row["valuePath"];
                let leaf=path["leaf"]["value"]["value"].as_f64();
                if let Some(mut v)=leaf {
                    for step in path["steps"].as_array().unwrap().iter().rev() {
                        v+=step["reward"].as_f64().unwrap();
                        assert_eq!(v,step["q"]["value"].as_f64().unwrap());
                    }
                    assert_eq!(v,row["continuationValue"]["value"].as_f64().unwrap());
                    v+=row["reward"].as_f64().unwrap();
                    assert_eq!(v,row["q"]["value"].as_f64().unwrap());
                } else {assert_eq!(row["q"],Value::LOSS.diagnostic());}
            }
            assert_eq!(observed.selected().unwrap(),control.selected().unwrap());
            assert_eq!(observed.rng.clone().gen::<u64>(),control.rng.clone().gen::<u64>());
            assert_eq!(observed.nodes.len(),control.nodes.len());
        }
    }
    #[test]
    fn leaf_decomposition_keeps_original_floating_point_order() {
        for b2b in [0,1,3,4,5,15,u32::MAX] {
            for tank in [0,1,4,20] {
                let mut s=state();s.chain.b2b=b2b;
                s.board.cols[0]=0b101101;s.board.cols[3]=0b11011;
                if tank>0 {s.horizon=Horizon::UnknownTank{rows:tank};}
                let p=&*POLICY;let (holes,covered,transitions,height)=board_features(&s.board);
                let base=p.holes*holes as f64+p.coveredness*covered as f64+p.row_transitions*transitions as f64
                    +height_value(height)+height_value(height+tank as f64)-height_value(height)
                    +p.b2b_resource*f64::from(u8::from(b2b>0))+p.b2b_resource*f64::from(u8::from(b2b>=4));
                let expected=if p.pressure_height_recovery {base+pressure_height_credit(&s)}else{base};
                assert_eq!(LeafTerms::new(&s).total().to_bits(),expected.to_bits());
            }
        }
    }
    #[test]
    fn complete_root_index_does_not_change_search_or_selected_prefix() {
        let mut s=state();s.known_next=vec![Piece::I,Piece::T];s.hold_available=true;
        let mut search=Search::new(s.clone(),1.0,amounts(&s),42).unwrap();
        search.step(&||false).unwrap();
        let before=search.selected().unwrap();let rng=search.rng.clone().gen::<u64>();
        let full=search.diagnostics(true).unwrap();let brief=search.diagnostics(false).unwrap();
        assert!(search.root_count()>32);
        assert_eq!(full["rootIndex"].as_array().unwrap().len(),search.root_count());
        assert_eq!(full["rootCandidates"][0],before);
        assert_eq!(brief["rootCandidates"][0],before);
        assert_eq!(search.selected().unwrap(),before);
        assert_eq!(search.rng.clone().gen::<u64>(),rng);
    }
    #[test]
    fn aborted_expansion_removes_provisional_nodes_and_parent_links() {
        let mut s=state();s.hold_available=true;s.known_next=vec![Piece::T,Piece::I,Piece::J];
        let mut search=Search::new(s.clone(),1.0,amounts(&s),42).unwrap();
        for root_complete in [false,true] {
            if root_complete {search.step(&||false).unwrap();}
            let nodes=search.nodes.len();let index=search.index.len();
            let parents:Vec<_>=search.nodes.iter().map(|n|n.parents.clone()).collect();
            let selected=search.selected().unwrap();
            let counters=(search.lookups,search.hits,search.transition_reuses);
            let calls=std::cell::Cell::new(0);
            assert!(!search.step(&||{calls.set(calls.get()+1);calls.get()>=3}).unwrap());
            assert!(calls.get()>=3);
            assert_eq!(search.nodes.len(),nodes);assert_eq!(search.index.len(),index);
            assert_eq!(search.nodes.iter().map(|n|n.parents.clone()).collect::<Vec<_>>(),parents);
            assert_eq!(search.selected().unwrap(),selected);
            assert_eq!((search.lookups,search.hits,search.transition_reuses),counters);
            assert_eq!(search.lookups-search.hits,(search.nodes.len()-1) as u64);
        }
    }
}
