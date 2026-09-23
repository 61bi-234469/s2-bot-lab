//! Remaining one-lock TSD resource, not an extra transition or attack reward.
//! Geometry is a cheap filter; the production move generator proves reachability.
use super::*;
use crate::data::Board;
use crate::native_s2::CanonicalSpin;

#[derive(Default, serde::Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct Credit {
    pub qualified: bool,
    pub bonus: f64,
    pub structure_relief: f64,
    pub movegen_calls: u32,
    #[serde(skip_serializing_if="Option::is_none")]
    pub distance_discount: Option<DistanceDiscount>,
}
#[derive(serde::Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct DistanceDiscount {pub distance:Option<usize>,pub factor:f64,pub applied_bonus:f64}
impl Credit {
    pub fn total(&self)->f64 {self.bonus+self.structure_relief}
}

// Public piece-arrival lower bound only; this does not prove slot reachability.
fn t_distance(state:&State)->Option<usize> {
    let mut distances=Vec::new();
    if state.current==Some(Piece::T) {distances.push(0);}
    if state.hold==Some(Piece::T) {distances.push(usize::from(!state.hold_available));}
    let offset=usize::from(!(state.hold.is_none()&&state.hold_available));
    distances.extend(state.known_next.iter().enumerate().filter(|(_,p)|**p==Piece::T).map(|(i,_)|i+offset));
    distances.into_iter().min()
}

// F14-style heuristic cutouts, not a proof of a future legal spin. Use distinct
// publicly known T pieces; the Native state has no bag phase to reconstruct.
pub(super) fn preview(state:&State)->Credit {
    let mut result=Credit::default();
    if state.horizon!=Horizon::Open {return result;}
    let resources=(usize::from(state.current==Some(Piece::T))
        +usize::from(state.hold==Some(Piece::T))
        +state.known_next.iter().filter(|&&p|p==Piece::T).count()).min(3);
    let mut board=state.board;
    for _ in 0..resources {
        let location=crate::bot::well_known_tslot_left(&board)
            .or_else(||crate::bot::well_known_tslot_right(&board));
        let Some(location)=location else {break;};
        if location.obstructed(&board) || location.drop_distance(&board)!=0 {break;}
        let mut after=board;after.place(location);
        let lines=after.line_clears();let count=lines.count_ones() as usize;
        if count>3 {break;}
        result.qualified=true;
        result.bonus+=[-0.2,2.0,2.6,3.2][count];
        // A non-consuming preview is scored once, never once per future T.
        if count<=1 {break;}
        after.remove_lines(lines);board=after;
    }
    result.structure_relief=structure(&board)-structure(&state.board)
        +height_value(board_features(&board).3)-height_value(board_features(&state.board).3);
    if let Some(alpha)=POLICY.tslot_bonus_distance_alpha {
        let distance=t_distance(state);
        let factor=if result.bonus>0.0 {distance.map_or(1.0,|d|alpha.powi(d as i32))}else{1.0};
        result.distance_discount=Some(DistanceDiscount{distance,factor,applied_bonus:result.bonus*factor});
    }
    result
}

// Height, chain and garbage burden are deliberately NOT part of virtual relief.
fn structure(board:&Board)->f64 {
    let (holes,covered,transitions,_)=board_features(board);
    POLICY.holes*holes as f64+POLICY.coveredness*covered as f64+POLICY.row_transitions*transitions as f64
}

pub(super) fn credit(state:&State)->Result<Credit> {
    let mut result=Credit::default();
    if state.horizon!=Horizon::Open || state.current.is_none() {return Ok(result)}
    let hold_t=state.hold_available && state.hold.or(state.known_next.first().copied())==Some(Piece::T);
    if state.current!=Some(Piece::T) && !hold_t {return Ok(result)}
    let slots:Vec<_>=[crate::bot::well_known_tslot_left(&state.board),crate::bot::well_known_tslot_right(&state.board)]
        .into_iter().flatten().filter(|loc| {
            if loc.obstructed(&state.board) || loc.drop_distance(&state.board)!=0 {return false}
            let mut copy=state.board;copy.place(*loc);copy.line_clears().count_ones()==2
        }).collect();
    if slots.is_empty() {return Ok(result)}
    // root_moves also preserves the all-sources conditional spawn fallback rule.
    result.movegen_calls=1;
    let moves=state.root_moves()?;
    for (_,mv) in moves {
        if mv.location.piece!=Piece::T || mv.spin!=CanonicalSpin::Normal
            || !slots.contains(&mv.location) {continue}
        // Only a board preview: do not evaluate hypothetical attack/chain arithmetic.
        let mut after=state.board;after.place(mv.location);let clears=after.line_clears();
        if clears.count_ones()!=2 {return Err(Error::OracleMismatch)}
        after.remove_lines(clears);
        let relief=(structure(&after)-structure(&state.board)).max(0.0)*POLICY.tsd_structure_relief_scale;
        let total=POLICY.tsd_formation_bonus+relief;
        if !result.qualified || total>result.total() {
            result.qualified=true;result.bonus=POLICY.tsd_formation_bonus;result.structure_relief=relief;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_s2::{Chain,Incoming};
    #[test]
    fn public_t_arrival_bounds_cover_hold_and_future_resources() {
        let mut s=slot();assert_eq!(t_distance(&s),Some(0));
        s.current=Some(Piece::O);s.hold=Some(Piece::T);assert_eq!(t_distance(&s),Some(1));
        s.hold_available=true;assert_eq!(t_distance(&s),Some(0));
        s.hold=None;s.known_next=vec![Piece::I,Piece::J,Piece::T];assert_eq!(t_distance(&s),Some(2));
        s.hold=Some(Piece::I);assert_eq!(t_distance(&s),Some(3));
        s.known_next=vec![Piece::I];assert_eq!(t_distance(&s),None);
    }
    #[cfg(feature="native-tslot-bonus-distance")]
    #[test]
    fn bonus_discount_preserves_relief_negative_credit_and_closed_horizons() {
        let mut s=slot();s.current=Some(Piece::O);s.known_next=vec![Piece::I,Piece::T];
        let p=preview(&s);let d=p.distance_discount.as_ref().unwrap();
        assert_eq!(d.distance,Some(2));assert_eq!(d.applied_bonus,2.6*0.9_f64.powi(2));
        assert!(p.structure_relief>10.0);
        assert_eq!(evaluate(&s).unwrap(),Value::finite(value::LeafTerms::new(&s).total()+(d.applied_bonus+p.structure_relief)).unwrap());
        s.board.cols[9]&=!3;let negative=preview(&s);
        assert_eq!(negative.bonus,-0.2);assert_eq!(negative.distance_discount.unwrap().applied_bonus,-0.2);
        for horizon in [Horizon::KnownNextExhausted,Horizon::UnknownTank{rows:1}] {
            s.horizon=horizon;let p=preview(&s);assert_eq!(p.total(),0.0);assert!(p.distance_discount.is_none());
        }
    }
    fn slot()->State {
        let mut board=Board::default();
        for x in 0..10 {
            if x!=4 {board.cols[x]|=1;}
            if !(3..=5).contains(&x) {board.cols[x]|=2;}
        }
        board.cols[5]|=4;
        State {board,materialized_g:Board::default(),current:Some(Piece::T),hold:None,hold_available:false,
            known_next:vec![Piece::O,Piece::I],chain:Chain{combo:0,b2b:0},
            incoming:Incoming{pending_rows:0,due_this_lock_rows:0},horizon:Horizon::Open}
    }
    #[test]
    fn basic_attack_tsd_is_legal_and_resource_is_consumed() {
        let s=slot();let before=s.clone();
        assert!(credit(&s).unwrap().qualified);
        assert_eq!(s,before);
        let (hold,mv)=s.root_moves().unwrap().into_iter().find(|(_,m)|m.spin==CanonicalSpin::Normal
            && {let mut b=s.board;b.place(m.location);b.line_clears().count_ones()==2}).unwrap();
        let (after,clear,attack)=s.lock_future(&mv,hold,1.0).unwrap();
        assert_eq!(clear.lines,2);assert_eq!(attack.outgoing_before_cancel,4);
        assert!(!credit(&after).unwrap().qualified);
    }
    #[test]
    fn future_t_preview_preserves_state_and_includes_height() {
        let mut s=slot();s.current=Some(Piece::O);s.known_next=vec![Piece::I,Piece::T];
        let before=s.clone();let p=preview(&s);
        assert!(p.qualified);assert_eq!(p.bonus,2.6);assert_eq!(p.movegen_calls,0);
        assert!(!credit(&s).unwrap().qualified);assert_eq!(s,before);
        let mut after=s.board;after.place(crate::bot::well_known_tslot_left(&after)
            .or_else(||crate::bot::well_known_tslot_right(&after)).unwrap());
        after.remove_lines(after.line_clears());
        assert_eq!(p.structure_relief,structure(&after)-structure(&s.board)
            +height_value(board_features(&after).3)-height_value(board_features(&s.board).3));
        s.known_next=vec![Piece::I];assert!(!preview(&s).qualified);
        s.hold=Some(Piece::T);assert!(preview(&s).qualified);
        s.horizon=Horizon::UnknownTank{rows:1};assert_eq!(preview(&s).total(),0.0);
        s.horizon=Horizon::KnownNextExhausted;assert_eq!(preview(&s).total(),0.0);
    }
    #[test]
    fn preview_nonconsuming_slot_is_not_duplicated_or_rewarded_as_attack() {
        let mut s=slot();s.board.cols[9]&=!1;
        let one=preview(&s);assert!(one.qualified);assert_eq!(one.bonus,2.0);
        assert_eq!(one.structure_relief,0.0);
        s.hold=Some(Piece::T);s.known_next=vec![Piece::T,Piece::T];
        s.chain=Chain{combo:u32::MAX,b2b:u32::MAX};
        s.incoming=Incoming{pending_rows:20,due_this_lock_rows:10};
        assert_eq!(preview(&s).total(),one.total());
        s.board.cols=[(1_u64<<40)-1;10];assert!(!preview(&s).qualified);
    }
    #[test]
    fn resource_requires_available_t_and_open_horizon() {
        let mut s=slot();s.current=Some(Piece::O);s.hold=Some(Piece::T);
        assert!(!credit(&s).unwrap().qualified);
        s.hold_available=true;assert!(credit(&s).unwrap().qualified);
        s.hold=None;s.known_next=vec![Piece::T,Piece::I];assert!(credit(&s).unwrap().qualified);
        s.known_next=vec![Piece::I,Piece::T];assert!(!credit(&s).unwrap().qualified);
        s.current=Some(Piece::T);
        for horizon in [Horizon::UnknownTank{rows:1},Horizon::KnownNextExhausted] {
            s.horizon=horizon;assert_eq!(credit(&s).unwrap().total(),0.0);
        }
    }
    #[test]
    fn blocked_slot_and_no_move_are_not_resources() {
        let mut s=slot();s.board.cols[4]|=1;
        assert!(!credit(&s).unwrap().qualified);
        s.board.cols=[(1_u64<<40)-1;10];assert!(!credit(&s).unwrap().qualified);
    }
    #[test]
    fn basic_attack_quad_uses_existing_canonical_path() {
        let mut s=slot();s.current=Some(Piece::I);s.board.cols=[15;10];s.board.cols[4]=0;
        let (hold,mv)=s.root_moves().unwrap().into_iter().find(|(_,m)|{
            let mut b=s.board;b.place(m.location);b.line_clears().count_ones()==4
        }).unwrap();
        let (_,clear,attack)=s.lock_future(&mv,hold,1.0).unwrap();
        assert_eq!(clear.lines,4);assert_eq!(clear.spin,CanonicalSpin::None);
        assert_eq!(attack.outgoing_before_cancel,9); // Quad 4 + canonical PC 5.
        assert!(!credit(&s).unwrap().qualified);
    }
    #[test]
    fn preview_does_not_evaluate_chain_reward_or_duplicate_the_same_t() {
        let mut s=slot();s.hold_available=true;s.hold=Some(Piece::T);
        let one=credit(&s).unwrap();assert!(one.qualified);
        assert_eq!(one.bonus,POLICY.tsd_formation_bonus);
        s.chain=Chain{combo:u32::MAX,b2b:u32::MAX};
        s.incoming=Incoming{pending_rows:20,due_this_lock_rows:10};
        let other=credit(&s).unwrap();assert!(other.qualified);
        assert_eq!(other.total(),one.total());
        assert_eq!(other.movegen_calls,1);
    }
}
