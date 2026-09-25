use bumpalo_herd::Herd;
use enum_map::EnumMap;
use once_cell::sync::Lazy;
use ouroboros::self_referencing;

use crate::data::Piece;
use crate::f14_compat::CompatError;
use crate::map::StateMap;

mod known;
pub mod domain;
use domain::{Domain, PieceSource};
type State<E> = <<E as Evaluation>::Domain as Domain>::State;
type Action<E> = <<E as Evaluation>::Domain as Domain>::Action;
type Link<E> = <<E as Evaluation>::Domain as Domain>::Link;
pub(crate) mod finite;

// Preserve the legacy formula and its one RNG draw per successful selection.
fn rank_index(sample: f64, exploration: f64, count: usize) -> usize {
    ((-sample.ln() / exploration) % count as f64) as usize
}
fn s2_rank_index(sample:f64,exploration:f64,count:usize)->usize {
    assert!(sample>=0.&&sample<1.&&(1e-6..=1e6).contains(&exploration)&&count>0);
    // rand's f64 draws have 53 random bits. Replace only zero with its minimum
    // positive grid value so ln/division stay finite; consume no extra draw.
    rank_index(sample.max(f64::EPSILON/2.),exploration,count)
}
mod speculated;

pub trait Evaluation:
    Ord + Copy + Default + std::ops::Add<Self::Reward, Output = Self> + 'static
{
    type Reward: Copy;
    type Domain: Domain;

    fn average(of: impl Iterator<Item = Option<Self>>) -> Self;
    fn value(self) -> f32;
    fn is_error(self) -> bool {false}
    fn is_loss(self) -> bool {false}
}

pub struct Dag<E: Evaluation> {
    root: State<E>,
    top_layer: Box<LayerCommon<E>>,
}

pub struct Selection<'a, E: Evaluation> {
    layers: Vec<&'a LayerCommon<E>>,
    game_state: State<E>,
    // S2 diagnostics only: retain the root witness and state path that led to
    // the selected open node. This is observational metadata; selection still
    // uses the same layer-local RNG and child ordering.
    root_action: Option<Action<E>>,
    root_draw_index: Option<usize>,
    path_states: Vec<State<E>>,
    committed: bool,
}

pub struct ChildData<E: Evaluation> {
    pub resulting_state: State<E>,
    pub mv: Action<E>,
    pub eval: E,
    pub reward: E::Reward,
    // Diagnostic only: parent-edge preference, never a shared node value.
    pub root_priority: bool,
}

/// Side-effect-free Legacy root read used by the F14 allocation observer.
///
/// Keeping None (not expanded) distinct from Some([]) (expanded but no
/// legal children) is part of the root-allocation contract.  This API never
/// forces a layer, reads a continuation value, or changes the native child
/// order.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum LegacyRootSnapshot {
    Unexpanded,
    Expanded { actions: Vec<(crate::data::Placement, f32)> },
}

#[derive(Default)]
struct LayerCommon<E: Evaluation> {
    next_layer: Lazy<Box<LayerCommon<E>>>,
    next_initialized:std::sync::atomic::AtomicBool,
    kind: WithBump<E>,
}
impl<E:Evaluation> LayerCommon<E> {
    fn next(&self)->&LayerCommon<E> {
        let next=&*self.next_layer;
        self.next_initialized.store(true,std::sync::atomic::Ordering::Release);
        next
    }
}

#[self_referencing]
struct WithBump<E: Evaluation> {
    bump: Herd,
    arena_used:std::sync::atomic::AtomicBool,
    #[borrows(bump)]
    #[not_covariant]
    data: LayerKind<'this, E>,
}

enum LayerKind<'bump, E: Evaluation> {
    Known(known::Layer<'bump, E>),
    Speculated(speculated::Layer<'bump, E>),
}

#[derive(Clone, Copy, Debug)]
struct Child<E: Evaluation> {
    mv: Action<E>,
    reward: E::Reward,
    cached_eval: E,
    root_bonus: RootOrderAdjustment,
    root_priority: bool,
    target: Link<E>,
    closed: bool,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RootOrderAdjustmentKind {
    None,
    Mix,
    Tiebreak,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct RootOrderAdjustment {
    value: f64,
    kind: RootOrderAdjustmentKind,
}

impl RootOrderAdjustment {
    const NONE: Self = Self {
        value: 0.0,
        kind: RootOrderAdjustmentKind::None,
    };

    fn mix(value: f64) -> Self {
        Self { value, kind: RootOrderAdjustmentKind::Mix }
    }

    fn tiebreak(value: f64) -> Self {
        Self { value, kind: RootOrderAdjustmentKind::Tiebreak }
    }

    fn is_tiebreak(self) -> bool {
        self.kind == RootOrderAdjustmentKind::Tiebreak
    }

    fn mix_value(self) -> Option<f64> {
        (self.kind == RootOrderAdjustmentKind::Mix).then_some(self.value)
    }

    fn tiebreak_value(self) -> Option<f64> {
        self.is_tiebreak().then_some(self.value)
    }
}

// Preserve the generic child footprint used by S2 allocation estimates; only
// the Legacy root comparator interprets the new adjustment kind.
const _: [(); std::mem::size_of::<Option<f64>>()] =
    [(); std::mem::size_of::<RootOrderAdjustment>()];
const _: [(); std::mem::align_of::<Option<f64>>()] =
    [(); std::mem::align_of::<RootOrderAdjustment>()];

fn compare_children<E: Evaluation>(a: &Child<E>, b: &Child<E>) -> std::cmp::Ordering {
    if E::Domain::S2 {
        return a.cached_eval.is_error().cmp(&b.cached_eval.is_error())
            .then_with(|| (!a.cached_eval.is_loss()).cmp(&(!b.cached_eval.is_loss())))
            .then_with(|| a.root_priority.cmp(&b.root_priority))
            .then_with(|| compare_child_values(a, b))
            .then_with(|| E::Domain::compare_actions(b.mv, a.mv));
    }
    a.root_priority.cmp(&b.root_priority).then_with(|| compare_child_values(a, b))
}

fn compare_child_values<E: Evaluation>(a: &Child<E>, b: &Child<E>) -> std::cmp::Ordering {
    // Tie-break terms preserve native Ord unless the native values are exactly
    // equal. This tag is only populated by the opt-in F14 profile.
    if a.root_bonus.is_tiebreak() || b.root_bonus.is_tiebreak() {
        let native_cmp = a.cached_eval.cmp(&b.cached_eval);
        if native_cmp != std::cmp::Ordering::Equal {
            return native_cmp;
        }
        return match (a.root_bonus.tiebreak_value(), b.root_bonus.tiebreak_value()) {
            (Some(a_term), Some(b_term)) => a_term
                .partial_cmp(&b_term)
                .unwrap_or(std::cmp::Ordering::Equal),
            (Some(_), None) => std::cmp::Ordering::Greater,
            (None, Some(_)) => std::cmp::Ordering::Less,
            (None, None) => std::cmp::Ordering::Equal,
        };
    }

    // With no tie-break tag, preserve the old native/mix comparator exactly.
    let a_bonus = a.root_bonus.mix_value().unwrap_or(0.0);
    let b_bonus = b.root_bonus.mix_value().unwrap_or(0.0);
    if a_bonus == 0.0 && b_bonus == 0.0 {
        return a.cached_eval.cmp(&b.cached_eval);
    }
    let native_cmp = || a.cached_eval.cmp(&b.cached_eval);
    let a_value = a.cached_eval.value() as f64 + a_bonus;
    let b_value = b.cached_eval.value() as f64 + b_bonus;
    a_value
        .partial_cmp(&b_value)
        .unwrap_or_else(native_cmp)
        .then_with(native_cmp)
}

pub struct RootEdge<E: Evaluation> {
    pub action: Action<E>, pub reward: E::Reward, pub value: E,
    pub continuation: E, pub inside_margin: bool,
}

pub struct AllocationQuote {pub new_nodes:usize,pub parent_copy_slots:usize,pub parent_allocation_slots:usize}
pub struct AllocationUnits {pub layer:usize,pub node_and_edge:usize,pub parent_slot:usize,pub backup_edge:usize}
#[derive(Default)]
pub struct StorageStatistics {
    pub initialized_layers:usize,pub keys:usize,pub index_capacity:usize,pub index_bytes:usize,
    pub arena_bytes:usize,pub node_storage:usize,
}

enum SelectResult<E: Evaluation> {
    Failed,
    Done,
    Error(CompatError),
    Advance(Piece, Action<E>, Link<E>, usize),
}

/// Root index remapping is deliberately split into a preflight and a mapping
/// operation. Preflight must run before the layer's sole native RNG draw.
pub(crate) trait RootSelectionMapper {
    fn preflight(&self, raw_count: usize) -> Result<(), CompatError>;
    fn map(&self, native_index: usize) -> Result<usize, CompatError>;
}

struct BackpropUpdate<E: Evaluation> {
    parent: u64,
    speculation_piece: Piece,
    mv: Action<E>,
    child: u64,
}

impl<E: Evaluation> Dag<E> {
    pub fn new(root: State<E>, queue: &[Piece]) -> Self {
        assert!(!E::Domain::S2, "use new_s2 for node-owned current pieces");
        let mut top_layer = LayerCommon::default();
        top_layer.kind.initialize_root(&root);

        let mut layer = &mut top_layer;
        for &piece in queue {
            layer.kind.despeculate(piece);
            layer = &mut layer.next_layer;
        }

        Dag {
            root,
            top_layer: Box::new(top_layer),
        }
    }

    pub fn new_s2(root: State<E>) -> Self {
        assert!(E::Domain::S2);
        let top_layer = Box::<LayerCommon<E>>::default();
        top_layer.kind.initialize_root(&root);
        Self {root, top_layer}
    }

    pub fn advance(&mut self, mv: Action<E>) {
        self.advance_with_surge(mv, false);
    }

    pub fn advance_with_surge(&mut self, mv: Action<E>, enable_s2_b2b_surge: bool) {
        assert!(!E::Domain::S2);
        puffin::profile_function!();
        let top_layer = std::mem::take(&mut *self.top_layer);
        E::Domain::advance(&mut self.root,
            top_layer
                .kind
                .piece()
                .expect("cannot advance without next piece"),
            mv,
            enable_s2_b2b_surge,
        );
        Lazy::force(&top_layer.next_layer);
        self.top_layer = Lazy::into_value(top_layer.next_layer).unwrap();
        self.top_layer.kind.initialize_root(&self.root);
    }

    pub fn add_piece(&mut self, piece: Piece) {
        assert!(!E::Domain::S2, "S2 request context cannot extend its known queue");
        puffin::profile_function!();
        let mut layer = &mut self.top_layer;
        loop {
            if layer.kind.despeculate(piece) {
                // TODO: backprop despeculated values
                return;
            }
            layer = &mut layer.next_layer;
        }
    }

    pub fn suggest(&self, limit: usize) -> Vec<(Action<E>, f32)> {
        puffin::profile_function!();
        self.top_layer.kind.suggest(&self.root, limit)
    }

    /// Return the raw Legacy root children without changing their order.
    ///
    /// F14's observer is intentionally limited to the Legacy domain.  S2
    /// has a separate root snapshot authority and must not enter this path.
    pub(crate) fn legacy_root_snapshot(&self) -> LegacyRootSnapshot
    where
        E::Domain: Domain<Action = crate::data::Placement>,
    {
        assert!(!E::Domain::S2, "Legacy root snapshot is not an S2 API");
        self.top_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer) => {
                let node = layer.states.get(&self.root).unwrap();
                match node.children.as_ref() {
                    None => LegacyRootSnapshot::Unexpanded,
                    Some(children) => LegacyRootSnapshot::Expanded {
                        actions: children
                            .iter()
                            .map(|child| (child.mv, child.cached_eval.value()))
                            .collect(),
                    },
                }
            }
            LayerKind::Speculated(_) => unreachable!("Legacy root must be despeculated before use"),
        })
    }

    /// Order scored Legacy root children ahead of every unscored child.
    ///
    /// The score and CC2 rank form the same order used by F14's post-stage
    /// rerank. Missing scores mean the action was rejected or outside the
    /// verified prefix; native values are retained only to order those
    /// unscored children with each other.
    pub(crate) fn apply_legacy_root_scores<F>(
        &self,
        scores: &[(crate::data::Placement, f64, i32)],
        from_value: F,
    ) -> usize
    where
        E::Domain: Domain<Action = crate::data::Placement>,
        F: Fn(f32) -> E,
    {
        assert!(!E::Domain::S2, "Legacy root values are not an S2 API");
        let scores: std::collections::HashMap<_, _> = scores
            .iter()
            .map(|(action, score, rank)| (*action, (*score, *rank)))
            .collect();
        self.top_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer) => {
                let root_index = layer.states.index(&self.root);
                let Some(mut node) = layer.states.get_raw_mut(root_index) else { return 0; };
                let Some(children) = node.children.as_mut() else { return 0; };
                let mut changed = 0;
                for child in children.iter_mut() {
                    if let Some((score, _)) = scores.get(&child.mv) {
                        debug_assert!(score.is_finite());
                        child.cached_eval = from_value(*score as f32);
                        changed += 1;
                    }
                }
                children.sort_by(|left, right| {
                    match (scores.get(&left.mv), scores.get(&right.mv)) {
                        (Some((left_score, left_rank)), Some((right_score, right_rank))) => {
                            right_score
                                .partial_cmp(left_score)
                                .unwrap_or(std::cmp::Ordering::Equal)
                                .then_with(|| left_rank.cmp(right_rank))
                                .then_with(|| compare_children(left, right).reverse())
                        }
                        (Some(_), None) => std::cmp::Ordering::Less,
                        (None, Some(_)) => std::cmp::Ordering::Greater,
                        (None, None) => compare_children(left, right).reverse(),
                    }
                });
                node.eval = E::average(std::iter::once(children.first().map(|child| child.cached_eval)));
                changed
            }
            LayerKind::Speculated(_) => unreachable!("Legacy root must be despeculated before use"),
        })
    }

    /// Reorder only the Legacy root by native backed-up value plus a separate
    /// F14 bonus. The root `node.eval` is not recomputed, and the first suggested
    /// child's native value may differ from the root's stored value.
    pub(crate) fn apply_legacy_root_bonuses(
        &self,
        bonuses: &[(crate::data::Placement, f64)],
        scale: f64,
    ) -> Result<usize, CompatError>
    where
        E::Domain: Domain<Action = crate::data::Placement>,
    {
        assert!(!E::Domain::S2, "Legacy root bonuses are not an S2 API");
        if !scale.is_finite() {
            return Err(CompatError::NonFiniteFeature);
        }
        let bonuses: std::collections::HashMap<_, _> = bonuses
            .iter()
            .map(|(action, term)| {
                if !term.is_finite() {
                    return Err(CompatError::NonFiniteFeature);
                }
                let bonus = scale * term;
                if !bonus.is_finite() {
                    return Err(CompatError::NonFiniteFeature);
                }
                Ok((*action, bonus))
            })
            .collect::<Result<_, _>>()?;
        self.top_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer) => {
                let root_index = layer.states.index(&self.root);
                let Some(mut node) = layer.states.get_raw_mut(root_index) else { return Ok(0); };
                let Some(children) = node.children.as_mut() else { return Ok(0); };
                let mut changed = 0;
                for child in children.iter_mut() {
                    child.root_bonus = RootOrderAdjustment::NONE;
                    if let Some(bonus) = bonuses.get(&child.mv) {
                        if !(child.cached_eval.value() as f64 + bonus).is_finite() {
                            return Err(CompatError::NonFiniteFeature);
                        }
                        child.root_bonus = RootOrderAdjustment::mix(*bonus);
                        changed += 1;
                    }
                }
                children.sort_by(|left, right| compare_children(left, right).reverse());
                Ok(changed)
            }
            LayerKind::Speculated(_) => unreachable!("Legacy root must be despeculated before use"),
        })
    }

    /// Order the Legacy root by native value, then use the F14 term only inside
    /// an exact native tie. The reported values remain native.
    pub(crate) fn apply_legacy_root_tiebreaks(
        &self,
        terms: &[(crate::data::Placement, f64)],
    ) -> Result<usize, CompatError>
    where
        E::Domain: Domain<Action = crate::data::Placement>,
    {
        assert!(!E::Domain::S2, "Legacy root tie-breaks are not an S2 API");
        let terms: std::collections::HashMap<_, _> = terms
            .iter()
            .map(|(action, term)| {
                if !term.is_finite() {
                    return Err(CompatError::NonFiniteFeature);
                }
                Ok((*action, *term))
            })
            .collect::<Result<_, _>>()?;
        self.top_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer) => {
                let root_index = layer.states.index(&self.root);
                let Some(mut node) = layer.states.get_raw_mut(root_index) else { return Ok(0); };
                let Some(children) = node.children.as_mut() else { return Ok(0); };
                let mut changed = 0;
                for child in children.iter_mut() {
                    child.root_bonus = RootOrderAdjustment::NONE;
                    if let Some(term) = terms.get(&child.mv) {
                        child.root_bonus = RootOrderAdjustment::tiebreak(*term);
                        changed += 1;
                    }
                }
                children.sort_by(|left, right| compare_children(left, right).reverse());
                Ok(changed)
            }
            LayerKind::Speculated(_) => unreachable!("Legacy root must be despeculated before use"),
        })
    }

    pub fn is_complete(&self) -> bool {
        self.top_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer) => layer.states.get(&self.root).unwrap().closed,
            LayerKind::Speculated(_) => false,
        })
    }

    pub fn root_complete(&self) -> bool {
        self.top_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer) => layer.states.get(&self.root).unwrap().children.is_some(),
            LayerKind::Speculated(layer) => layer.states.get(&self.root).unwrap().children.is_some(),
        })
    }

    pub fn root_edges(&self) -> Vec<RootEdge<E>> {
        assert!(E::Domain::S2, "precise snapshots are S2-domain only");
        self.top_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer) => {
                let node=layer.states.get(&self.root).unwrap();
                node.children.as_ref().map_or_else(Vec::new,|children|children.iter().map(|c|RootEdge {
                    action:c.mv,reward:c.reward,value:c.cached_eval,inside_margin:c.root_priority,
                    continuation:self.top_layer.next().kind.get_eval(E::Domain::link_id(c.target).unwrap())
                }).collect())
            }
            LayerKind::Speculated(_) => unreachable!("S2 chance is not admitted"),
        })
    }

    /// Caller supplies the number of layers it has committed, including root.
    pub fn exact_index_stats(&self, layers: usize) -> (usize,usize,usize) {
        let mut total=(0,0,0);let mut current=&*self.top_layer;
        for depth in 0..layers {
            let n=current.kind.with(|this| match this.data {
                LayerKind::Known(l)=>l.states.exact_stats(),LayerKind::Speculated(l)=>l.states.exact_stats(),
            });
            total.0+=n.0;total.1+=n.1;total.2+=n.2;
            if depth+1<layers {current=current.next();}
        }
        total
    }

    pub fn allocation_units() -> AllocationUnits {
        use std::mem::size_of;
        assert!(E::Domain::S2);
        AllocationUnits {
            layer:StateMap::<known::Node<'static,E>,ahash::RandomState,State<E>>::shard_storage_bytes()+size_of::<LayerCommon<E>>()+4096,
            // Capacity growth, index buckets/IDs, allocator alignment, and
            // arena children. Every edge is charged as a fresh node even when shared.
            node_and_edge:4*(size_of::<State<E>>()+size_of::<known::Node<'static,E>>()+size_of::<Child<E>>()+96),
            parent_slot:2*(size_of::<(u64,Action<E>,Piece)>()+16),
            // Two work vectors plus insertion-time dedup sets, with growth slack.
            backup_edge:8*(size_of::<BackpropUpdate<E>>()+48),
        }
    }
    /// Quiescent single-worker inspection: never force an uninitialized layer
    /// or borrow a new empty arena just to measure it.
    pub fn initialized_storage(&self)->StorageStatistics {
        assert!(E::Domain::S2);let mut total=StorageStatistics::default();let mut current=&*self.top_layer;
        loop {
            current.kind.with(|this| {
                if this.arena_used.load(std::sync::atomic::Ordering::Acquire) {
                    total.arena_bytes+=this.bump.get().as_bump().allocated_bytes();
                }
                match this.data {LayerKind::Known(l)=>{
                    let (keys,capacity,bytes)=l.states.exact_stats();
                    total.keys+=keys;total.index_capacity+=capacity;total.index_bytes+=bytes;
                    total.node_storage+=l.states.storage_estimate_bytes()
                        +l.parent_storage_slots.load(std::sync::atomic::Ordering::Relaxed)*std::mem::size_of::<(u64,Action<E>,Piece)>();
                },_=>unreachable!()};
            });
            total.initialized_layers+=1;
            if !current.next_initialized.load(std::sync::atomic::Ordering::Acquire) {break;}
            current=&current.next_layer;
        }
        total
    }

    pub(crate) fn root_priorities(&self) -> Vec<(Action<E>, bool, f32)> {
        self.top_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer) => {
                let node = layer.states.get(&self.root).unwrap();
                node.children.as_ref().map_or_else(Vec::new, |children| children.iter()
                    .map(|c| (c.mv, c.root_priority, c.cached_eval.value())).collect())
            }
            LayerKind::Speculated(_) => vec![],
        })
    }

    pub fn select<R: rand::Rng + ?Sized>(
        &self,
        speculate: bool,
        exploration: f64,
        rng: &mut R,
    ) -> Option<Selection<E>> {
        self.select_with_surge(speculate, exploration, rng, false)
    }

    pub fn select_with_surge<R: rand::Rng + ?Sized>(
        &self,
        speculate: bool,
        exploration: f64,
        rng: &mut R,
        enable_s2_b2b_surge: bool,
    ) -> Option<Selection<E>> {
        self.select_with_surge_root_impl(speculate, exploration, rng, enable_s2_b2b_surge, None)
            .ok()
            .flatten()
    }

    /// Production root allocation is intentionally Legacy-only. S2 callers
    /// must use the unbound selector; test-only coverage can exercise runtime
    /// rejection through `select_with_surge_root_test`.
    pub fn select_with_surge_root<R: rand::Rng + ?Sized>(
        &self,
        speculate: bool,
        exploration: f64,
        rng: &mut R,
        enable_s2_b2b_surge: bool,
        root_index: Option<&dyn RootSelectionMapper>,
    ) -> Result<Option<Selection<E>>, CompatError>
    where
        E::Domain: domain::LegacyRootDomain,
    {
        self.select_with_surge_root_impl(speculate, exploration, rng, enable_s2_b2b_surge, root_index)
    }

    #[cfg(test)]
    pub(crate) fn select_with_surge_root_test<R: rand::Rng + ?Sized>(
        &self,
        speculate: bool,
        exploration: f64,
        rng: &mut R,
        enable_s2_b2b_surge: bool,
        root_index: Option<&dyn RootSelectionMapper>,
    ) -> Result<Option<Selection<E>>, CompatError> {
        self.select_with_surge_root_impl(speculate, exploration, rng, enable_s2_b2b_surge, root_index)
    }

    fn select_with_surge_root_impl<R: rand::Rng + ?Sized>(
        &self,
        speculate: bool,
        exploration: f64,
        rng: &mut R,
        enable_s2_b2b_surge: bool,
        root_index: Option<&dyn RootSelectionMapper>,
    ) -> Result<Option<Selection<E>>, CompatError> {
        puffin::profile_function!();
        let mut layers = vec![&*self.top_layer];
        let mut game_state = self.root;
        let mut root_action = None;
        let mut root_draw_index = None;
        let mut path_states = vec![game_state];
        loop {
            let &layer = layers.last().unwrap();

            let mapper = if root_action.is_none() { root_index } else { None };
            if mapper.is_some() && E::Domain::S2 {
                return Err(CompatError::RootAllocationDomainRejected);
            }
            match layer.kind.select(&game_state, speculate, exploration, rng, mapper) {
                SelectResult::Failed => return Ok(None),
                SelectResult::Error(error) => return Err(error),
                SelectResult::Done => return Ok(Some(Selection {
                    layers,
                    game_state,
                    root_action,
                    root_draw_index,
                    path_states,
                    committed: false,
                })),
                SelectResult::Advance(next, placement, target, draw_index) => {
                    if root_action.is_none() {
                        root_action = Some(placement);
                        root_draw_index = Some(draw_index);
                    }
                    if let Some(id) = E::Domain::link_id(target) {
                        game_state = layer.next().kind.key(id).expect("layer-local S2 node missing");
                    } else { E::Domain::advance(&mut game_state, next, placement, enable_s2_b2b_surge); }
                    layers.push(layer.next());
                    path_states.push(game_state);
                }
            }
        }
    }
}

impl<E: Evaluation> Selection<'_, E> {
    pub fn depth(&self) -> usize { self.layers.len() - 1 }

    pub(crate) fn root_action(&self) -> Option<Action<E>> { self.root_action }

    pub(crate) fn root_draw_index(&self) -> Option<usize> { self.root_draw_index }

    pub(crate) fn path_states(&self) -> &[State<E>] { &self.path_states }

    pub fn is_root(&self) -> bool {
        self.layers.len() == 1
    }

    pub fn state(&self) -> (State<E>, Option<Piece>) {
        (self.game_state, if E::Domain::S2 { E::Domain::current(&self.game_state) } else { self.layers.last().unwrap().kind.piece() })
    }

    /// Quote each S2 buffer growth before registration. Charge the entire new
    /// capacity without reclaiming old charges; keep copy/write work separate.
    pub fn allocation_quote(&self,children:&EnumMap<Piece,Vec<ChildData<E>>>)->Option<AllocationQuote> {
        assert!(E::Domain::S2);
        let layer=self.layers.last()?.next();
        layer.kind.with(|this| match this.data {
            LayerKind::Known(next)=>{
                let mut counts=std::collections::HashMap::new();let mut new_nodes=0usize;let mut slots=0usize;let mut allocated=0usize;
                for child in children.values().flatten() {
                    let count=counts.entry(child.resulting_state).or_insert_with(|| {
                        next.states.get(&child.resulting_state).map_or_else(||{new_nodes+=1;(0,0)},|n|n.parents.allocation_state())
                    });
                    let growth=known::parent_growth(count.0,count.1)?;
                    *count=(growth.len,growth.capacity);
                    slots=slots.checked_add(growth.copy_slots)?;
                    allocated=allocated.checked_add(growth.allocation_slots)?;
                }
                Some(AllocationQuote {new_nodes,parent_copy_slots:slots,parent_allocation_slots:allocated})
            },_=>unreachable!(),
        })
    }

    pub fn expand(mut self, children: EnumMap<Piece, Vec<ChildData<E>>>) {
        puffin::profile_function!();
        assert!(E::Domain::S2 || self.is_root() || children.values().all(|list| list.iter().all(|c| !c.root_priority)),
            "root priority must not enter a deeper layer");
        self.committed = true;
        let mut layers = std::mem::take(&mut self.layers);
        let start_layer = layers.pop().unwrap();
        let mut next = start_layer
            .kind
            .expand(start_layer.next(), self.game_state, children);

        puffin::profile_scope!("backprop");
        let mut next_layer = start_layer;
        while let Some(layer) = layers.pop() {
            next = layer.kind.backprop(next, next_layer);
            next_layer = layer;

            if next.is_empty() {
                break;
            }
        }
    }
}

impl<E: Evaluation> Drop for Selection<'_, E> {
    fn drop(&mut self) {
        if E::Domain::S2 && !self.committed {
            if let Some(layer) = self.layers.last() {
                layer.kind.with(|this| match this.data {
                    LayerKind::Known(layer) => {
                        let node = layer.states.get(&self.game_state).unwrap();
                        node.expanding.store(false, std::sync::atomic::Ordering::Relaxed);
                    }
                    LayerKind::Speculated(_) => unreachable!("S2 chance is not admitted"),
                });
            }
        }
    }
}

fn update_child<E: Evaluation>(list: &mut [Child<E>], placement: Action<E>, child_eval: E) -> bool {
    let mut index = list
        .iter()
        .enumerate()
        .find_map(|(i, c)| (c.mv == placement).then(|| i))
        .unwrap();

    list[index].cached_eval = child_eval + list[index].reward;

    if index > 0 && compare_children(&list[index - 1], &list[index]).is_lt() {
        // Shift up until the list is in order
        let hole = list[index];
        while index > 0 && compare_children(&list[index - 1], &hole).is_lt() {
            list[index] = list[index - 1];
            index -= 1;
        }
        list[index] = hole;
    } else if index < list.len() - 1 && compare_children(&list[index + 1], &list[index]).is_gt() {
        // Shift down until the list is in order
        let hole = list[index];
        while index < list.len() - 1 && compare_children(&list[index + 1], &hole).is_gt() {
            list[index] = list[index + 1];
            index += 1;
        }
        list[index] = hole;
    }

    index == 0
}

impl<E: Evaluation> WithBump<E> {
    fn initialize_root(&self, root: &State<E>) {
        self.with(|this| match this.data {
            LayerKind::Known(l) => l.initialize_root(root),
            LayerKind::Speculated(l) => l.initialize_root(root),
        });
    }

    fn backprop(
        &self,
        to_update: Vec<BackpropUpdate<E>>,
        next_layer: &LayerCommon<E>,
    ) -> Vec<BackpropUpdate<E>> {
        puffin::profile_function!();
        self.with(|this| match this.data {
            LayerKind::Known(l) => l.backprop(to_update, next_layer),
            LayerKind::Speculated(l) => l.backprop(to_update, next_layer),
        })
    }

    fn piece(&self) -> Option<Piece> {
        self.with(|this| match this.data {
            LayerKind::Known(l) => match l.piece { PieceSource::LegacyFixed(piece) => Some(piece), PieceSource::S2FromState => None },
            LayerKind::Speculated(_) => None,
        })
    }

    fn expand(
        &self,
        next_layer: &LayerCommon<E>,
        parent_state: State<E>,
        children: EnumMap<Piece, Vec<ChildData<E>>>,
    ) -> Vec<BackpropUpdate<E>> {
        puffin::profile_function!();
        self.with(|this| {
            this.arena_used.store(true,std::sync::atomic::Ordering::Release);
            match this.data {
                LayerKind::Known(l) => l.expand(this.bump, next_layer, parent_state, children),
                LayerKind::Speculated(l) => l.expand(this.bump, next_layer, parent_state, children),
            }
        })
    }

    fn select<R: rand::Rng + ?Sized>(
        &self,
        game_state: &State<E>,
        speculate: bool,
        exploration: f64,
        rng: &mut R,
        root_index: Option<&dyn RootSelectionMapper>,
    ) -> SelectResult<E> {
        puffin::profile_function!();
        self.with(|this| match this.data {
            LayerKind::Known(l) => l.select(game_state, exploration, rng, root_index),
            LayerKind::Speculated(_) if root_index.is_some() => SelectResult::Error(CompatError::RootAllocationDomainRejected),
            LayerKind::Speculated(l) if speculate => l.select(game_state, exploration, rng),
            LayerKind::Speculated(_) => SelectResult::Failed,
        })
    }

    fn suggest(&self, state: &State<E>, limit: usize) -> Vec<(Action<E>, f32)> {
        puffin::profile_function!();
        self.with(|this| match this.data {
            LayerKind::Known(l) => l.suggest(state, limit),
            LayerKind::Speculated(l) => l.suggest(state, limit),
        })
    }

    fn despeculate(&mut self, piece: Piece) -> bool {
        puffin::profile_function!();
        self.with_mut(|this| {
            let old = match this.data {
                LayerKind::Known(_) => return false,
                LayerKind::Speculated(l) => std::mem::take(l),
            };

            let layer = known::Layer {
                states: old.states.map_values(|node| known::Node {
                    parents: known::Parents::Arena(node.parents),
                    eval: node.eval,
                    children: node.children.map(|v| v.into_children(piece)),
                    expanding: node.expanding,
                    closed: false,
                }),
                piece: PieceSource::LegacyFixed(piece),
                parent_storage_slots: Default::default(),
            };

            *this.data = LayerKind::Known(layer);

            true
        })
    }

    fn key(&self, raw: u64) -> Option<State<E>> {
        self.with(|this| match this.data {
            LayerKind::Known(l) => l.states.key(raw),
            LayerKind::Speculated(l) => l.states.key(raw),
        })
    }

    fn get_eval(&self, raw: u64) -> E {
        self.with(|this| match this.data {
            LayerKind::Known(l) => l.get_eval(raw),
            LayerKind::Speculated(l) => l.get_eval(raw),
        })
    }

    fn get_closed(&self, raw: u64) -> bool {
        self.with(|this| match this.data {
            LayerKind::Known(l) => l.states.get_raw(raw).unwrap().closed,
            LayerKind::Speculated(_) => false,
        })
    }

    fn create_nodes(
        &self,
        children: &[ChildData<E>],
        parent: u64,
        speculation_piece: Piece,
    ) -> Vec<(E, Link<E>, bool)> {
        self.with(|this| match this.data {
            LayerKind::Known(l) => {
                this.arena_used.store(true,std::sync::atomic::Ordering::Release);
                let bump = this.bump.get();
                children
                    .iter()
                    .map(|child| l.create_node(&bump, child, parent, speculation_piece))
                    .collect()
            }
            LayerKind::Speculated(l) => {
                this.arena_used.store(true,std::sync::atomic::Ordering::Release);
                let bump = this.bump.get();
                children
                    .iter()
                    .map(|child| l.create_node(&bump, child, parent, speculation_piece))
                    .collect()
            }
        })
    }
}

impl<E: Evaluation> Default for WithBump<E> {
    fn default() -> Self {
        WithBump::new(Herd::new(),std::sync::atomic::AtomicBool::new(false), |_| if E::Domain::S2 {
            LayerKind::Known(known::Layer {states: Default::default(), piece: PieceSource::S2FromState, parent_storage_slots: Default::default()})
        } else { LayerKind::Speculated(Default::default()) })
    }
}

#[cfg(test)]
mod s2_connection_tests {
    use super::*;
    use crate::{data::Board, native_s2::{self, Chain, Incoming}, s2_core::{Context, modelled_amounts}};
    use rand::{SeedableRng, rngs::StdRng};

    #[test]
    fn s2_rank_boundary_is_finite_without_changing_normal_draws() {
        for exploration in [1e-6,0.5,1e6] {
            for count in [1,17,1000] {
                assert_eq!(s2_rank_index(0.,exploration,count),rank_index(f64::EPSILON/2.,exploration,count));
                for sample in [f64::EPSILON/2.,0.001,0.5,0.9999999999999999] {
                    assert_eq!(s2_rank_index(sample,exploration,count),rank_index(sample,exploration,count));
                }
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
    enum Value { Loss, Finite(i32) }
    impl Default for Value { fn default()->Self {Self::Finite(0)} }
    impl std::ops::Add<i32> for Value {
        type Output=Self;
        fn add(self,r:i32)->Self {match self {Self::Loss=>Self::Loss,Self::Finite(v)=>Self::Finite(v+r)}}
    }
    impl Evaluation for Value {
        type Reward=i32;
        type Domain=domain::S2Domain;
        fn average(mut of:impl Iterator<Item=Option<Self>>)->Self { of.next().flatten().unwrap_or(Self::Loss) }
        fn value(self)->f32 {match self {Self::Loss=>f32::NEG_INFINITY,Self::Finite(v)=>v as f32}}
    }

    fn context() -> Context {
        let root = native_s2::State { board:Board::default(), materialized_g:Board::default(),
            current:Some(Piece::T), hold:None, hold_available:true, known_next:vec![Piece::I,Piece::O,Piece::L,Piece::J],
            chain:Chain {combo:256,b2b:300},incoming:Incoming {pending_rows:0,due_this_lock_rows:0},horizon:native_s2::Horizon::Open };
        let table=modelled_amounts(root.chain,root.incoming,1.0).unwrap();
        Context::new(root,1.0,3,table).unwrap()
    }

    #[test]
    #[should_panic(expected = "S2 request context cannot extend its known queue")]
    fn s2_queue_extension_is_rejected_before_allocating_layers() {
        Dag::<Value>::new_s2(context().root()).add_piece(Piece::I);
    }

    #[test]
    fn cc2_known_layers_follow_s2_node_current_and_actual_lock_depth() {
        let context=context();
        let dag=Dag::<Value>::new_s2(context.root());
        let mut rng=StdRng::seed_from_u64(42);
        let mut depth_one=std::collections::BTreeSet::new();
        let mut expansions=0;
        for _ in 0..100 {
            let Some(selection)=dag.select(false,0.005,&mut rng) else {continue;};
            let (state,piece)=selection.state();
            assert_eq!(piece,state.current);
            assert_eq!(state.chain.b2b,300);
            assert!(selection.depth()<3);
            if selection.depth()==1 {depth_one.insert((state.known_cursor,piece.unwrap() as u8));}
            let expansion=context.prepare(state,selection.depth() as u16).unwrap();
            let mut children: EnumMap<Piece, Vec<ChildData<Value>>>=EnumMap::default();
            for action in expansion.actions().unwrap() {
                let transition=expansion.transition(action).unwrap();
                children[piece.unwrap()].push(ChildData {resulting_state:transition.next,mv:action,
                    eval:Value::Finite(0),reward:0,root_priority:false});
            }
            selection.expand(children);
            expansions+=1;
        }
        assert!(expansions>2);
        assert!(depth_one.contains(&(1,Piece::I as u8)));
        assert!(depth_one.contains(&(2,Piece::O as u8)));
        assert!(!dag.suggest(1).is_empty());
        // Both empty-HOLD and no-HOLD edges retain complete typed proofs.
        let actions=dag.root_priorities();
        assert!(actions.iter().any(|a|a.0.hold_used()));
        assert!(actions.iter().any(|a|!a.0.hold_used()));
    }

    #[test]
    fn cancelled_expansion_keeps_snapshot_and_can_reacquire_reservation() {
        let context=context();
        let dag=Dag::<Value>::new_s2(context.root());
        let mut rng=StdRng::seed_from_u64(7);
        let cancelled=dag.select(false,0.5,&mut rng).unwrap();
        let prepared=context.prepare(cancelled.state().0,cancelled.depth() as u16).unwrap();
        let action=prepared.actions().unwrap()[0];
        let transition=prepared.transition(action).unwrap();
        assert!(dag.select(false,0.5,&mut rng).is_none());
        assert!(dag.suggest(1).is_empty());
        drop(cancelled); // no partial batch enters the tree
        let retry=dag.select(false,0.5,&mut rng).unwrap();
        let mut children:EnumMap<Piece,Vec<ChildData<Value>>>=EnumMap::default();
        children[context.root().current.unwrap()]=vec![ChildData {mv:action,
            resulting_state:crate::s2_core::State {horizon:crate::s2_core::Horizon::KnownNextExhausted,..transition.next},
            eval:Value::Finite(-1000),reward:0,root_priority:false}];
        retry.expand(children);
        assert!(dag.is_complete());
        assert!(dag.select(false,0.5,&mut rng).is_none());
        assert_eq!(dag.suggest(1),vec![(action,-1000.0)]); // finite leaf retained for final choice
        dag.top_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer)=>assert_eq!(layer.states.get(&context.root()).unwrap().eval,Value::Finite(-1000)),
            _=>unreachable!(),
        });
    }

    #[test]
    fn old_best_downgrade_and_closure_reach_every_shared_parent_edge() {
        use crate::s2_core::{State, Horizon};
        let context=context();let root=context.root();
        let actions=context.prepare(root,0).unwrap().actions().unwrap();
        let [root_layer,parent_layer,children_layer,leaves_layer]=std::array::from_fn::<_,4,_>(|_|LayerCommon::<Value>::default());
        let state=|combo,horizon| State {chain:Chain {combo,b2b:0},horizon,..root};
        let parent=state(1,Horizon::Open);
        let a=state(2,Horizon::Open);let b=state(3,Horizon::Open);
        let edge=|mv,resulting_state,value,reward| ChildData {mv,resulting_state,eval:Value::Finite(value),reward,root_priority:false};
        let batch=|list| {let mut e=EnumMap::default();e[Piece::T]=list;e};
        root_layer.kind.initialize_root(&root);
        root_layer.kind.expand(&parent_layer,root,batch(actions.iter().take(6).enumerate()
            .map(|(i,&mv)|edge(mv,parent,100,-3*i as i32)).collect()));
        let updates=parent_layer.kind.expand(&children_layer,parent,batch(vec![edge(actions[2],a,10,0),edge(actions[3],b,9,0)]));
        root_layer.kind.backprop(updates,&parent_layer);
        assert_eq!(root_layer.kind.suggest(&root,6),actions.iter().take(6).enumerate()
            .map(|(i,&mv)|(mv,10.0-3.0*i as f32)).collect::<Vec<_>>());
        for (child,value,combo) in [(a,8,4),(b,9,5)] {
            let updates=children_layer.kind.expand(&leaves_layer,child,batch(vec![edge(actions[4],state(combo,Horizon::DepthLimit),value,0)]));
            let updates=parent_layer.kind.backprop(updates,&children_layer);
            root_layer.kind.backprop(updates,&parent_layer);
            assert_eq!(root_layer.kind.suggest(&root,6),actions.iter().take(6).enumerate()
                .map(|(i,&mv)|(mv,9.0-3.0*i as f32)).collect::<Vec<_>>());
        }
        root_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer)=>assert!(layer.states.get(&root).unwrap().closed), _=>unreachable!(),
        });
        let mut rng=StdRng::seed_from_u64(3);
        assert!(matches!(root_layer.kind.select(&root,false,0.5,&mut rng,None),SelectResult::Failed));
    }

    #[test]
    fn parent_buffer_quote_preserves_order_and_counts_only_growth_allocations() {
        let context=context();let root=context.root();let dag=Dag::<Value>::new_s2(root);let mut rng=StdRng::seed_from_u64(2);
        let prepared=context.prepare(root,0).unwrap();let actions=prepared.actions().unwrap();
        let next=prepared.transition(actions[0]).unwrap().next;
        let mut children:EnumMap<Piece,Vec<ChildData<Value>>>=EnumMap::default();
        children[root.current.unwrap()]=actions.iter().take(3).map(|&mv|ChildData {
            resulting_state:next,mv,eval:Value::Finite(0),reward:0,root_priority:false}).collect();
        let selected=dag.select(false,0.5,&mut rng).unwrap();let quote=selected.allocation_quote(&children).unwrap();
        assert_eq!(quote.new_nodes,1);assert_eq!(quote.parent_copy_slots,3);assert_eq!(quote.parent_allocation_slots,4);
        selected.expand(children);
        let stored=||dag.top_layer.next().kind.with(|this|match this.data {
            LayerKind::Known(layer)=>{
                let node=layer.states.get(&next).unwrap();
                (node.parents.allocation_state(),node.parents.as_slice().to_vec(),
                    layer.parent_storage_slots.load(std::sync::atomic::Ordering::Relaxed))
            },_=>unreachable!(),
        });
        let before=stored();assert_eq!(before.0,(3,4));assert_eq!(before.2,4);
        let probe=Selection {layers:vec![&dag.top_layer],game_state:root,root_action:None,root_draw_index:None,path_states:vec![root],committed:true};
        let mut children:EnumMap<Piece,Vec<ChildData<Value>>>=EnumMap::default();
        children[root.current.unwrap()]=actions.iter().take(2).map(|&mv|ChildData {
            resulting_state:next,mv,eval:Value::Finite(0),reward:0,root_priority:false}).collect();
        let quote=probe.allocation_quote(&children).unwrap();
        assert_eq!(quote.new_nodes,0);assert_eq!(quote.parent_copy_slots,6);assert_eq!(quote.parent_allocation_slots,8);
        assert_eq!(stored(),before); // quoting and dropping a selection cannot allocate parent buffers
        drop(probe);
        dag.top_layer.next().kind.create_nodes(&children[root.current.unwrap()],0,root.current.unwrap());
        let after=stored();assert_eq!(after.0,(5,8));assert_eq!(after.2,8);
        assert_eq!(after.1.iter().map(|p|p.1).collect::<Vec<_>>(),
            actions.iter().take(3).chain(actions.iter().take(2)).copied().collect::<Vec<_>>());
        // Full buffers must fail their checked quote before a growth can overflow.
        assert!(known::parent_growth(usize::MAX,usize::MAX).is_none());
        assert!(known::parent_growth(usize::MAX/2+1,usize::MAX/2+1).is_none());
        assert!(known::parent_growth(2,1).is_none());
    }

    #[test]
    fn repeated_backups_keep_one_pending_update_per_parent_edge() {
        use crate::s2_core::{State,Horizon};
        let context=context();let root=context.root();let actions=context.prepare(root,0).unwrap().actions().unwrap();
        let [r,p,c,l]=std::array::from_fn::<_,4,_>(|_|LayerCommon::<Value>::default());
        let state=|combo,horizon|State {chain:Chain {combo,b2b:0},horizon,..root};
        let parent=state(1,Horizon::Open);let a=state(2,Horizon::Open);let b=state(3,Horizon::Open);
        let edge=|mv,resulting_state,value|ChildData {mv,resulting_state,eval:Value::Finite(value),reward:0,root_priority:false};
        let batch=|list|{let mut e=EnumMap::default();e[Piece::T]=list;e};
        r.kind.initialize_root(&root);
        r.kind.expand(&p,root,batch(vec![edge(actions[0],parent,100),edge(actions[1],parent,100)]));
        let updates=p.kind.expand(&c,parent,batch(vec![edge(actions[2],a,10),edge(actions[3],b,9)]));r.kind.backprop(updates,&p);
        let mut updates=c.kind.expand(&l,a,batch(vec![edge(actions[4],state(4,Horizon::DepthLimit),8)]));
        updates.extend(c.kind.expand(&l,b,batch(vec![edge(actions[5],state(5,Horizon::DepthLimit),7)])));
        let updates=p.kind.backprop(updates,&c);assert_eq!(updates.len(),2);
        r.kind.backprop(updates,&p);
        assert_eq!(r.kind.suggest(&root,2),vec![(actions[0],8.0),(actions[1],8.0)]);
        r.kind.with(|this|match this.data {LayerKind::Known(layer)=>assert!(layer.states.get(&root).unwrap().closed),_=>unreachable!()});
    }

    #[test]
    fn future_terminal_loss_keeps_the_current_legal_root_move() {
        let context=context();let root=context.root();let dag=Dag::<Value>::new_s2(root);
        let mut rng=StdRng::seed_from_u64(1);
        let first=dag.select(false,0.5,&mut rng).unwrap();
        let prepared=context.prepare(root,0).unwrap();let action=prepared.actions().unwrap()[0];
        let next=prepared.transition(action).unwrap().next;
        let mut children:EnumMap<Piece,Vec<ChildData<Value>>>=EnumMap::default();
        children[root.current.unwrap()]=vec![ChildData {resulting_state:next,mv:action,eval:Value::Finite(0),reward:0,root_priority:false}];
        first.expand(children);
        dag.select(false,0.5,&mut rng).unwrap().expand(EnumMap::default());
        assert!(dag.is_complete());
        assert_eq!(dag.suggest(1)[0].0,action);
        dag.top_layer.kind.with(|this| match this.data {
            LayerKind::Known(layer)=>assert_eq!(layer.states.get(&root).unwrap().eval,Value::Loss), _=>unreachable!(),
        });
    }

    #[test]
    fn finite_best_stays_selectable_while_sampling_draws_only_expandable_edges() {
        let context=context();let root=context.root();let dag=Dag::<Value>::new_s2(root);
        let mut rng=StdRng::seed_from_u64(81);let mut oracle=rng.clone();
        let initial=dag.select(false,0.5,&mut rng).unwrap();
        let prepared=context.prepare(root,0).unwrap();let actions=prepared.actions().unwrap();
        let open=prepared.transition(actions[1]).unwrap().next;
        let finite=crate::s2_core::State {horizon:crate::s2_core::Horizon::DepthLimit,..prepared.transition(actions[0]).unwrap().next};
        let mut children:EnumMap<Piece,Vec<ChildData<Value>>>=EnumMap::default();
        children[root.current.unwrap()]=vec![ChildData {resulting_state:finite,mv:actions[0],eval:Value::Finite(100),reward:0,root_priority:false},
            ChildData {resulting_state:open,mv:actions[1],eval:Value::Finite(10),reward:0,root_priority:false}];
        initial.expand(children);
        for _ in 0..32 {
            let selected=dag.select(false,0.5,&mut rng).unwrap();
            assert_eq!(selected.state().0,open);
            assert_eq!(selected.depth(),1);
            let _:f64=rand::Rng::gen(&mut oracle);
            assert_eq!(rand::RngCore::next_u64(&mut rng.clone()),rand::RngCore::next_u64(&mut oracle.clone()));
            drop(selected);
            assert_eq!(dag.suggest(1),vec![(actions[0],100.0)]);
        }
    }

    struct RejectingRootMapper;
    impl RootSelectionMapper for RejectingRootMapper {
        fn preflight(&self, _: usize) -> Result<(), CompatError> {
            Err(CompatError::RootAllocationBindingMismatch)
        }
        fn map(&self, _: usize) -> Result<usize, CompatError> {
            panic!("map must not run after preflight rejection")
        }
    }

    #[test]
    fn s2_root_mapper_is_rejected_before_rng_for_open_and_closed_states() {
        let mapper = RejectingRootMapper;
        let root = context().root();
        let mut rng = StdRng::seed_from_u64(77);
        let mut oracle = StdRng::seed_from_u64(77);
        assert!(matches!(
            Dag::<Value>::new_s2(root)
                .select_with_surge_root_test(false, 0.5, &mut rng, false, Some(&mapper)),
            Err(CompatError::RootAllocationDomainRejected)
        ));
        assert_eq!(rand::RngCore::next_u64(&mut rng), rand::RngCore::next_u64(&mut oracle));
        let closed = crate::s2_core::State {
            horizon: crate::s2_core::Horizon::KnownNextExhausted,
            ..root
        };
        assert!(matches!(
            Dag::<Value>::new_s2(closed)
                .select_with_surge_root_test(false, 0.5, &mut rng, false, Some(&mapper)),
            Err(CompatError::RootAllocationDomainRejected)
        ));
        assert_eq!(rand::RngCore::next_u64(&mut rng), rand::RngCore::next_u64(&mut oracle));
    }
}

#[cfg(test)]
mod edge_cost_tests {
    use super::*;
    use crate::data::{Board, GameState, Placement, PieceLocation, Rotation, Spin};
    use enumset::EnumSet;

    #[derive(Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
    struct Value(i32);
    impl std::ops::Add<i32> for Value {
        type Output = Self;
        fn add(self, rhs: i32) -> Self { Self(self.0 + rhs) }
    }
    impl Evaluation for Value {
        type Reward = i32;
        type Domain = domain::LegacyDomain;
        fn average(of: impl Iterator<Item = Option<Self>>) -> Self {
            let values: Vec<_> = of.map(|v| v.unwrap_or(Self(-1000)).0).collect();
            Self(values.iter().sum::<i32>() / values.len() as i32)
        }
        fn value(self) -> f32 { self.0 as f32 }
    }

    struct RejectingRootMapper;
    impl RootSelectionMapper for RejectingRootMapper {
        fn preflight(&self, _: usize) -> Result<(), CompatError> {
            Err(CompatError::RootAllocationBindingMismatch)
        }
        fn map(&self, _: usize) -> Result<usize, CompatError> {
            panic!("map must not run after preflight rejection")
        }
    }

    struct IdentityRootMapper;
    impl RootSelectionMapper for IdentityRootMapper {
        fn preflight(&self, raw_count: usize) -> Result<(), CompatError> {
            (raw_count > 0).then_some(()).ok_or(CompatError::RootAllocationBindingMismatch)
        }
        fn map(&self, native_index: usize) -> Result<usize, CompatError> { Ok(native_index) }
    }

    struct ExpectedCountRootMapper(usize);
    impl RootSelectionMapper for ExpectedCountRootMapper {
        fn preflight(&self, raw_count: usize) -> Result<(), CompatError> {
            (raw_count == self.0).then_some(()).ok_or(CompatError::RootAllocationBindingMismatch)
        }
        fn map(&self, native_index: usize) -> Result<usize, CompatError> { Ok(native_index) }
    }

    #[test]
    fn legacy_root_preflight_rejects_before_rng_and_valid_mapper_draws_once() {
        use rand::{RngCore, SeedableRng, rngs::StdRng};
        let mv = |x| Placement { location: PieceLocation { piece: Piece::I,
            rotation: Rotation::North, x, y: 0 }, spin: Spin::None };
        let root = GameState { board: Board::default(), bag: EnumSet::only(Piece::I),
            reserve: Piece::I, b2b: 0, combo: 0, pending_incoming_rows: 0, due_this_lock_rows: 0 };
        let mut parent = LayerCommon::<Value>::default();
        let child = LayerCommon::<Value>::default();
        parent.kind.despeculate(Piece::I);
        parent.kind.initialize_root(&root);
        let states = [GameState { combo: 1, ..root }, GameState { combo: 2, ..root }];
        let mut edges = EnumMap::default();
        edges[Piece::I] = (0..2).map(|i| ChildData { resulting_state: states[i], mv: mv(i as i8),
            eval: Value(0), reward: 0, root_priority: false }).collect();
        parent.kind.expand(&child, root, edges);

        let mapper = RejectingRootMapper;
        let mut rng = StdRng::seed_from_u64(101);
        let mut oracle = StdRng::seed_from_u64(101);
        assert!(matches!(parent.kind.select(&root, true, 0.5, &mut rng, Some(&mapper)),
            SelectResult::Error(CompatError::RootAllocationBindingMismatch)));
        assert_eq!(rng.next_u64(), oracle.next_u64(), "preflight consumed native RNG");

        let wrong_count = ExpectedCountRootMapper(3);
        assert!(matches!(parent.kind.select(&root, true, 0.5, &mut rng, Some(&wrong_count)),
            SelectResult::Error(CompatError::RootAllocationBindingMismatch)));
        assert_eq!(rng.next_u64(), oracle.next_u64(), "wrong raw_count consumed native RNG");

        let mapper = IdentityRootMapper;
        let mut expected = rng.clone();
        let _: f64 = rand::Rng::gen(&mut expected);
        let _ = parent.kind.select(&root, true, 0.5, &mut rng, Some(&mapper));
        assert_eq!(rng.next_u64(), expected.next_u64(), "valid mapping consumes one native draw");
    }

    #[test]
    fn speculated_root_mapper_is_rejected_before_selection() {
        use rand::{rngs::StdRng, SeedableRng};
        let root = GameState { board: Board::default(), bag: EnumSet::only(Piece::I),
            reserve: Piece::I, b2b: 0, combo: 0, pending_incoming_rows: 0, due_this_lock_rows: 0 };
        let mapper = IdentityRootMapper;
        let mut rng = StdRng::seed_from_u64(5);
        assert!(matches!(
            Dag::<Value>::new(root, &[])
                .select_with_surge_root_test(true, 0.5, &mut rng, false, Some(&mapper)),
            Err(CompatError::RootAllocationDomainRejected)
        ));
    }

    #[test]
    fn legacy_root_scores_replace_matching_depth_one_children() {
        use rand::{rngs::StdRng, SeedableRng};
        let mv = |x| Placement { location: PieceLocation { piece: Piece::I,
            rotation: Rotation::North, x, y: 0 }, spin: Spin::None };
        let root = GameState { board: Board::default(), bag: EnumSet::only(Piece::I),
            reserve: Piece::I, b2b: 0, combo: 0, pending_incoming_rows: 0, due_this_lock_rows: 0 };
        let dag = Dag::<Value>::new(root, &[Piece::I]);
        let mut rng = StdRng::seed_from_u64(27);
        let selected = dag.select(false, 0.5, &mut rng).unwrap();
        let mut children = EnumMap::default();
        children[Piece::I] = vec![
            ChildData { resulting_state: GameState { combo: 1, ..root }, mv: mv(0),
                eval: Value(1), reward: 0, root_priority: false },
            ChildData { resulting_state: GameState { combo: 2, ..root }, mv: mv(1),
                eval: Value(2), reward: 0, root_priority: false },
        ];
        selected.expand(children);
        assert_eq!(dag.suggest(2), vec![(mv(1), 2.0), (mv(0), 1.0)]);

        let changed = dag.apply_legacy_root_scores(&[(mv(0), 9.0, 0), (mv(1), -3.0, 1)], |value| {
            Value(value as i32)
        });
        assert_eq!(changed, 2);
        assert_eq!(dag.suggest(2), vec![(mv(0), 9.0), (mv(1), -3.0)]);
        assert_eq!(dag.apply_legacy_root_scores(&[(mv(2), 99.0, 2)], |value| Value(value as i32)), 0);
    }

    #[test]
    fn root_scores_put_verified_moves_before_unscored_children_and_keep_f64_order() {
        use rand::{rngs::StdRng, SeedableRng};
        let mv = |x| Placement { location: PieceLocation { piece: Piece::I,
            rotation: Rotation::North, x, y: 0 }, spin: Spin::None };
        let root = GameState { board: Board::default(), bag: EnumSet::only(Piece::I),
            reserve: Piece::I, b2b: 0, combo: 0, pending_incoming_rows: 0, due_this_lock_rows: 0 };
        let dag = Dag::<Value>::new(root, &[Piece::I]);
        let mut rng = StdRng::seed_from_u64(28);
        let selected = dag.select(false, 0.5, &mut rng).unwrap();
        let mut children = EnumMap::default();
        children[Piece::I] = vec![
            ChildData { resulting_state: GameState { combo: 1, ..root }, mv: mv(0),
                eval: Value(2), reward: 0, root_priority: false },
            ChildData { resulting_state: GameState { combo: 2, ..root }, mv: mv(1),
                eval: Value(1), reward: 0, root_priority: false },
            // Represents a rejected candidate inside the prefix; it has no F14 score.
            ChildData { resulting_state: GameState { combo: 3, ..root }, mv: mv(2),
                eval: Value(100), reward: 0, root_priority: false },
            // Represents an out-of-prefix child and retains its native ordering
            // relative to other unscored children, but not relative to scored moves.
            ChildData { resulting_state: GameState { combo: 4, ..root }, mv: mv(3),
                eval: Value(200), reward: 0, root_priority: true },
        ];
        selected.expand(children);

        let lower = 1.00000001_f64;
        let higher = 1.00000002_f64;
        assert_eq!(lower as f32, higher as f32, "fixture must collide after f32 narrowing");
        let changed = dag.apply_legacy_root_scores(&[(mv(0), lower, 0), (mv(1), higher, 1)], |value| {
            Value(value as i32)
        });

        assert_eq!(changed, 2);
        assert_eq!(dag.suggest(4).into_iter().map(|(action, _)| action).collect::<Vec<_>>(),
            vec![mv(1), mv(0), mv(3), mv(2)]);
    }

    #[test]
    fn root_value_bonuses_mix_with_native_values_without_overwriting_them() {
        use rand::{rngs::StdRng, SeedableRng};
        let mv = |x| Placement { location: PieceLocation { piece: Piece::I,
            rotation: Rotation::North, x, y: 0 }, spin: Spin::None };
        let root = GameState { board: Board::default(), bag: EnumSet::only(Piece::I),
            reserve: Piece::I, b2b: 0, combo: 0, pending_incoming_rows: 0, due_this_lock_rows: 0 };
        let dag = Dag::<Value>::new(root, &[Piece::I]);
        let mut rng = StdRng::seed_from_u64(29);
        let selected = dag.select(false, 0.5, &mut rng).unwrap();
        let mut children = EnumMap::default();
        children[Piece::I] = vec![
            ChildData { resulting_state: GameState { combo: 1, ..root }, mv: mv(0),
                eval: Value(2), reward: 0, root_priority: false },
            ChildData { resulting_state: GameState { combo: 2, ..root }, mv: mv(1),
                eval: Value(1), reward: 0, root_priority: false },
            ChildData { resulting_state: GameState { combo: 3, ..root }, mv: mv(2),
                eval: Value(100), reward: 0, root_priority: false },
            ChildData { resulting_state: GameState { combo: 4, ..root }, mv: mv(3),
                eval: Value(0), reward: 0, root_priority: false },
        ];
        selected.expand(children);

        let native = vec![(mv(2), 100.0), (mv(0), 2.0), (mv(1), 1.0), (mv(3), 0.0)];
        assert_eq!(dag.suggest(4), native);
        let terms = [(mv(0), 0.0), (mv(1), 5.0)];
        assert_eq!(dag.apply_legacy_root_bonuses(&terms, 1.0).unwrap(), 2);
        assert_eq!(
            dag.suggest(4),
            vec![(mv(2), 100.0), (mv(1), 1.0), (mv(0), 2.0), (mv(3), 0.0)],
            "an unscored child competes by its native value and all reported values stay native"
        );

        assert_eq!(dag.apply_legacy_root_bonuses(&terms, 0.0).unwrap(), 2);
        assert_eq!(dag.suggest(4), native, "zero scale reproduces native ordering");
    }

    #[test]
    fn root_value_tiebreak_only_orders_exact_native_ties_without_overwriting_values() {
        use rand::SeedableRng;
        let mv = |x| Placement { location: PieceLocation { piece: Piece::I,
            rotation: Rotation::North, x, y: 0 }, spin: Spin::None };
        let root = GameState { board: Board::default(), bag: EnumSet::only(Piece::I),
            reserve: Piece::I, b2b: 0, combo: 0, pending_incoming_rows: 0, due_this_lock_rows: 0 };
        let dag = Dag::<Value>::new(root, &[Piece::I]);
        let mut rng = rand::rngs::StdRng::seed_from_u64(31);
        let selected = dag.select(false, 0.5, &mut rng).unwrap();
        let mut children = EnumMap::default();
        children[Piece::I] = vec![
            ChildData { resulting_state: GameState { combo: 1, ..root }, mv: mv(0),
                eval: Value(3), reward: 0, root_priority: false },
            ChildData { resulting_state: GameState { combo: 2, ..root }, mv: mv(1),
                eval: Value(3), reward: 0, root_priority: false },
            ChildData { resulting_state: GameState { combo: 3, ..root }, mv: mv(2),
                eval: Value(4), reward: 0, root_priority: false },
            ChildData { resulting_state: GameState { combo: 4, ..root }, mv: mv(3),
                eval: Value(3), reward: 0, root_priority: false },
            ChildData { resulting_state: GameState { combo: 5, ..root }, mv: mv(4),
                eval: Value(3), reward: 0, root_priority: false },
        ];
        selected.expand(children);

        let terms = [(mv(0), 20.0), (mv(1), 500.0), (mv(2), -50_000.0)];
        assert_eq!(dag.apply_legacy_root_tiebreaks(&terms).unwrap(), 3);
        let suggestions = dag.suggest(5);
        assert_eq!(suggestions.iter().map(|(action, _)| *action).collect::<Vec<_>>(),
            vec![mv(2), mv(1), mv(0), mv(3), mv(4)],
            "native value leads; tied terms decide; unscored ties follow in native order");
        assert_eq!(suggestions.into_iter().map(|(_, value)| value).collect::<Vec<_>>(),
            vec![4.0, 3.0, 3.0, 3.0, 3.0],
            "the ordering term never changes reported native values");
    }

    #[test]
    fn root_priority_orders_selection_and_suggestion_without_entering_shared_values() {
        use rand::{SeedableRng, rngs::StdRng};
        let mv = |x| Placement { location: PieceLocation { piece: Piece::I,
            rotation: Rotation::North, x, y: 0 }, spin: Spin::None };
        let root = GameState { board: Board::default(), bag: EnumSet::only(Piece::I),
            reserve: Piece::I, b2b: 0, combo: 0, pending_incoming_rows: 0, due_this_lock_rows: 0 };
        for priorities in [[false, false, false], [true, true, true], [true, true, false]] {
            let mut parent = LayerCommon::<Value>::default();
            let mut child = LayerCommon::<Value>::default();
            let grandchild = LayerCommon::<Value>::default();
            parent.kind.despeculate(Piece::I);
            child.kind.despeculate(Piece::I);
            parent.kind.initialize_root(&root);
            let states: Vec<_> = (1..=3).map(|combo| GameState { combo, ..root }).collect();
            let mut edges = EnumMap::default();
            edges[Piece::I] = (0..3).map(|i| ChildData { resulting_state: states[i],
                mv: mv(i as i8), eval: Value([10, 9, 100][i]), reward: 0, root_priority: priorities[i] }).collect();
            parent.kind.expand(&child, root, edges);
            let moves = || parent.kind.suggest(&root, 3).into_iter().map(|(m, _)| m).collect::<Vec<_>>();
            assert_eq!(moves(), if priorities[0] && !priorities[2] { vec![mv(0),mv(1),mv(2)] } else { vec![mv(2),mv(0),mv(1)] });
            // Shared-node values have no root-priority band or added numeric reward.
            child.kind.with(|this| match this.data {
                LayerKind::Known(layer) => assert_eq!(layer.states.get(&states[0]).unwrap().eval.0, 10),
                _ => unreachable!(),
            });
            // Drop old best; then raise an unsafe edge. Both use the real backup path.
            for (index, value) in [(0, 8), (2, 200), (0, 9)] {
                let mut deeper = EnumMap::default();
                deeper[Piece::I] = vec![ChildData { resulting_state: GameState { combo: 10 + index as u8, b2b: value as u32, ..root },
                    mv: mv(5), eval: Value(value), reward: 0, root_priority: false }];
                let updates = child.kind.expand(&grandchild, states[index], deeper);
                parent.kind.backprop(updates, &child);
            }
            let expected = if priorities[0] && !priorities[2] { vec![mv(1),mv(0),mv(2)] } else { vec![mv(2),mv(1),mv(0)] };
            assert_eq!(moves(), expected); // exact ties preserve current stable order
            let mut rng = StdRng::seed_from_u64(42);
            let mut oracle_rng = StdRng::seed_from_u64(42);
            for _ in 0..64 {
                let index = rank_index(rand::Rng::gen(&mut oracle_rng), 0.5, 3);
                match parent.kind.select(&root, true, 0.5, &mut rng, None) {
                    SelectResult::Advance(_, selected, _, _) => assert_eq!(selected, expected[index]),
                    _ => panic!("expanded root must select from its stored order"),
                }
            }
        }
    }

    #[test]
    fn tank_edge_cost_survives_shared_child_expansion_in_both_layer_kinds() {
        for known in [true, false] {
            let mut parent = LayerCommon::<Value>::default();
            let mut child = LayerCommon::<Value>::default();
            let grandchild = LayerCommon::<Value>::default();
            if known { parent.kind.despeculate(Piece::I); child.kind.despeculate(Piece::I); }
            let root = GameState { board: Board::default(), bag: EnumSet::only(Piece::I),
                reserve: Piece::I, b2b: 0, combo: 0, pending_incoming_rows: 0, due_this_lock_rows: 0 };
            let shared = GameState { combo: 1, ..root };
            let leaf = GameState { combo: 2, ..root };
            let mv = |x| Placement { location: PieceLocation { piece: Piece::I,
                rotation: Rotation::North, x, y: 0 }, spin: Spin::None };
            parent.kind.initialize_root(&root);
            let mut edges = EnumMap::default();
            edges[Piece::I] = vec![
                ChildData { resulting_state: shared, mv: mv(3), eval: Value(100), reward: -15, root_priority: false },
                ChildData { resulting_state: shared, mv: mv(4), eval: Value(100), reward: -7, root_priority: false },
            ];
            parent.kind.expand(&child, root, edges);
            let scores = || parent.kind.with(|this| match this.data {
                LayerKind::Known(layer) => layer.states.get(&root).unwrap().children.as_ref().unwrap()
                    .iter().map(|c| (c.mv, c.cached_eval.value())).collect::<Vec<_>>(),
                LayerKind::Speculated(layer) => layer.states.get(&root).unwrap().children.as_ref().unwrap()[Piece::I]
                    .iter().map(|c| (c.mv, c.cached_eval.value())).collect::<Vec<_>>(),
            });
            assert_eq!(scores(), vec![(mv(4), 93.0), (mv(3), 85.0)]);
            let mut deeper = EnumMap::default();
            deeper[Piece::I] = vec![ChildData { resulting_state: leaf, mv: mv(5), eval: Value(200), reward: 0, root_priority: false }];
            let updates = child.kind.expand(&grandchild, shared, deeper);
            parent.kind.backprop(updates, &child);
            assert_eq!(scores(), vec![(mv(4), 193.0), (mv(3), 185.0)]);
        }
    }
}
