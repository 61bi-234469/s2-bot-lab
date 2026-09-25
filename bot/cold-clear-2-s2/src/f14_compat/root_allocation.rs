//! Pure root-allocation primitives for the Legacy F14 path.
//!
//! This module deliberately has no DAG/search side effects.  It owns the
//! request-local snapshot identity, facts memoization, and the accepted-first
//! permutation of the root-allocation design.  Keeping these values pure
//! makes the OFF path and its equivalence tests easy to audit.

use std::collections::HashMap;
use std::mem::size_of;
use std::sync::Arc;

use crate::data::Placement;

use super::prefix::CanonicalPlacement;
use super::{selection_score, CompatError, RankedCandidate};

pub(crate) const PREFIX_VIEW_SCHEMA: &str = "f14-root-prefix-view/v1";
pub(crate) const ALLOCATION_MODE: &str = "conversion-permutation-v1";
pub(crate) const ROOT_VALUE_MODE: &str = "f14-core-allspin-rootvalue/1";
pub(crate) const ROOT_VALUE_MIX_MODE: &str = "root-value-mix-v1";
pub(crate) const ROOT_VALUE_TIEBREAK_MODE: &str = "root-value-tiebreak-v1";
pub(crate) const LEAF_CONVERSION_MODE: &str = "leaf-conversion-v1";
pub(crate) const LEAF_CONVERSION_GATED_MODE: &str = "leaf-conversion-gated-v1";
pub(crate) const PREFIX_LIMIT: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RootSnapshotBinding {
    pub(crate) request_epoch: u64,
    pub(crate) public_context_digest: [u8; 32],
    pub(crate) root_revision: u64,
    pub(crate) raw_count: usize,
    pub(crate) prefix_actions: Vec<Placement>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PrefixViewSignature {
    pub(crate) schema: &'static str,
    pub(crate) request_epoch: u64,
    pub(crate) public_context_digest: [u8; 32],
    pub(crate) allocation_mode: &'static str,
    pub(crate) prefix_limit: usize,
    pub(crate) raw_count: usize,
    pub(crate) k: usize,
    pub(crate) prefix_identities: Vec<Arc<str>>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RootCandidateFacts {
    pub(crate) raw_index: usize,
    pub(crate) action: Placement,
    pub(crate) identity: Arc<str>,
    pub(crate) placement: CanonicalPlacement,
    pub(crate) ranked: RankedCandidate,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RootRejectedFacts {
    pub(crate) raw_index: usize,
    pub(crate) action: Placement,
    pub(crate) identity: Arc<str>,
    pub(crate) reason: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RootCachedFacts {
    Ready(RootCandidateFacts),
    Rejected(RootRejectedFacts),
}

impl RootCandidateFacts {
    pub(crate) fn rebase_snapshot(
        &mut self,
        raw_index: usize,
        action: Placement,
        identity: Arc<str>,
    ) {
        self.raw_index = raw_index;
        self.action = action;
        self.identity = Arc::clone(&identity);
        self.ranked.cc2_rank = raw_index as i32;
        self.ranked.identity = identity.to_string();
        self.ranked.selection_score = selection_score(
            self.ranked.s2_score,
            self.ranked.conversion.units,
            raw_index as i32,
        );
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RootPrefixView {
    pub(crate) signature: PrefixViewSignature,
    pub(crate) binding: RootSnapshotBinding,
    pub(crate) ranked_prefix_indices: Vec<u32>,
    pub(crate) rejected_prefix_indices: Vec<u32>,
    pub(crate) permutation: Vec<u32>,
    pub(crate) m: usize,
    pub(crate) facts: Vec<RootCandidateFacts>,
}

#[derive(Default, Debug)]
pub(crate) struct RootCandidateFactsCache {
    identities: HashMap<Placement, Arc<str>>,
    entries: HashMap<Placement, RootCachedFacts>,
}

impl RootCandidateFactsCache {
    pub(crate) fn clear(&mut self) {
        self.identities.clear();
        self.entries.clear();
    }

    pub(crate) fn get(&self, action: &Placement) -> Option<&RootCandidateFacts> {
        match self.entries.get(action) {
            Some(RootCachedFacts::Ready(facts)) => Some(facts),
            _ => None,
        }
    }

    pub(crate) fn get_rejected(&self, action: &Placement) -> Option<&RootRejectedFacts> {
        match self.entries.get(action) {
            Some(RootCachedFacts::Rejected(facts)) => Some(facts),
            _ => None,
        }
    }

    pub(crate) fn identity(&self, action: &Placement) -> Option<&Arc<str>> {
        self.identities.get(action)
    }

    pub(crate) fn remember_identity(&mut self, action: Placement, identity: Arc<str>) {
        self.identities.insert(action, identity);
    }

    pub(crate) fn insert(&mut self, facts: RootCandidateFacts) {
        self.identities.insert(facts.action, Arc::clone(&facts.identity));
        self.entries.insert(facts.action, RootCachedFacts::Ready(facts));
    }

    pub(crate) fn insert_rejected(&mut self, facts: RootRejectedFacts) {
        self.identities.insert(facts.action, Arc::clone(&facts.identity));
        self.entries.insert(facts.action, RootCachedFacts::Rejected(facts));
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn identities_len(&self) -> usize {
        self.identities.len()
    }

    /// Conservative, explicit in-process estimate of the cache footprint.
    /// This counts the HashMap payloads and owned identity/rejection strings;
    /// it is intentionally derived from the live entries rather than from a
    /// miss counter or a fixed multiplier.
    pub(crate) fn estimated_bytes(&self) -> usize {
        let identity_bytes: usize = self
            .identities
            .iter()
            .map(|(placement, identity)| size_of::<(Placement, Arc<str>)>() + placement_string_bytes(placement) + identity.len())
            .sum();
        let entry_bytes: usize = self
            .entries
            .values()
            .map(|entry| {
                size_of::<(Placement, RootCachedFacts)>()
                    + match entry {
                        RootCachedFacts::Ready(facts) => {
                            size_of::<RootCandidateFacts>()
                                + facts.identity.len()
                                + facts.ranked.identity.len()
                        }
                        RootCachedFacts::Rejected(facts) => {
                            size_of::<RootRejectedFacts>()
                                + facts.identity.len()
                                + facts.reason.len()
                        }
                    }
            })
            .sum();
        identity_bytes.saturating_add(entry_bytes)
    }
}

fn placement_string_bytes(placement: &Placement) -> usize {
    // Placement is a compact value type today; keep this helper explicit so
    // the estimate remains auditable if its shape changes.
    size_of::<Placement>() + format!("{:?}", placement.location.piece).len()
}

impl RootSnapshotBinding {
    pub(crate) fn new(
        request_epoch: u64,
        public_context_digest: [u8; 32],
        root_revision: u64,
        actions: &[Placement],
    ) -> Self {
        let raw_count = actions.len();
        let k = raw_count.min(PREFIX_LIMIT);
        Self {
            request_epoch,
            public_context_digest,
            root_revision,
            raw_count,
            prefix_actions: actions[..k].to_vec(),
        }
    }
}

impl PrefixViewSignature {
    pub(crate) fn new(
        binding: &RootSnapshotBinding,
        identities: &[Arc<str>],
    ) -> Self {
        Self::new_with_mode(binding, identities, ALLOCATION_MODE)
    }

    pub(crate) fn new_with_mode(
        binding: &RootSnapshotBinding,
        identities: &[Arc<str>],
        mode: &'static str,
    ) -> Self {
        let k = binding.raw_count.min(PREFIX_LIMIT);
        Self {
            schema: PREFIX_VIEW_SCHEMA,
            request_epoch: binding.request_epoch,
            public_context_digest: binding.public_context_digest,
            allocation_mode: mode,
            prefix_limit: PREFIX_LIMIT,
            raw_count: binding.raw_count,
            k,
            prefix_identities: identities[..k].to_vec(),
        }
    }
}

impl RootPrefixView {
    /// Build P from facts that have already passed the existing F14 prefix
    /// verifier.  The native prefix order is retained for rejected entries and
    /// for the identity tail; only the accepted prefix is ranked by U.
    pub(crate) fn build(
        binding: RootSnapshotBinding,
        identities: Vec<Arc<str>>,
        accepted: Vec<RootCandidateFacts>,
        rejected: Vec<u32>,
    ) -> Result<Self, CompatError> {
        Self::build_with_mode(binding, identities, accepted, rejected, ALLOCATION_MODE)
    }

    pub(crate) fn build_with_mode(
        binding: RootSnapshotBinding,
        identities: Vec<Arc<str>>,
        mut accepted: Vec<RootCandidateFacts>,
        mut rejected: Vec<u32>,
        mode: &'static str,
    ) -> Result<Self, CompatError> {
        let k = binding.raw_count.min(PREFIX_LIMIT);
        if binding.prefix_actions.len() != k || identities.len() < k {
            return Err(CompatError::RootAllocationBindingMismatch);
        }
        if accepted.is_empty() {
            return Err(CompatError::NoVerifiableCandidate);
        }
        accepted.sort_by(|left, right| {
            right
                .ranked
                .selection_score
                .partial_cmp(&left.ranked.selection_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(left.ranked.cc2_rank.cmp(&right.ranked.cc2_rank))
                .then(left.identity.as_ref().cmp(right.identity.as_ref()))
        });
        rejected.sort_unstable();
        rejected.dedup();
        let ranked_prefix_indices: Vec<u32> = accepted
            .iter()
            .map(|candidate| candidate.raw_index as u32)
            .collect();
        if accepted.iter().any(|candidate| candidate.raw_index >= k)
            || rejected.iter().any(|&index| index as usize >= k)
        {
            return Err(CompatError::RootAllocationBindingMismatch);
        }
        let m = ranked_prefix_indices.len();
        let mut permutation = ranked_prefix_indices.clone();
        permutation.extend(rejected.iter().copied());
        permutation.extend((k..binding.raw_count).map(|index| index as u32));
        if permutation.len() != binding.raw_count {
            return Err(CompatError::RootAllocationBindingMismatch);
        }
        let mut seen = vec![false; binding.raw_count];
        for &index in &permutation {
            let index = index as usize;
            if index >= binding.raw_count || std::mem::replace(&mut seen[index], true) {
                return Err(CompatError::RootAllocationBindingMismatch);
            }
        }
        if permutation.iter().enumerate().any(|(index, &mapped)|
            index >= k && mapped as usize != index
        ) {
                return Err(CompatError::RootAllocationBindingMismatch);
        }
        Ok(Self {
            signature: PrefixViewSignature::new_with_mode(&binding, &identities, mode),
            binding,
            ranked_prefix_indices,
            rejected_prefix_indices: rejected,
            permutation,
            m,
            facts: accepted,
        })
    }

    pub(crate) fn rebind(&mut self, binding: RootSnapshotBinding) -> Result<(), CompatError> {
        if self.signature.request_epoch != binding.request_epoch
            || self.signature.public_context_digest != binding.public_context_digest
            || self.signature.raw_count != binding.raw_count
            || binding.prefix_actions.len() != self.signature.k
            || self.binding.prefix_actions != binding.prefix_actions
        {
            return Err(CompatError::RootAllocationBindingMismatch);
        }
        self.binding = binding;
        Ok(())
    }

    pub(crate) fn selected_index(&self, draw_index: usize) -> Option<usize> {
        self.permutation.get(draw_index).copied().map(|index| index as usize)
    }

    pub(crate) fn local_ablation(&self, native_index: usize) -> RootLocalAblation {
        if self.m == 0 || native_index >= self.binding.raw_count {
            return RootLocalAblation {
                status: "unavailable".to_owned(),
                native_index: Some(native_index),
                accepted_first_index: None,
                c_zero_index: None,
                full_index: None,
                prefix_outside_identity: native_index >= self.signature.k,
                prefix_outside_violation: false,
                acceptance_changed: false,
                generic_changed: false,
                conversion_changed: false,
                composed_route_changed: false,
            };
        }
        let mut accepted_native = self.facts.clone();
        accepted_native.sort_by_key(|facts| facts.raw_index);
        let mut accepted_first = accepted_native
            .iter()
            .map(|facts| facts.raw_index)
            .collect::<Vec<_>>();
        accepted_first.extend(self.rejected_prefix_indices.iter().map(|&index| index as usize));
        accepted_first.extend(self.signature.k..self.binding.raw_count);
        let mut c_zero = self.facts.clone();
        c_zero.sort_by(|left, right| {
            selection_score(right.ranked.s2_score, 0.0, right.raw_index as i32)
                .partial_cmp(&selection_score(left.ranked.s2_score, 0.0, left.raw_index as i32))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(left.raw_index.cmp(&right.raw_index))
        });
        let mut c_zero_order = c_zero.iter().map(|facts| facts.raw_index).collect::<Vec<_>>();
        c_zero_order.extend(self.rejected_prefix_indices.iter().map(|&index| index as usize));
        c_zero_order.extend(self.signature.k..self.binding.raw_count);
        let accepted_first_index = accepted_first.get(native_index).copied();
        let c_zero_index = c_zero_order.get(native_index).copied();
        let full_index = self.selected_index(native_index);
        let prefix_outside_identity = native_index >= self.signature.k;
        let prefix_outside_violation = accepted_first
            .iter()
            .enumerate()
            .any(|(index, &mapped)| index >= self.signature.k && mapped != index)
            || c_zero_order
                .iter()
                .enumerate()
                .any(|(index, &mapped)| index >= self.signature.k && mapped != index)
            || self
                .permutation
                .iter()
                .enumerate()
                .any(|(index, &mapped)| index >= self.signature.k && mapped as usize != index);
        RootLocalAblation {
            status: "ready".to_owned(),
            native_index: Some(native_index),
            accepted_first_index,
            c_zero_index,
            full_index,
            prefix_outside_identity,
            prefix_outside_violation,
            acceptance_changed: accepted_first_index != Some(native_index),
            generic_changed: c_zero_index != accepted_first_index,
            conversion_changed: full_index != c_zero_index,
            composed_route_changed: full_index != Some(native_index),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RootLocalAblation {
    pub(crate) status: String,
    pub(crate) native_index: Option<usize>,
    pub(crate) accepted_first_index: Option<usize>,
    pub(crate) c_zero_index: Option<usize>,
    pub(crate) full_index: Option<usize>,
    pub(crate) prefix_outside_identity: bool,
    pub(crate) prefix_outside_violation: bool,
    pub(crate) acceptance_changed: bool,
    pub(crate) generic_changed: bool,
    pub(crate) conversion_changed: bool,
    pub(crate) composed_route_changed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{Piece, PieceLocation, Rotation, Spin};
    use crate::f14_compat::{Conversion, ConversionBranch};

    fn action(x: i8) -> Placement {
        Placement {
            location: PieceLocation { piece: Piece::T, rotation: Rotation::North, x, y: 0 },
            spin: Spin::None,
        }
    }

    fn facts(raw_index: usize, action: Placement, score: f64) -> RootCandidateFacts {
        RootCandidateFacts {
            raw_index,
            action,
            identity: Arc::from(format!("id-{raw_index}")),
            placement: CanonicalPlacement {
                piece: "T".to_owned(),
                rotation: "spawn".to_owned(),
                x: raw_index as i32,
                y: 0,
                used_hold: false,
            },
            ranked: RankedCandidate {
                cc2_rank: raw_index as i32,
                identity: format!("id-{raw_index}"),
                s2_score: score,
                conversion: Conversion { branch: ConversionBranch::Other, units: 0.0, qualifies: false },
                solvency: 0.0,
                solvent: true,
                selection_score: score,
            },
        }
    }

    #[test]
    fn accepted_first_permutation_preserves_tail_and_is_a_bijection() {
        let actions = vec![action(0), action(1), action(2), action(3), action(4)];
        let binding = RootSnapshotBinding::new(7, [3; 32], 11, &actions);
        let ids = (0..actions.len()).map(|i| Arc::from(format!("id-{i}"))).collect();
        let view = RootPrefixView::build(
            binding,
            ids,
            vec![facts(2, actions[2], 5.0), facts(0, actions[0], 3.0)],
            vec![1, 3, 4],
        ).unwrap();
        assert_eq!(view.permutation, vec![2, 0, 1, 3, 4]);
        assert_eq!(view.m, 2);
        assert!(view.permutation.iter().enumerate().all(|(i, &v)| i >= 3 || (v as usize) < 5));
    }

    #[test]
    fn exact_signature_ignores_revision_but_rebinds_it() {
        let actions = vec![action(0), action(1)];
        let binding = RootSnapshotBinding::new(2, [8; 32], 1, &actions);
        let ids = vec![Arc::from("a"), Arc::from("b")];
        let mut view = RootPrefixView::build(binding, ids, vec![facts(0, actions[0], 1.0)], vec![1]).unwrap();
        let signature = view.signature.clone();
        view.rebind(RootSnapshotBinding::new(2, [8; 32], 99, &actions)).unwrap();
        assert_eq!(view.signature, signature);
        assert_eq!(view.binding.root_revision, 99);
    }

    #[test]
    fn rebind_rejects_a_changed_prefix_action_even_when_counts_match() {
        let actions = vec![action(0), action(1)];
        let binding = RootSnapshotBinding::new(2, [8; 32], 1, &actions);
        let ids = vec![Arc::from("a"), Arc::from("b")];
        let mut view = RootPrefixView::build(
            binding,
            ids,
            vec![facts(0, actions[0], 1.0)],
            vec![1],
        ).unwrap();
        let replacement = vec![action(3), action(1)];
        let error = view
            .rebind(RootSnapshotBinding::new(2, [8; 32], 2, &replacement))
            .unwrap_err();
        assert_eq!(error, CompatError::RootAllocationBindingMismatch);
        assert_eq!(view.binding.root_revision, 1);
    }

    #[test]
    fn cache_keys_keep_same_pose_actions_separate() {
        let mut cache = RootCandidateFactsCache::default();
        cache.insert(facts(0, action(0), 1.0));
        cache.insert(facts(1, action(1), 2.0));
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.identities_len(), 2);
    }

    #[test]
    fn cached_facts_rebase_snapshot_local_index_and_identity() {
        let mut cached = facts(7, action(7), 1.0);
        cached.ranked.s2_score = 100.0;
        cached.ranked.conversion.units = 1.0;
        cached.rebase_snapshot(0, action(0), Arc::from("id-0"));
        assert_eq!(cached.raw_index, 0);
        assert_eq!(cached.action, action(0));
        assert_eq!(cached.identity.as_ref(), "id-0");
        assert_eq!(cached.ranked.cc2_rank, 0);
        assert_eq!(cached.ranked.identity, "id-0");
        assert_eq!(cached.ranked.selection_score, selection_score(100.0, 1.0, 0));
        cached.rebase_snapshot(1, action(1), Arc::from("id-1"));
        assert_eq!(cached.ranked.selection_score, selection_score(100.0, 1.0, 1));
        assert_ne!(cached.ranked.selection_score, selection_score(100.0, 1.0, 0));
    }

    #[test]
    fn permutation_handles_short_and_long_raw_roots_with_identity_tail() {
        for raw_count in [1usize, 2, 16, 40, 120] {
            let actions: Vec<_> = (0..raw_count)
                .map(|index| action((index % 120) as i8))
                .collect();
            let binding = RootSnapshotBinding::new(4, [9; 32], 3, &actions);
            let ids: Vec<Arc<str>> = (0..raw_count)
                .map(|index| Arc::from(format!("id-{index}")))
                .collect();
            let accepted: Vec<_> = actions
                .iter()
                .enumerate()
                .take(raw_count.min(PREFIX_LIMIT))
                .map(|(index, &mv)| facts(index, mv, index as f64))
                .collect();
            let view = RootPrefixView::build(binding, ids, accepted, Vec::new()).unwrap();
            assert_eq!(view.permutation.len(), raw_count);
            let mut sorted = view.permutation.clone();
            sorted.sort_unstable();
            assert_eq!(sorted, (0..raw_count as u32).collect::<Vec<_>>());
            assert!(view.permutation.iter().enumerate().all(|(index, &mapped)| {
                index < raw_count.min(PREFIX_LIMIT) || mapped as usize == index
            }));
        }
    }

    #[test]
    fn all_rejected_prefix_has_no_permutation_or_draw_candidate() {
        let actions = vec![action(0), action(1), action(2)];
        let binding = RootSnapshotBinding::new(5, [2; 32], 0, &actions);
        let ids = (0..actions.len()).map(|i| Arc::from(format!("id-{i}"))).collect();
        let error = RootPrefixView::build(binding, ids, Vec::new(), vec![0, 1, 2]).unwrap_err();
        assert_eq!(error, CompatError::NoVerifiableCandidate);
    }

    #[test]
    fn local_ablation_reports_hand_calculated_conversion_effect_without_rng() {
        let actions = vec![action(0), action(1)];
        let binding = RootSnapshotBinding::new(8, [4; 32], 0, &actions);
        let ids = vec![Arc::from("id-0"), Arc::from("id-1")];
        let mut first = facts(0, actions[0], 0.0);
        first.ranked.conversion.units = 0.0;
        first.ranked.selection_score = selection_score(0.0, 0.0, 0);
        let mut second = facts(1, actions[1], -1.0);
        second.ranked.conversion.units = 2.0;
        second.ranked.selection_score = selection_score(-1.0, 2.0, 1);
        let view = RootPrefixView::build(binding, ids, vec![first, second], Vec::new()).unwrap();
        let ablation = view.local_ablation(0);
        assert_eq!(ablation.accepted_first_index, Some(0));
        assert_eq!(ablation.c_zero_index, Some(0));
        assert_eq!(ablation.full_index, Some(1));
        assert!(!ablation.acceptance_changed);
        assert!(!ablation.generic_changed);
        assert!(ablation.conversion_changed);
        assert!(ablation.composed_route_changed);
        assert!(!ablation.prefix_outside_identity);
    }

    #[test]
    fn local_ablation_indexes_complete_rejected_and_tail_permutations() {
        let actions = (0..18).map(action).collect::<Vec<_>>();
        let binding = RootSnapshotBinding::new(9, [5; 32], 0, &actions);
        let ids = (0..actions.len()).map(|i| Arc::from(format!("id-{i}"))).collect();
        let mut first = facts(1, actions[1], 20.0);
        first.ranked.selection_score = selection_score(20.0, 0.0, 1);
        let mut second = facts(3, actions[3], 10.0);
        second.ranked.selection_score = selection_score(10.0, 0.0, 3);
        let rejected = (0..16).filter(|index| *index != 1 && *index != 3).map(|index| index as u32).collect();
        let view = RootPrefixView::build(binding, ids, vec![first, second], rejected).unwrap();
        let expected = std::iter::once(1)
            .chain(std::iter::once(3))
            .chain((0..16).filter(|index| *index != 1 && *index != 3))
            .chain(16..18)
            .collect::<Vec<_>>();
        assert_eq!(view.permutation, expected);
        let rejected_slot = view.local_ablation(2);
        assert_eq!(rejected_slot.accepted_first_index, Some(0));
        assert_eq!(rejected_slot.c_zero_index, Some(0));
        assert_eq!(rejected_slot.full_index, Some(0));
        assert!(!rejected_slot.prefix_outside_violation);
        let tail_slot = view.local_ablation(16);
        assert_eq!(tail_slot.accepted_first_index, Some(16));
        assert_eq!(tail_slot.c_zero_index, Some(16));
        assert_eq!(tail_slot.full_index, Some(16));
        assert!(tail_slot.prefix_outside_identity);
        assert!(!tail_slot.prefix_outside_violation);
    }
}
