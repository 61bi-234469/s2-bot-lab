//! Spike-stress beam search with exact S2 garbage.
//!
//! The Rust port of the project's JS spike-stress search: after a lethal packet becomes due, does a
//! sequence of own placements (visible queue only, no further incoming) survive it, and how high does the
//! board end? Moves and the lock (clear, spin, attack, B2B surge, combo) come from the native S2 model;
//! the garbage queue is a port of teto's `GarbageQueue` (MINSTD hole columns, FIFO cancel with the opener
//! phase, cap-8 tank) and `Board.insertGarbage`, so tanked rows are real cells with a hole column.
//! The hole RNG state is an input: callers that act for the bot must pass a public value, never the
//! referee's generator state.
//!
//! Callers: the native CLI `src/bin/cc2-spike-stress.rs`, and the spike WASM (bot/cc2-spike-wasm) that serves
//! rule RG for the GUI setting RG (EXPERIMENTAL).
//!
//! Speed: the dedup and move-cache maps
//! use `StateBuildHasher` (lookup only, never iterated), and the last depth's alive check skips the move generator
//! when the answer is known without it (`surely_has_moves`). Outputs are unchanged.

use crate::data::{Board, Piece};
use crate::movegen::NativeS2Move;
use crate::native_s2::{Chain, Incoming, State};
use crate::map::StateBuildHasher;
use std::collections::HashMap;
use std::rc::Rc;

const MODULUS: u64 = 2_147_483_647;
const MULTIPLIER: u64 = 16_807;
const MAX_FLOAT: u64 = 2_147_483_646;
const BOARD_WIDTH: usize = 10;
const FULL_HEIGHT: u32 = 40;
const GARBAGE_SPEED: i64 = 20;
const GARBAGE_CAP: u32 = 8;
const OPENER_PHASE: u64 = 14;
const MESSINESS_CHANGE: f64 = 1.0;
const MESSINESS_WITHIN: f64 = 0.0;
const FRAMES_PER_LOCK: i64 = 60;

/// teto `RNG` (Park-Miller MINSTD).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rng {
    pub value: u64,
}
impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut value = seed % MODULUS;
        if value == 0 {
            value += MAX_FLOAT;
        }
        Self { value }
    }
    pub fn next_float(&mut self) -> f64 {
        self.value = MULTIPLIER * self.value % MODULUS;
        (self.value - 1) as f64 / MAX_FLOAT as f64
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Packet {
    pub amount: u32,
    pub frame: i64,
}

/// teto `GarbageQueue` restricted to the S2 rules (messiness change 1, within 0, nosame off, no timeout,
/// hole size 1, hard-drop locks, rounding down).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct GarbageQueue {
    pub packets: Vec<Packet>,
    pub rng: Rng,
    pub last_column: Option<u8>,
    pub has_changed_column: bool,
    pub sent: u64,
    pub received: u64,
}
impl GarbageQueue {
    pub fn size(&self) -> u32 {
        self.packets.iter().map(|p| p.amount).sum()
    }
    fn reroll_column(&mut self) -> u8 {
        let col = (self.rng.next_float() * BOARD_WIDTH as f64).floor() as u8;
        self.last_column = Some(col);
        col
    }
    /// Returns (attack left after cancelling, rows cancelled).
    pub fn cancel(&mut self, amount: u32, pieces_placed: u64) -> (u32, u32) {
        let mut send = amount;
        let mut cancel = 0u32;
        let mut cancelled = 0u32;
        if pieces_placed + 1 <= OPENER_PHASE && u64::from(self.size()) >= self.sent {
            cancel += amount;
        }
        while (send > 0 || cancel > 0) && !self.packets.is_empty() {
            self.packets[0].amount -= 1;
            cancelled += 1;
            if self.packets[0].amount == 0 {
                self.packets.remove(0);
                if self.rng.next_float() < MESSINESS_CHANGE {
                    self.reroll_column();
                    self.has_changed_column = true;
                }
            }
            if send > 0 {
                send -= 1;
            } else {
                cancel -= 1;
            }
        }
        self.sent += u64::from(send);
        (send, cancelled)
    }
    /// Hard-drop tank at `frame`; returns the hole column of each inserted row in insertion order.
    pub fn tank(&mut self, frame: i64) -> Vec<u8> {
        let mut rows = Vec::new();
        if self.packets.is_empty() {
            return rows;
        }
        self.packets.sort_by_key(|p| p.frame);
        for _ in 0..GARBAGE_CAP {
            if self.packets.is_empty() || self.packets[0].frame + GARBAGE_SPEED > frame {
                break;
            }
            self.packets[0].amount -= 1;
            self.received += 1;
            let mut col = self.last_column;
            // `(col === null || rngex() < within) && !hasChangedColumn`: the draw happens whenever col is set.
            let reroll = match col {
                None => true,
                Some(_) => self.rng.next_float() < MESSINESS_WITHIN,
            };
            if reroll && !self.has_changed_column {
                col = Some(self.reroll_column());
                self.has_changed_column = true;
            }
            // teto would insert with column null, which its comparisons read as column 0.
            rows.push(col.unwrap_or(0));
            self.has_changed_column = false;
            if self.packets[0].amount == 0 {
                self.packets.remove(0);
                if self.rng.next_float() < MESSINESS_CHANGE {
                    self.reroll_column();
                    self.has_changed_column = true;
                }
            }
        }
        rows
    }
}

/// teto `Board.insertGarbage` for one row: the row goes in at the bottom, then the row at index
/// `fullHeight - 2` of the 41-row array is spliced out (so the old row 37 is lost, rows 38 and 39 stay).
pub fn insert_garbage_row(board: &mut Board, g: &mut Board, hole: u8) {
    let low = (1u64 << (FULL_HEIGHT - 3)) - 1;
    let high = 0b11u64 << (FULL_HEIGHT - 2);
    for x in 0..BOARD_WIDTH {
        let bit = u64::from(x != hole as usize);
        board.cols[x] = ((board.cols[x] & low) << 1) | (board.cols[x] & high) | bit;
        g.cols[x] = ((g.cols[x] & low) << 1) | (g.cols[x] & high) | bit;
    }
}

/// Garbage multiplier at `frame` (base 1, +0.008 per second after frame 10800), accumulated per frame in
/// the same order as `src-js/dynamic-values.mjs` so the floor of attack x multiplier agrees.
pub struct Multiplier {
    values: Vec<f64>,
}
impl Multiplier {
    pub fn new() -> Self {
        Self { values: vec![1.0] }
    }
    pub fn at(&mut self, frame: i64) -> f64 {
        let frame = frame.max(0) as usize;
        while self.values.len() <= frame {
            let step = self.values.len();
            let last = *self.values.last().unwrap();
            self.values.push(if step > 10_800 { last + 0.008 / 60.0 } else { last });
        }
        self.values[frame]
    }
}
impl Default for Multiplier {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug)]
pub struct Position {
    pub board: Board,
    pub materialized_g: Board,
    pub current: Piece,
    pub hold: Option<Piece>,
    pub hold_available: bool,
    pub known: Vec<Piece>,
    pub chain: Chain,
    pub garbage: GarbageQueue,
    pub frame: i64,
    pub pieces_placed: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Metrics {
    pub height: u32,
    pub holes: u32,
    pub pending: u32,
}
fn metrics(board: &Board, garbage: &GarbageQueue) -> Metrics {
    let mut height = 0;
    let mut holes = 0;
    for c in board.cols {
        let top = 64 - c.leading_zeros();
        height = height.max(top);
        holes += top - c.count_ones();
    }
    Metrics { height, holes, pending: garbage.size() }
}

#[derive(Clone)]
struct Node {
    state: State,
    garbage: GarbageQueue,
    frame: i64,
    pieces_placed: u64,
    known_left: usize,
    m: Metrics,
    danger: u32,
    peak: u32,
    sent: u32,
    cancelled: u32,
    /// Attack before cancelling, summed over the plan (`Σ plan.attack`).
    attack: u32,
    moves: Option<Vec<(bool, Rc<Vec<NativeS2Move>>)>>,
    step: Option<Step>,
}

/// One lock of a child, for the JS comparison (`children_of`).
#[derive(Clone, Debug)]
pub struct Step {
    pub hold: bool,
    pub cells: [(i8, i8); 4],
    pub spin: crate::native_s2::CanonicalSpin,
    pub lines: u32,
    pub attack: u32,
    pub sent: u32,
    pub cancelled: u32,
    pub tank: u32,
}

/// A child as `children_of` reports it.
#[derive(Clone, Debug)]
pub struct ChildReport {
    pub step: Step,
    pub board: Board,
    pub materialized_g: Board,
    pub metrics: Metrics,
    pub b2b: u32,
    pub combo: u32,
    pub garbage: GarbageQueue,
}
impl Node {
    fn moves(&mut self, cache: &mut MoveCache) -> &[(bool, Rc<Vec<NativeS2Move>>)] {
        let state = &self.state;
        self.moves.get_or_insert_with(|| sky_moves(state, cache))
    }
    fn has_moves(&mut self, cache: &mut MoveCache) -> bool {
        self.moves(cache).iter().any(|(_, list)| !list.is_empty())
    }
    /// `has_moves` without the move generator when the board's rows 36..=39 are empty in every column and a
    /// current piece exists: the Sky entry seeds North at every column from just below row 40 and records the
    /// drop of every unobstructed seed, and North at x = 4 is unobstructed for every piece there. Otherwise it
    /// is `has_moves`.
    fn surely_has_moves(&mut self, cache: &mut MoveCache) -> bool {
        if self.state.current.is_some() && self.state.board.cols.iter().all(|&c| c >> 36 == 0) {
            return true;
        }
        self.has_moves(cache)
    }
}

/// Moves of one piece on one board, shared by every node with that board within a search.
type MoveCache = HashMap<(Board, Piece), Rc<Vec<NativeS2Move>>, StateBuildHasher>;

/// `State::root_moves` with the JS reference's reachability (`RootEntry::Sky`): current piece, then the hold
/// piece (or the first known piece when the hold is empty).
fn sky_moves(state: &State, cache: &mut MoveCache) -> Vec<(bool, Rc<Vec<NativeS2Move>>)> {
    let Some(current) = state.current else { return Vec::new() };
    let mut sources = vec![(false, current)];
    if state.hold_available {
        if let Some(piece) = state.hold.or(state.known_next.first().copied()) {
            sources.push((true, piece));
        }
    }
    sources
        .into_iter()
        .map(|(hold, piece)| {
            let list = cache.entry((state.board, piece)).or_insert_with(|| Rc::new(distinct_locks(&state.board, piece)));
            (hold, Rc::clone(list))
        })
        .collect()
}

/// Movegen returns one witness per rotation path, but the lock reads only the cells and the spin, so a
/// later witness with the same pair gives the same child, which the beam's first-seen dedup would drop.
///
/// The list is `find_native_s2_moves`' (a stable sort by `witness_key`, then a dedup that keeps the first of
/// each run) filtered to the first witness of each (cells, spin): that is, for each (cells, spin), the witness
/// least by (key, generation index), listed in key order. It is computed that way here, from the unsorted
/// witnesses, without sorting all of them.
fn distinct_locks(board: &Board, piece: Piece) -> Vec<NativeS2Move> {
    let raw = crate::movegen::native_s2_witnesses_unsorted(board, piece, crate::movegen::RootEntry::Sky);
    // Least witness per (location, spin), in a table over rotation, x, y and spin (one piece per call; a lock's
    // cells depend on the location only; locations lie in x -4..=13, y -4..=43, the lock's own bounds). The table
    // is kept between calls and cleared through the slots used.
    const SLOTS: usize = 4 * 18 * 48 * 3;
    thread_local! { static TABLE: std::cell::RefCell<Vec<u32>> = std::cell::RefCell::new(vec![u32::MAX; SLOTS]); }
    let mut table = TABLE.with(|t| std::mem::take(&mut *t.borrow_mut()));
    if table.len() != SLOTS {
        table = vec![u32::MAX; SLOTS];
    }
    let mut poses: Vec<usize> = Vec::with_capacity(160);
    for (i, w) in raw.iter().enumerate() {
        let l = w.location;
        assert!(l.piece == piece && (-4..=13).contains(&l.x) && (-4..=43).contains(&l.y), "witness outside the lock bounds");
        let s = ((l.rotation as usize * 18 + (l.x + 4) as usize) * 48 + (l.y + 4) as usize) * 3 + w.spin as usize;
        let best = table[s];
        if best == u32::MAX {
            table[s] = i as u32;
            poses.push(s);
        } else if witness_key(w) < witness_key(&raw[best as usize]) {
            table[s] = i as u32;
        }
    }
    let winners: Vec<usize> = poses.iter().map(|&s| table[s] as usize).collect();
    for &s in &poses {
        table[s] = u32::MAX;
    }
    TABLE.with(|t| *t.borrow_mut() = table);
    // Least of those per (cells, spin): sort the few winners by (cells, spin, key, index), keep each group's first,
    // then list them in key order.
    let mut grouped: Vec<(([(i8, i8); 4], u8), usize)> = winners.into_iter().map(|i| {
        let mut cells = raw[i].location.cells();
        cells.sort_unstable();
        ((cells, raw[i].spin as u8), i)
    }).collect();
    grouped.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| (witness_key(&raw[a.1]), a.1).cmp(&(witness_key(&raw[b.1]), b.1))));
    grouped.dedup_by(|a, b| a.0 == b.0);
    let mut kept: Vec<usize> = grouped.into_iter().map(|(_, i)| i).collect();
    kept.sort_by_key(|&i| (witness_key(&raw[i]), i));
    kept.into_iter().map(|i| raw[i].clone()).collect()
}

/// The sort key of `find_native_s2_moves`.
#[allow(clippy::type_complexity)]
fn witness_key(w: &NativeS2Move) -> (u8, u8, i8, i8, u8, Option<(u8, i8, i8)>, Option<usize>, u32) {
    (
        w.location.piece as u8,
        w.location.rotation as u8,
        w.location.x,
        w.location.y,
        w.spin as u8,
        w.rotation_from.map(|p| (p.rotation as u8, p.x, p.y)),
        w.native_kick_index,
        w.soft_drops,
    )
}

fn better(a: &Node, b: &Node) -> std::cmp::Ordering {
    a.danger
        .cmp(&b.danger)
        .then(a.m.holes.cmp(&b.m.holes))
        .then(a.peak.cmp(&b.peak))
        .then(b.sent.cmp(&a.sent))
}

#[derive(Hash, PartialEq, Eq)]
struct Key {
    board: [u64; 10],
    g: [u64; 10],
    current: Option<Piece>,
    hold: Option<Piece>,
    hold_available: bool,
    b2b: u32,
    combo: u32,
    amounts: Vec<u32>,
    last_column: Option<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub survived: bool,
    pub alive_depth: usize,
    pub horizon: usize,
    pub final_height: u32,
    pub final_holes: u32,
    pub final_pending: u32,
    pub peak: u32,
    pub sent: u32,
    pub cancelled: u32,
    /// Attack before cancelling along the returned plan (not used to rank nodes).
    pub attack: u32,
    pub expanded: usize,
}
impl Outcome {
    /// F' of the plan: final height plus remaining pending if alive at the horizon, else 99.
    pub fn reduced_height(&self) -> u32 {
        if self.alive_depth == self.horizon { self.final_height + self.final_pending } else { 99 }
    }
}

/// Adds one confirmed packet of `rows` due at the next lock (the JS `injectSpike`).
pub fn inject_spike(position: &mut Position, rows: u32) {
    position.garbage.packets.push(Packet { amount: rows, frame: position.frame - 600 });
}

fn expand(node: &mut Node, mult: &mut Multiplier, cache: &mut MoveCache) -> Vec<Node> {
    let multiplier = mult.at(node.frame);
    let sources = node.moves(cache).to_vec();
    let mut children = Vec::with_capacity(sources.iter().map(|(_, list)| list.len()).sum());
    for (hold, mv) in sources.iter().flat_map(|(hold, list)| list.iter().map(move |mv| (hold, mv))) {
        let Ok((mut next, clear, attack)) = node.state.lock_future(mv, *hold, multiplier) else { continue };
        let mut garbage = node.garbage.clone();
        let mut chunks: Vec<u32> = attack.surge_chunks.clone();
        if attack.after_rounding > 0 {
            chunks.push(attack.after_rounding);
        }
        if attack.perfect_clear_bonus > 0 {
            chunks.push(attack.perfect_clear_bonus);
        }
        let (mut sent, mut cancelled) = (0u32, 0u32);
        for (i, &chunk) in chunks.iter().enumerate() {
            let (left, c) = garbage.cancel(chunk, node.pieces_placed);
            cancelled += c;
            if left > 0 {
                sent = left + chunks[i + 1..].iter().sum::<u32>();
                break;
            }
        }
        let mut tank = 0u32;
        if clear.lines == 0 {
            for hole in garbage.tank(node.frame) {
                insert_garbage_row(&mut next.board, &mut next.materialized_g, hole);
                tank += 1;
            }
        }
        let step = Step { hold: *hold, cells: mv.location.cells(), spin: mv.spin, lines: clear.lines,
            attack: attack.outgoing_before_cancel, sent, cancelled, tank };
        // The plan may only use pieces visible at the root.
        next.known_next.truncate(node.known_left.saturating_sub(1));
        next.incoming = Incoming { pending_rows: 0, due_this_lock_rows: 0 };
        let m = metrics(&next.board, &garbage);
        let danger = m.height + m.pending;
        children.push(Node {
            state: next,
            garbage,
            frame: node.frame + FRAMES_PER_LOCK,
            pieces_placed: node.pieces_placed + 1,
            known_left: node.known_left.saturating_sub(1),
            m,
            danger,
            peak: node.peak.max(danger),
            sent: node.sent + sent,
            cancelled: node.cancelled + cancelled,
            attack: node.attack + attack.outgoing_before_cancel,
            moves: None,
            step: Some(step),
        });
    }
    children
}

/// Every child of `position` (one lock, spike already in the queue), in generation order.
pub fn children_of(position: &Position, known: usize, mult: &mut Multiplier) -> Vec<ChildReport> {
    let mut root = root_node(position, known);
    expand(&mut root, mult, &mut MoveCache::default()).into_iter().map(|c| ChildReport {
        step: c.step.expect("child step"),
        board: c.state.board,
        materialized_g: c.state.materialized_g,
        metrics: c.m,
        b2b: c.state.chain.b2b,
        combo: c.state.chain.combo,
        garbage: c.garbage,
    }).collect()
}

fn root_node(position: &Position, known: usize) -> Node {
    let known = known.min(position.known.len());
    let mut known_next = position.known.clone();
    known_next.truncate(known);
    let state = State {
        board: position.board,
        materialized_g: position.materialized_g,
        current: Some(position.current),
        hold: position.hold,
        hold_available: position.hold_available,
        known_next,
        chain: position.chain,
        incoming: Incoming { pending_rows: 0, due_this_lock_rows: 0 },
        horizon: crate::native_s2::Horizon::Open,
    };
    let m0 = metrics(&position.board, &position.garbage);
    Node {
        state,
        garbage: position.garbage.clone(),
        frame: position.frame,
        pieces_placed: position.pieces_placed,
        known_left: known,
        m: m0,
        danger: m0.height + m0.pending,
        peak: m0.height + m0.pending,
        sent: 0,
        cancelled: 0,
        attack: 0,
        moves: None,
        step: None,
    }
}

pub fn spike_stress_search(position: &Position, horizon: usize, width: usize, known: usize, mult: &mut Multiplier) -> Outcome {
    let known = known.min(position.known.len());
    let root = root_node(position, known);
    let max_depth = horizon.min(known);
    let mut beam = vec![root];
    let mut cache = MoveCache::default();
    let (mut expanded, mut depth_reached) = (0usize, 0usize);
    for depth in 1..=max_depth {
        let mut order: Vec<Node> = Vec::new();
        let mut index: HashMap<Key, usize, StateBuildHasher> = HashMap::default();
        for node in beam.iter_mut() {
            let children = expand(node, mult, &mut cache);
            expanded += 1;
            for c in children {
                let key = Key {
                    board: c.state.board.cols,
                    g: c.state.materialized_g.cols,
                    current: c.state.current,
                    hold: c.state.hold,
                    hold_available: c.state.hold_available,
                    b2b: c.state.chain.b2b,
                    combo: c.state.chain.combo,
                    amounts: c.garbage.packets.iter().map(|p| p.amount).collect(),
                    last_column: c.garbage.last_column,
                };
                match index.get(&key) {
                    Some(&i) => {
                        if better(&c, &order[i]).is_lt() {
                            order[i] = c;
                        }
                    }
                    None => {
                        index.insert(key, order.len());
                        order.push(c);
                    }
                }
            }
        }
        // Stable sort keeps first-seen order among ties, as the JS Map does.
        order.sort_by(better);
        let mut alive = Vec::new();
        for mut c in order {
            if alive.len() >= width {
                break;
            }
            // The last depth's nodes are never expanded, so only whether they have a move matters.
            let has = if depth == max_depth { c.surely_has_moves(&mut cache) } else { c.has_moves(&mut cache) };
            if !has {
                continue;
            }
            alive.push(c);
        }
        if alive.is_empty() {
            break;
        }
        beam = alive;
        depth_reached = depth;
    }
    let resolved: Vec<&Node> = if depth_reached == max_depth { beam.iter().filter(|n| n.m.pending == 0).collect() } else { Vec::new() };
    let pool: Vec<&Node> = if resolved.is_empty() { beam.iter().collect() } else { resolved.clone() };
    let best = pool.iter().copied().min_by(|a, b| better(a, b)).unwrap();
    Outcome {
        survived: !resolved.is_empty(),
        alive_depth: depth_reached,
        horizon: max_depth,
        final_height: best.m.height,
        final_holes: best.m.holes,
        final_pending: best.m.pending,
        peak: best.peak,
        sent: best.sent,
        cancelled: best.cancelled,
        attack: best.attack,
        expanded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `surely_has_moves`'s premise: with rows 36..=39 empty, the Sky move generator returns a move for every
    /// piece, whatever lies below (pseudo-random stacks up to row 35, including full and holed columns).
    #[test]
    fn sky_moves_exist_whenever_rows_36_to_39_are_empty() {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
        for case in 0..400 {
            let mut board = Board { cols: [0; 10] };
            let top = (case % 37) as u32; // stacks up to row 35
            for x in 0..10 {
                let fill = if top == 0 { 0 } else { next() & ((1u64 << top) - 1) };
                board.cols[x] = if case % 5 == 0 { (1u64 << top) - 1 } else { fill };
            }
            for piece in [Piece::I, Piece::O, Piece::T, Piece::L, Piece::J, Piece::S, Piece::Z] {
                let moves = crate::movegen::find_native_s2_moves(&board, piece, crate::movegen::RootEntry::Sky);
                assert!(!moves.is_empty(), "no Sky move for {piece:?} on case {case}");
            }
        }
    }
}
