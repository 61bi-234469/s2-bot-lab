use std::convert::TryInto;
use std::hash::BuildHasher;
use std::hash::Hash;
use std::hash::Hasher;

use nohash::IntMap;
use parking_lot::MappedRwLockReadGuard;
use parking_lot::MappedRwLockWriteGuard;
use parking_lot::RwLock;
use parking_lot::RwLockReadGuard;
use parking_lot::RwLockWriteGuard;

use crate::data::GameState;

pub trait StateKey: Copy + Eq + Hash {
    const EXACT: bool;
}
impl StateKey for GameState { const EXACT: bool = false; }
impl StateKey for crate::s2_core::State { const EXACT: bool = true; }

/// S2 indexes compare full keys within a hash bucket. Handles are local to this
/// request's actual-lock layer. Legacy continues to address values by hash.
struct ExactIndex<K> {
    buckets: IntMap<u64, Vec<u64>>,
    keys: Vec<K>,
}
impl<K> Default for ExactIndex<K> {
    fn default() -> Self { Self { buckets: IntMap::default(), keys: vec![] } }
}

pub struct StateMap<V, S = ahash::RandomState, K: StateKey = GameState> {
    hasher: S,
    buckets: Box<[RwLock<IntMap<u64, V>>; SHARDS]>,
    exact: Option<RwLock<ExactIndex<K>>>,
}

const SHARD_INDEX_BITS: usize = 12;
const SHARD_INDEX_SHIFT: usize = 32;
const SHARDS: usize = 1 << SHARD_INDEX_BITS;

impl<V, S: Default, K: StateKey> Default for StateMap<V, S, K> {
    fn default() -> Self {
        StateMap {
            hasher: Default::default(),
            exact: K::EXACT.then(|| RwLock::new(ExactIndex::default())),
            buckets: std::iter::repeat_with(|| RwLock::new(IntMap::default()))
                .take(SHARDS)
                .collect::<Box<_>>()
                .try_into()
                .unwrap_or_else(|_| unreachable!()),
        }
    }
}

impl<V, S: BuildHasher, K: StateKey> StateMap<V, S, K> {
    fn hash(&self, k: &K) -> u64 {
        let mut hasher = self.hasher.build_hasher();
        k.hash(&mut hasher);
        hasher.finish()
    }

    pub fn index(&self, k: &K) -> u64 {
        let hash = self.hash(k);
        let Some(exact) = &self.exact else { return hash; };
        let mut index = exact.write();
        if let Some(id) = index.buckets.get(&hash).and_then(|bucket|
            bucket.iter().find_map(|id| (index.keys[*id as usize] == *k).then_some(*id))) { return id; }
        let id = u64::try_from(index.keys.len()).expect("state index capacity must fit u64");
        index.keys.push(*k);
        index.buckets.entry(hash).or_default().push(id);
        id
    }

    pub fn key(&self, id: u64) -> Option<K> {
        self.exact.as_ref()?.read().keys.get(usize::try_from(id).ok()?).copied()
    }

    /// Explicit index allocation estimate, separate from node/edge arenas/RSS.
    pub fn exact_stats(&self) -> (usize, usize, usize) {
        let Some(exact) = &self.exact else { return (0, 0, 0); };
        let index = exact.read();
        let bytes = index.keys.capacity() * std::mem::size_of::<K>()
            + index.buckets.capacity() * std::mem::size_of::<(u64, Vec<u64>)>()
            + index.buckets.values().map(|b| b.capacity() * std::mem::size_of::<u64>()).sum::<usize>();
        (index.keys.len(), index.buckets.capacity(), bytes)
    }

    /// Conservative capacity estimate, not allocator bytes or process RSS.
    pub fn storage_estimate_bytes(&self) -> usize {
        let (keys,_,index_bytes)=self.exact_stats();
        // S2 handles are dense: only these shards can contain indexed values.
        let used = if K::EXACT {
            (((keys as u64).saturating_sub(1) >> SHARD_INDEX_SHIFT)
                .saturating_add(1)
                .min(SHARDS as u64)) as usize
        } else {
            SHARDS
        };
        std::mem::size_of::<Self>()+std::mem::size_of_val(&*self.buckets)+index_bytes*2
            +self.buckets.iter().take(used).map(|b|b.read().capacity()*(std::mem::size_of::<(u64,V)>()+16)*2).sum::<usize>()
    }
    pub fn shard_storage_bytes() -> usize {
        std::mem::size_of::<Self>()+std::mem::size_of::<[RwLock<IntMap<u64,V>>;SHARDS]>()
    }

    fn bucket(&self, k: u64) -> &RwLock<IntMap<u64, V>> {
        &self.buckets[(k >> SHARD_INDEX_SHIFT) as usize % SHARDS]
    }

    pub fn get_raw(&self, k: u64) -> Option<MappedRwLockReadGuard<V>> {
        RwLockReadGuard::try_map(self.bucket(k).read(), |shard| shard.get(&k)).ok()
    }

    pub fn get(&self, k: &K) -> Option<MappedRwLockReadGuard<V>> {
        let hash = self.hash(k);
        let id = if let Some(exact) = &self.exact {
            let index = exact.read();
            index.buckets.get(&hash)?.iter().find_map(|id| (index.keys[*id as usize] == *k).then_some(*id))?
        } else { hash };
        self.get_raw(id)
    }

    pub fn get_raw_mut(&self, k: u64) -> Option<MappedRwLockWriteGuard<V>> {
        RwLockWriteGuard::try_map(self.bucket(k).write(), |shard| shard.get_mut(&k)).ok()
    }

    pub fn get_raw_or_insert_with(
        &self,
        k: u64,
        f: impl FnOnce() -> V,
    ) -> MappedRwLockWriteGuard<V> {
        RwLockWriteGuard::map(self.bucket(k).write(), |shard| {
            shard.entry(k).or_insert_with(f)
        })
    }

    pub fn get_or_insert_with(
        &self,
        k: &K,
        f: impl FnOnce() -> V,
    ) -> MappedRwLockWriteGuard<V> {
        self.get_raw_or_insert_with(self.index(k), f)
    }
    pub fn map_values<T>(self, f: impl Fn(V) -> T) -> StateMap<T, S, K> {
        StateMap {
            hasher: self.hasher,
            exact: self.exact,
            buckets: self
                .buckets
                .into_iter()
                .map(|shard| {
                    RwLock::new(
                        shard
                            .into_inner()
                            .into_iter()
                            .map(|(k, v)| (k, f(v)))
                            .collect(),
                    )
                })
                .collect::<Box<_>>()
                .try_into()
                .unwrap_or_else(|_| unreachable!()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::s2_core::{State, Horizon};
    use crate::data::{Board, Piece};
    use crate::native_s2::{Chain, Incoming};
    #[derive(Default)] struct Collide;
    impl Hasher for Collide { fn write(&mut self, _: &[u8]) {} fn finish(&self) -> u64 { 7 } }
    #[test]
    fn exact_collisions_reuse_only_equal_keys_and_survive_growth() {
        let map: StateMap<u32, std::hash::BuildHasherDefault<Collide>, State> = StateMap::default();
        let state = State { board: Board::default(), materialized_g: Board::default(), current: Some(Piece::T),
            hold: None, hold_available: true, known_cursor: 0, chain: Chain {combo:0,b2b:0},
            incoming: Incoming {pending_rows:0,due_this_lock_rows:0}, phantom_rows:0, horizon:Horizon::Open };
        for combo in 0..300 {
            let key = State { chain: Chain {combo,b2b:256}, ..state };
            *map.get_or_insert_with(&key, || combo) += 1;
            assert_eq!(map.key(map.index(&key)), Some(key));
        }
        for combo in 0..300 {
            let key = State { chain: Chain {combo,b2b:256}, ..state };
            assert_eq!(*map.get(&key).unwrap(), combo + 1);
            assert_eq!(map.index(&key), u64::from(combo));
        }
        let zero = State { chain: Chain {combo:0,b2b:256}, ..state };
        let phantom = State { chain: Chain {combo:0,b2b:256}, phantom_rows:1, ..state };
        *map.get_or_insert_with(&phantom, || 7) += 1;
        assert_ne!(map.index(&zero), map.index(&phantom));
        assert_eq!(map.key(map.index(&phantom)), Some(phantom));
        assert!(map.get(&state).is_none()); // reads must not allocate unknown keys
        assert_eq!(map.exact_stats().0,301);
        let mapped = map.map_values(|v| v * 2);
        assert_eq!(*mapped.get_raw(255).unwrap(),512);
        assert_eq!(mapped.exact_stats().0,301);
        assert!(mapped.exact_stats().2 >= 301 * std::mem::size_of::<State>());
    }

    #[test]
    fn exact_storage_estimate_handles_a_small_map_without_32_bit_shift() {
        let map: StateMap<u32, std::collections::hash_map::RandomState, State> = StateMap::default();
        let empty = map.storage_estimate_bytes();
        let state = State {
            board: Board::default(),
            materialized_g: Board::default(),
            current: Some(Piece::T),
            hold: None,
            hold_available: true,
            known_cursor: 0,
            chain: Chain { combo: 0, b2b: 0 },
            incoming: Incoming { pending_rows: 0, due_this_lock_rows: 0 },
            phantom_rows: 0,
            horizon: Horizon::Open,
        };
        let _ = map.get_or_insert_with(&state, || 1);
        assert!(map.storage_estimate_bytes() >= empty);
        assert_eq!(map.exact_stats().0, 1);
    }
}
