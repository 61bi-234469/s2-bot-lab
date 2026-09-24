//! Two concrete state domains for the same CC2 layer algorithms.
use crate::data::{GameState, Piece, Placement};
use crate::map::StateKey;
use crate::s2_core;
use enumset::EnumSet;

pub trait Domain: Copy + std::fmt::Debug + 'static {
    type State: StateKey;
    type Action: Copy + Eq + std::hash::Hash + std::fmt::Debug;
    type Link: Copy + std::fmt::Debug;
    const S2: bool;
    fn current(state: &Self::State) -> Option<Piece>;
    fn bag(state: &Self::State) -> EnumSet<Piece>;
    fn advance(state: &mut Self::State, piece: Piece, action: Self::Action, enable_s2_b2b_surge: bool);
    fn link(id: u64) -> Self::Link;
    fn link_id(link: Self::Link) -> Option<u64>;
    fn finite(state: &Self::State) -> bool;
    fn compare_actions(a: Self::Action, b: Self::Action) -> std::cmp::Ordering;
}

/// Marker for the only domain admitted to the production root-allocation
/// mapper. S2 has a separate node-owned piece/root model and must never be
/// able to enter the Legacy conversion permutation surface by type inference.
pub trait LegacyRootDomain {}

#[derive(Clone, Copy, Debug)]
pub struct LegacyDomain;
impl LegacyRootDomain for LegacyDomain {}
impl Domain for LegacyDomain {
    type State = GameState;
    type Action = Placement;
    type Link = ();
    const S2: bool = false;
    fn current(_: &GameState) -> Option<Piece> { None }
    fn bag(state: &GameState) -> EnumSet<Piece> { state.bag }
    fn advance(state: &mut GameState, piece: Piece, action: Placement, enable_s2_b2b_surge: bool) {
        state
            .try_advance_with_surge(piece, action, enable_s2_b2b_surge)
            .expect("GameState advance failed");
    }
    fn link(_: u64) {}
    fn link_id(_: ()) -> Option<u64> { None }
    fn finite(_: &GameState) -> bool { false }
    fn compare_actions(_: Placement, _: Placement) -> std::cmp::Ordering {std::cmp::Ordering::Equal}
}

#[derive(Clone, Copy, Debug)]
pub struct S2Domain;
impl Domain for S2Domain {
    type State = s2_core::State;
    type Action = s2_core::Action;
    type Link = u64;
    const S2: bool = true;
    fn current(state: &s2_core::State) -> Option<Piece> { state.current }
    fn bag(_: &s2_core::State) -> EnumSet<Piece> {
        panic!("S2 unknown NEXT requires a separately admitted chance model")
    }
    fn advance(_: &mut s2_core::State, _: Piece, _: s2_core::Action, _: bool) {
        panic!("S2 transitions must follow the layer-local NodeId")
    }
    fn link(id: u64) -> u64 { id }
    fn link_id(link: u64) -> Option<u64> { Some(link) }
    fn finite(state: &s2_core::State) -> bool { state.horizon != s2_core::Horizon::Open }
    fn compare_actions(a: s2_core::Action, b: s2_core::Action) -> std::cmp::Ordering {a.key().cmp(&b.key())}
}

#[derive(Clone, Copy, Debug)]
pub enum PieceSource { LegacyFixed(Piece), S2FromState }
impl PieceSource {
    pub fn for_state<D: Domain>(self, state: &D::State) -> Option<Piece> {
        match self { Self::LegacyFixed(piece) => Some(piece), Self::S2FromState => D::current(state) }
    }
}
