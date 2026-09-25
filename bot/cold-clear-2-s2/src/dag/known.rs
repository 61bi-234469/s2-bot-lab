use std::sync::atomic::{self, AtomicBool, AtomicUsize};

use bumpalo_herd::{Herd, Member};
use enum_map::EnumMap;
use rand::Rng;

use crate::data::Piece;
use crate::f14_compat::CompatError;
use crate::dag::RootSelectionMapper;
use super::{State, Action, Link};
use super::domain::{Domain, PieceSource};
use crate::map::StateMap;

use super::{
    update_child, BackpropUpdate, Child, ChildData, Evaluation, LayerCommon, SelectResult,
};

pub(super) struct Layer<'bump, E: Evaluation> {
    pub states: StateMap<Node<'bump, E>, ahash::RandomState, State<E>>,
    pub piece: PieceSource,
    pub parent_storage_slots: AtomicUsize,
}

type Parent<E> = (u64, Action<E>, Piece);

// Legacy retains its arena slices. S2 owns its growing parent buffers so an
// append does not retain another complete copy until the request is dropped.
pub(super) enum Parents<'bump, E: Evaluation> {
    Arena(&'bump [Parent<E>]),
    Owned(Vec<Parent<E>>),
}

pub(super) struct ParentGrowth {
    pub len: usize,
    pub capacity: usize,
    pub allocation_slots: usize,
    pub copy_slots: usize,
}

pub(super) fn parent_growth(len: usize, capacity: usize) -> Option<ParentGrowth> {
    if len > capacity { return None; }
    let next_len = len.checked_add(1)?;
    let growing = next_len > capacity;
    let next_capacity = if growing { capacity.checked_mul(2)?.max(4) } else { capacity };
    Some(ParentGrowth { len: next_len, capacity: next_capacity,
        allocation_slots: if growing { next_capacity } else { 0 },
        copy_slots: if growing { next_len } else { 1 } })
}

impl<'bump, E: Evaluation> Parents<'bump, E> {
    fn new() -> Self { if E::Domain::S2 { Self::Owned(Vec::new()) } else { Self::Arena(&[]) } }
    pub fn as_slice(&self) -> &[Parent<E>] {
        match self { Self::Arena(parents) => parents, Self::Owned(parents) => parents }
    }
    pub fn allocation_state(&self) -> (usize, usize) {
        match self { Self::Owned(parents) => (parents.len(), parents.capacity()),
            Self::Arena(_) => unreachable!("only S2 parent buffers are quoted") }
    }
    // Return the increase in live heap capacity. The allocation quote separately
    // charges the entire new buffer, without subtracting any released buffer.
    fn append(&mut self, bump: &Member<'bump>, entry: Parent<E>) -> usize {
        match self {
            Self::Arena(parents) => {
                *parents = bump.alloc_slice_fill_with(parents.len() + 1,
                    |i| parents.get(i).copied().unwrap_or(entry));
                0
            }
            Self::Owned(parents) => {
                let old_capacity = parents.capacity();
                let growth = parent_growth(parents.len(), old_capacity).expect("parent growth must fit its quote");
                if growth.allocation_slots != 0 {
                    let mut grown = Vec::with_capacity(growth.capacity);
                    assert_eq!(grown.capacity(), growth.capacity, "parent allocation differs from quote");
                    grown.extend_from_slice(parents);
                    *parents = grown;
                }
                parents.push(entry);
                parents.capacity() - old_capacity
            }
        }
    }
}

pub(super) struct Node<'bump, E: Evaluation> {
    pub parents: Parents<'bump, E>,
    pub eval: E,
    pub children: Option<&'bump mut [Child<E>]>,
    pub expanding: AtomicBool,
    pub closed: bool,
}

impl<'bump, E: Evaluation> Layer<'bump, E> {
    pub fn initialize_root(&self, root: &State<E>) {
        let _ = self.states.get_or_insert_with(root, || Node {
            parents: Parents::new(),
            eval: E::default(),
            children: None,
            expanding: AtomicBool::new(false),
            closed: E::Domain::finite(root),
        });
    }

    pub fn suggest(&self, state: &State<E>, limit: usize) -> Vec<(Action<E>, f32)> {
        puffin::profile_function!();
        let node = self.states.get(state).unwrap();
        let children = match &node.children {
            Some(children) => children,
            None => return vec![],
        };

        children
            .iter()
            .take(limit)
            .map(|candidate| (candidate.mv, candidate.cached_eval.value()))
            .collect()
    }

    pub fn select<R: Rng + ?Sized>(
        &self,
        game_state: &State<E>,
        exploration: f64,
        rng: &mut R,
        root_index: Option<&dyn RootSelectionMapper>,
    ) -> SelectResult<E> {
        puffin::profile_function!();
        let node = self
            .states
            .get(game_state)
            .expect("Link to non-existent node?");

        if E::Domain::S2 && node.closed { return SelectResult::Failed; }
        let children = match &node.children {
            None => {
                if node.expanding.swap(true, atomic::Ordering::Relaxed) {
                    return SelectResult::Failed;
                } else {
                    return SelectResult::Done;
                }
            }
            Some(children) => children,
        };

        if children.is_empty() {
            return SelectResult::Failed;
        }

        let count = if E::Domain::S2 { children.iter().filter(|child| !child.closed).count() } else {children.len()};
        if count == 0 { return SelectResult::Failed; }
        if let Some(map) = root_index {
            // Binding/domain failures must happen before the exactly-one
            // native draw below, preserving RNG state on malformed roots.
            if let Err(error) = map.preflight(children.len()) {
                return SelectResult::Error(error);
            }
        }
        let s: f64 = rng.gen();
        let i = if E::Domain::S2 {super::s2_rank_index(s, exploration, count)} else {super::rank_index(s, exploration, count)};
        let mapped = match root_index {
              Some(map) => match map.map(i) {
                Ok(mapped) if mapped < children.len() => mapped,
                Ok(_) => return SelectResult::Error(CompatError::RootAllocationBindingMismatch),
                Err(error) => return SelectResult::Error(error),
            },
            None => i,
        };
        let child = if E::Domain::S2 { children.iter().filter(|child| !child.closed).nth(mapped).unwrap() } else { &children[mapped] };
        SelectResult::Advance(self.piece.for_state::<E::Domain>(game_state).unwrap(), child.mv, child.target, i)
    }

    pub fn get_eval(&self, raw: u64) -> E {
        self.states.get_raw(raw).unwrap().eval
    }

    pub fn create_node(
        &self,
        bump: &Member<'bump>,
        child: &ChildData<E>,
        parent: u64,
        speculation_piece: Piece,
    ) -> (E, Link<E>, bool) {
        let mut node = self
            .states
            .get_or_insert_with(&child.resulting_state, || Node {
                parents: Parents::new(),
                eval: child.eval,
                children: None,
                expanding: AtomicBool::new(false),
                closed: E::Domain::finite(&child.resulting_state),
            });
        let added_capacity = node.parents.append(bump, (parent, child.mv, speculation_piece));
        if added_capacity != 0 { self.parent_storage_slots.fetch_add(added_capacity, atomic::Ordering::Relaxed); }
        (node.eval, E::Domain::link(self.states.index(&child.resulting_state)), node.closed)
    }

    pub fn expand(
        &self,
        herd: &'bump Herd,
        next_layer: &LayerCommon<E>,
        parent_state: State<E>,
        children: EnumMap<Piece, Vec<ChildData<E>>>,
    ) -> Vec<BackpropUpdate<E>> {
        puffin::profile_function!();
        let piece = self.piece.for_state::<E::Domain>(&parent_state).expect("expand requires known current");
        let mut childs = Vec::with_capacity(children[piece].len());

        // We need to acquire the lock on the parent since the backprop routine needs the children
        // lists to exist, and they won't if we're still creating them
        let parent_index = self.states.index(&parent_state);
        let mut parent = self.states.get_raw_mut(parent_index).unwrap();

        {
            puffin::profile_scope!("create nodes");
            let evals =
                next_layer
                    .kind
                    .create_nodes(&children[piece], parent_index, piece);
            for (child, (eval, target, closed)) in children[piece].iter().zip(evals.into_iter()) {
                childs.push(Child {
                    closed,
                    target,
                    mv: child.mv,
                    cached_eval: eval + child.reward,
                    root_bonus: super::RootOrderAdjustment::NONE,
                    reward: child.reward,
                    root_priority: child.root_priority,
                });
            }
        }

        childs.sort_by(|a, b| super::compare_children(a, b).reverse());

        parent.eval = E::average(std::iter::once(childs.first().map(|c| c.cached_eval)));
        parent.closed = E::Domain::S2 && childs.iter().all(|child| child.closed);
        parent.children = Some(herd.get().alloc_slice_copy(&childs));

        let mut next = vec![];

        for &(grandparent, mv, speculation_piece) in parent.parents.as_slice() {
            next.push(BackpropUpdate {
                parent: grandparent,
                mv,
                speculation_piece,
                child: parent_index,
            });
        }

        next
    }

    pub fn backprop(
        &self,
        to_update: Vec<BackpropUpdate<E>>,
        next_layer: &LayerCommon<E>,
    ) -> Vec<BackpropUpdate<E>> {
        puffin::profile_function!();
        let mut new_updates = vec![];
        let mut seen = std::collections::HashSet::new();

        for update in to_update {
            if matches!(self.piece, PieceSource::LegacyFixed(piece) if update.speculation_piece != piece) {
                continue;
            }

            let mut parent = self.states.get_raw_mut(update.parent).unwrap();
            let child_eval = next_layer.kind.get_eval(update.child);

            // S2 propagates old-best downgrades and closure as well as numeric
            // changes. Legacy deliberately retains its historical return test.
            if E::Domain::S2 {
                let before = (parent.children.as_ref().unwrap().first().map(|c| (c.mv, c.cached_eval)), parent.closed);
                let children = parent.children.as_mut().unwrap();
                update_child(children, update.mv, child_eval);
                children.iter_mut().find(|c| c.mv == update.mv).unwrap().closed = next_layer.kind.get_closed(update.child);
                let after = (children.first().map(|c| (c.mv, c.cached_eval)), children.iter().all(|c| c.closed));
                parent.eval = E::average(std::iter::once(after.0.map(|(_, value)| value)));
                parent.closed = after.1;
                if before != after {
                    for &(parent, mv, speculation_piece) in parent.parents.as_slice() {
                        // The next layer reads final child values after this
                        // entire layer finishes. Keep only the first update for
                        // each edge, before allocating its work-list entry.
                        if seen.insert((parent,mv,speculation_piece,update.parent)) {
                            new_updates.push(BackpropUpdate {parent, mv, speculation_piece, child:update.parent});
                        }
                    }
                }
                continue;
            }

            let children = parent.children.as_mut().unwrap();

            let is_best = update_child(children, update.mv, child_eval);

            if is_best {
                let eval = children[0].cached_eval;

                if parent.eval != eval {
                    parent.eval = eval;

                    for &(parent, mv, speculation_piece) in parent.parents.as_slice() {
                        new_updates.push(BackpropUpdate {
                            parent,
                            mv,
                            speculation_piece,
                            child: update.parent,
                        });
                    }
                }
            }
        }

        new_updates
    }
}
