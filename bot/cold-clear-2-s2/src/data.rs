use std::hash::{Hash, Hasher};

use enum_map::Enum;
use enumset::{EnumSet, EnumSetType};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Deserialize)]
#[serde(from = "Vec<[Option<char>; 10]>")]
pub struct Board {
    pub cols: [u64; 10],
}

/// The canonical B2B charging threshold. Unlike the historical `/1` amount
/// approximation, the search state keeps the full chain value.
pub const B2B_CHARGING_AT: u32 = 4;
/// Historical `/1` threshold and saturation cap; the candidate path uses `B2B_CHARGING_AT` and keeps the full chain.
pub const B2B_SAT: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GameState {
    pub board: Board,
    pub bag: EnumSet<Piece>,
    pub reserve: Piece,
    pub b2b: u32,
    pub combo: u8,
    /// Unmaterialized incoming total (amount-only). Zero when the flag is off.
    pub pending_incoming_rows: u8,
    /// Amount that tanks on the next no-clear lock (amount-only).
    pub due_this_lock_rows: u8,
}

impl Hash for GameState {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.board.hash(state);
        self.bag.hash(state);
        self.reserve.hash(state);
        self.b2b.hash(state);
        self.combo.hash(state);
        if self.pending_incoming_rows != 0 || self.due_this_lock_rows != 0 {
            1u8.hash(state);
            self.pending_incoming_rows.hash(state);
            self.due_this_lock_rows.hash(state);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainDelta {
    pub combo_after: u8,
    pub b2b_after: u32,
    pub continuing_b2b: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdvanceError {
    ChainOverflow,
    InvalidIncoming,
}

impl std::fmt::Display for AdvanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ChainOverflow => f.write_str("chain-overflow"),
            Self::InvalidIncoming => f.write_str("invalid-incoming"),
        }
    }
}

impl std::error::Error for AdvanceError {}

/// Canonical `advanceChain` if-else with an unsaturated u32 B2B state.
/// PC charges +1 and is not stacked on difficult.
pub fn advance_chain(
    combo: u8,
    b2b: u32,
    lines: u32,
    spin: Spin,
    perfect_clear: bool,
) -> Result<ChainDelta, AdvanceError> {
    if lines == 0 {
        return Ok(ChainDelta {
            combo_after: 0,
            b2b_after: b2b,
            continuing_b2b: false,
        });
    }
    let combo_after = combo.saturating_add(1);
    let difficult = lines >= 4 || !matches!(spin, Spin::None);
    if perfect_clear || difficult {
        Ok(ChainDelta {
            combo_after,
            b2b_after: b2b.checked_add(1).ok_or(AdvanceError::ChainOverflow)?,
            continuing_b2b: b2b >= 1,
        })
    } else {
        Ok(ChainDelta {
            combo_after,
            b2b_after: 0,
            continuing_b2b: false,
        })
    }
}

fn advance_chain_legacy(
    combo: u8,
    b2b: u32,
    lines: u32,
    spin: Spin,
    perfect_clear: bool,
) -> ChainDelta {
    let b2b = b2b.min(u32::from(B2B_SAT));
    if lines == 0 {
        return ChainDelta {
            combo_after: 0,
            b2b_after: b2b,
            continuing_b2b: false,
        };
    }
    let combo_after = combo.saturating_add(1);
    let difficult = lines >= 4 || !matches!(spin, Spin::None);
    if perfect_clear || difficult {
        ChainDelta {
            combo_after,
            b2b_after: b2b.saturating_add(1).min(u32::from(B2B_SAT)),
            continuing_b2b: b2b >= 1,
        }
    } else {
        ChainDelta {
            combo_after,
            b2b_after: 0,
            continuing_b2b: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PieceLocation {
    #[serde(rename = "type")]
    pub piece: Piece,
    #[serde(rename = "orientation")]
    pub rotation: Rotation,
    pub x: i8,
    pub y: i8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Placement {
    pub location: PieceLocation,
    pub spin: Spin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PlacementInfo {
    pub placement: Placement,
    pub lines_cleared: u32,
    pub combo: u32,
    pub back_to_back: bool,
    pub perfect_clear: bool,
    pub cancelled_rows: u8,
    pub tank_rows: u8,
    pub remaining_rows: u8,
    pub outgoing_after_cancel: u8,
    /// Canonical Surge rows owned by the new S2 candidate path.
    pub surge_rows: u32,
    pub search_attack_overflow: bool,
}

/// Closed-form search outgoing. Not `garbageCalcV2`.
pub const S2_AMOUNT_ONLY_SEARCH_ATTACK_ID: &str = "s2-amount-only-search-attack/1";
pub const S2_AMOUNT_ONLY_SEARCH_ADVANCE_ID: &str = "s2-amount-only-search-advance/1";
pub const S2_B2B_SURGE_SEARCH_ATTACK_ID: &str = "s2-b2b-surge-search-attack/1";

/// Canonical fixed-multiplier Surge rows. Base attack, combo, PC, cancellation,
/// and tanking remain owned by their existing paths.
pub fn s2_b2b_surge_rows(
    lines: u32,
    spin: Spin,
    perfect_clear: bool,
    b2b_before: u32,
) -> u32 {
    let broke = lines > 0
        && lines < 4
        && matches!(spin, Spin::None)
        && !perfect_clear
        && b2b_before > 0;
    if broke && b2b_before > B2B_CHARGING_AT {
        b2b_before - B2B_CHARGING_AT + 3
    } else {
        0
    }
}

pub const SEARCH_ATTACK_COMBO_LOG1P_FLOOR: [u32; 256] = [
    0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4,
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AmountDelta {
    pub cancelled_rows: u8,
    pub tank_rows: u8,
    pub remaining_rows: u8,
    pub outgoing_before_cancel: u8,
    pub outgoing_after_cancel: u8,
    pub pending_after: u8,
    pub due_after: u8,
    pub search_attack_overflow: bool,
}

pub fn amount_only_search_attack(
    lines: u32,
    spin: Spin,
    perfect_clear: bool,
    combo_after: u8,
    b2b_after: u8,
    b2b_before: u8,
) -> Option<u32> {
    if lines == 0 {
        return Some(0);
    }
    let mut base = search_attack_base(lines, spin);
    let b2b_index = b2b_after.saturating_sub(1) as u32;
    if b2b_index > 0 {
        base += 1;
    }
    let combo_index = combo_after.saturating_sub(1) as u32;
    let mut raw = (base * (4 + combo_index)) / 4;
    if combo_index > 1 {
        raw = raw.max(SEARCH_ATTACK_COMBO_LOG1P_FLOOR[combo_index as usize]);
    }
    let pc_bonus = if perfect_clear { 5 } else { 0 };
    let broke = matches!(spin, Spin::None) && lines < 4 && !perfect_clear;
    let surge = if broke && b2b_before >= 4 {
        u32::from(b2b_before) - 1
    } else {
        0
    };
    Some(raw + pc_bonus + surge)
}

fn search_attack_base(lines: u32, spin: Spin) -> u32 {
    match (spin, lines) {
        (Spin::None, 1) => 0,
        (Spin::None, 2) => 1,
        (Spin::None, 3) => 2,
        (Spin::None, 4) => 4,
        (Spin::None, 5) => 5,
        (Spin::None, n) => 5 + (n - 5),
        (Spin::Mini, 1) => 0,
        (Spin::Mini, 2) => 1,
        (Spin::Mini, 3) => 2,
        (Spin::Mini, 4) => 10,
        (Spin::Mini, 5) => 12,
        (Spin::Mini, n) => 12 + 2 * (n - 5),
        (Spin::Full, 1) => 2,
        (Spin::Full, 2) => 4,
        (Spin::Full, 3) => 6,
        (Spin::Full, 4) => 10,
        (Spin::Full, 5) => 12,
        (Spin::Full, n) => 12 + 2 * (n - 5),
    }
}

pub fn advance_amount_only(
    pending: u8,
    due: u8,
    lines: u32,
    spin: Spin,
    perfect_clear: bool,
    combo_after: u8,
    b2b_after: u8,
    b2b_before: u8,
) -> Result<AmountDelta, AdvanceError> {
    if due > pending {
        return Err(AdvanceError::InvalidIncoming);
    }
    if pending == 0 && due == 0 {
        return Ok(AmountDelta {
            cancelled_rows: 0,
            tank_rows: 0,
            remaining_rows: 0,
            outgoing_before_cancel: 0,
            outgoing_after_cancel: 0,
            pending_after: 0,
            due_after: 0,
            search_attack_overflow: false,
        });
    }
    let outgoing = amount_only_search_attack(
        lines,
        spin,
        perfect_clear,
        combo_after,
        b2b_after,
        b2b_before,
    )
    .unwrap_or(0);
    if outgoing > 255 {
        return Ok(AmountDelta {
            cancelled_rows: 0,
            tank_rows: 0,
            remaining_rows: 0,
            outgoing_before_cancel: 0,
            outgoing_after_cancel: 0,
            pending_after: pending,
            due_after: due,
            search_attack_overflow: true,
        });
    }
    debug_assert!(lines > 0 || outgoing == 0);
    let outgoing = outgoing as u8;
    let cancelled_rows = outgoing.min(pending);
    let outgoing_after_cancel = outgoing - cancelled_rows;
    let (tank_rows, remaining_rows) = if lines > 0 {
        (0, pending - cancelled_rows)
    } else {
        let tank_rows = due.min(pending);
        (tank_rows, pending - tank_rows)
    };
    Ok(AmountDelta {
        cancelled_rows,
        tank_rows,
        remaining_rows,
        outgoing_before_cancel: outgoing,
        outgoing_after_cancel,
        pending_after: remaining_rows,
        due_after: remaining_rows,
        search_attack_overflow: false,
    })
}

#[allow(clippy::derive_hash_xor_eq)]
#[derive(EnumSetType, Enum, Debug, Hash, Serialize, Deserialize)]
pub enum Piece {
    I,
    O,
    T,
    L,
    J,
    S,
    Z,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rotation {
    North,
    West,
    South,
    East,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Spin {
    None,
    Mini,
    Full,
}

impl Piece {
    pub const fn cells(self) -> [(i8, i8); 4] {
        match self {
            Piece::I => [(-1, 0), (0, 0), (1, 0), (2, 0)],
            Piece::O => [(0, 0), (1, 0), (0, 1), (1, 1)],
            Piece::T => [(-1, 0), (0, 0), (1, 0), (0, 1)],
            Piece::L => [(-1, 0), (0, 0), (1, 0), (1, 1)],
            Piece::J => [(-1, 0), (0, 0), (1, 0), (-1, 1)],
            Piece::S => [(-1, 0), (0, 0), (0, 1), (1, 1)],
            Piece::Z => [(-1, 1), (0, 1), (0, 0), (1, 0)],
        }
    }
}

impl Rotation {
    pub const fn rotate_cell(self, (x, y): (i8, i8)) -> (i8, i8) {
        match self {
            Rotation::North => (x, y),
            Rotation::East => (y, -x),
            Rotation::South => (-x, -y),
            Rotation::West => (-y, x),
        }
    }

    pub const fn rotate_cells(self, cells: [(i8, i8); 4]) -> [(i8, i8); 4] {
        [
            self.rotate_cell(cells[0]),
            self.rotate_cell(cells[1]),
            self.rotate_cell(cells[2]),
            self.rotate_cell(cells[3]),
        ]
    }

    pub const fn cw(self) -> Self {
        match self {
            Rotation::North => Rotation::East,
            Rotation::East => Rotation::South,
            Rotation::South => Rotation::West,
            Rotation::West => Rotation::North,
        }
    }

    pub const fn ccw(self) -> Self {
        match self {
            Rotation::North => Rotation::West,
            Rotation::East => Rotation::North,
            Rotation::South => Rotation::East,
            Rotation::West => Rotation::South,
        }
    }

    pub const fn flip(self) -> Self {
        match self {
            Rotation::North => Rotation::South,
            Rotation::East => Rotation::West,
            Rotation::South => Rotation::North,
            Rotation::West => Rotation::East,
        }
    }
}

macro_rules! lutify {
    (($e:expr) for $v:ident in [$($val:expr),*]) => {
        [
            $(
                {
                    let $v = $val;
                    $e
                }
            ),*
        ]
    };
}

macro_rules! piece_lut {
    ($v:ident => $e:expr) => {
        lutify!(($e) for $v in [Piece::I, Piece::O, Piece::T, Piece::L, Piece::J, Piece::S, Piece::Z])
    };
}

macro_rules! rotation_lut {
    ($v:ident => $e:expr) => {
        lutify!(($e) for $v in [Rotation::North, Rotation::West, Rotation::South, Rotation::East])
    };
}

impl PieceLocation {
    pub const fn cells(&self) -> [(i8, i8); 4] {
        const LUT: [[[(i8, i8); 4]; 4]; 7] =
            piece_lut!(piece => rotation_lut!(rotation => rotation.rotate_cells(piece.cells())));
        self.translate_cells(LUT[self.piece as usize][self.rotation as usize])
    }

    const fn translate(&self, (x, y): (i8, i8)) -> (i8, i8) {
        (x + self.x, y + self.y)
    }

    const fn translate_cells(&self, cells: [(i8, i8); 4]) -> [(i8, i8); 4] {
        [
            self.translate(cells[0]),
            self.translate(cells[1]),
            self.translate(cells[2]),
            self.translate(cells[3]),
        ]
    }

    pub fn obstructed(&self, board: &Board) -> bool {
        self.cells().iter().any(|&cell| board.occupied(cell))
    }

    pub fn drop_distance(&self, board: &Board) -> i8 {
        self.cells()
            .iter()
            .map(|&(x, y)| board.distance_to_ground(x, y))
            .min()
            .unwrap()
    }

    pub fn above_stack(&self, board: &Board) -> bool {
        self.cells()
            .iter()
            .all(|&(x, y)| y >= 64 - board.cols[x as usize].leading_zeros() as i8)
    }

    pub fn canonical_form(&self) -> PieceLocation {
        match self.piece {
            Piece::T | Piece::J | Piece::L => *self,
            Piece::O => match self.rotation {
                Rotation::North => *self,
                Rotation::East => PieceLocation {
                    rotation: Rotation::North,
                    y: self.y - 1,
                    ..*self
                },
                Rotation::South => PieceLocation {
                    rotation: Rotation::North,
                    x: self.x - 1,
                    y: self.y - 1,
                    ..*self
                },
                Rotation::West => PieceLocation {
                    rotation: Rotation::North,
                    x: self.x - 1,
                    ..*self
                },
            },
            Piece::S | Piece::Z => match self.rotation {
                Rotation::North | Rotation::East => *self,
                Rotation::South => PieceLocation {
                    rotation: Rotation::North,
                    y: self.y - 1,
                    ..*self
                },
                Rotation::West => PieceLocation {
                    rotation: Rotation::East,
                    x: self.x - 1,
                    ..*self
                },
            },
            Piece::I => match self.rotation {
                Rotation::North | Rotation::East => *self,
                Rotation::South => PieceLocation {
                    rotation: Rotation::North,
                    x: self.x - 1,
                    ..*self
                },
                Rotation::West => PieceLocation {
                    rotation: Rotation::East,
                    y: self.y + 1,
                    ..*self
                },
            },
        }
    }
}

impl Board {
    pub const fn occupied(&self, (x, y): (i8, i8)) -> bool {
        if x < 0 || x >= 10 || y < 0 || y >= 40 {
            return true;
        }
        self.cols[x as usize] & 1 << y != 0
    }

    pub fn distance_to_ground(&self, x: i8, y: i8) -> i8 {
        debug_assert!((0..10).contains(&x));
        debug_assert!((0..40).contains(&y));
        if y == 0 {
            return 0;
        }
        (!self.cols[x as usize] << (64 - y)).leading_ones() as i8
    }

    pub fn place(&mut self, piece: PieceLocation) {
        for &(x, y) in &piece.cells() {
            debug_assert!((0..10).contains(&x));
            debug_assert!((0..40).contains(&y));
            self.cols[x as usize] |= 1 << y;
        }
    }

    pub fn line_clears(&self) -> u64 {
        self.cols.iter().fold(!0, |a, b| a & b)
    }

    pub fn remove_lines(&mut self, lines: u64) {
        for c in &mut self.cols {
            clear_lines(c, lines);
        }
    }
}

impl GameState {
    /// Apply one lock atomically. The public infallible wrapper below is kept
    /// for legacy callers; new request/commit paths must use this method.
    pub fn try_advance(
        &mut self,
        next: Piece,
        placement: Placement,
    ) -> Result<PlacementInfo, AdvanceError> {
        self.try_advance_with_surge(next, placement, true)
    }

    pub fn try_advance_with_surge(
        &mut self,
        next: Piece,
        placement: Placement,
        enable_s2_b2b_surge: bool,
    ) -> Result<PlacementInfo, AdvanceError> {
        let mut candidate = *self;
        let info = candidate.apply_advance(next, placement, enable_s2_b2b_surge)?;
        *self = candidate;
        Ok(info)
    }

    pub fn advance(&mut self, next: Piece, placement: Placement) -> PlacementInfo {
        self.try_advance_with_surge(next, placement, false)
            .expect("GameState advance failed")
    }
    fn apply_advance(
        &mut self,
        next: Piece,
        placement: Placement,
        enable_s2_b2b_surge: bool,
    ) -> Result<PlacementInfo, AdvanceError> {
        self.bag.remove(next);
        if self.bag.is_empty() {
            self.bag = EnumSet::all();
        }
        if placement.location.piece != next {
            self.reserve = next;
        }
        self.board.place(placement.location);
        let cleared_mask = self.board.line_clears();
        let lines_cleared = cleared_mask.count_ones();
        if cleared_mask != 0 {
            self.board.remove_lines(cleared_mask);
        }
        let perfect_clear = lines_cleared > 0 && self.board.cols.iter().all(|&c| c == 0);
        let b2b_before = self.b2b;
        let delta = if enable_s2_b2b_surge {
            advance_chain(
                self.combo,
                self.b2b,
                lines_cleared,
                placement.spin,
                perfect_clear,
            )?
        } else {
            advance_chain_legacy(self.combo, self.b2b, lines_cleared, placement.spin, perfect_clear)
        };
        self.combo = delta.combo_after;
        self.b2b = delta.b2b_after;
        let amount = advance_amount_only(
            self.pending_incoming_rows,
            self.due_this_lock_rows,
            lines_cleared,
            placement.spin,
            perfect_clear,
            delta.combo_after,
            delta.b2b_after.min(u32::from(u8::MAX)) as u8,
            b2b_before.min(u32::from(u8::MAX)) as u8,
        )?;
        if !amount.search_attack_overflow {
            self.pending_incoming_rows = amount.pending_after;
            self.due_this_lock_rows = amount.due_after;
        }
        let surge_rows = if enable_s2_b2b_surge {
            s2_b2b_surge_rows(
                lines_cleared,
                placement.spin,
                perfect_clear,
                b2b_before,
            )
        } else {
            0
        };
        Ok(PlacementInfo {
            placement,
            lines_cleared,
            combo: self.combo as u32,
            back_to_back: delta.continuing_b2b,
            perfect_clear,
            cancelled_rows: amount.cancelled_rows,
            tank_rows: amount.tank_rows,
            remaining_rows: amount.remaining_rows,
            outgoing_after_cancel: amount.outgoing_after_cancel,
            surge_rows,
            search_attack_overflow: amount.search_attack_overflow,
        })
    }
}

#[cfg(all(target_arch = "x86_64", target_feature = "bmi2"))]
fn clear_lines(col: &mut u64, lines: u64) {
    *col = unsafe {
        // SAFETY: #[cfg()] guard ensures that this instruction exists at compile time
        std::arch::x86_64::_pext_u64(*col, !lines)
    };
}

#[cfg(not(all(target_arch = "x86_64", target_feature = "bmi2")))]
fn clear_lines(col: &mut u64, mut lines: u64) {
    while lines != 0 {
        let i = lines.trailing_zeros();
        let mask = (1 << i) - 1;
        *col = *col & mask | *col >> 1 & !mask;
        lines &= !(1 << i);
        lines >>= 1;
    }
}

#[cfg(test)]
mod chain_tests {
    use super::{advance_chain, AdvanceError, Board, ChainDelta, GameState, Piece, PieceLocation, Placement, Rotation, Spin, B2B_CHARGING_AT};

    fn delta(combo: u8, b2b: u32, lines: u32, spin: Spin, pc: bool) -> ChainDelta {
        advance_chain(combo, b2b, lines, spin, pc).unwrap()
    }

    #[test]
    fn golden_chain_cases_with_sat_4() {
        // fixtures/golden/chain-and-surge.json chainCases; B2B is no longer clamped.
        assert_eq!(
            delta(0, 0, 4, Spin::None, false),
            ChainDelta { combo_after: 1, b2b_after: 1, continuing_b2b: false }
        );
        assert_eq!(
            delta(1, 1, 2, Spin::Full, false),
            ChainDelta { combo_after: 2, b2b_after: 2, continuing_b2b: true }
        );
        assert_eq!(
            delta(3, 5, 1, Spin::None, false),
            ChainDelta { combo_after: 4, b2b_after: 0, continuing_b2b: false }
        );
        assert_eq!(
            delta(3, 5, 0, Spin::None, false),
            ChainDelta { combo_after: 0, b2b_after: 5, continuing_b2b: false }
        );
        assert_eq!(
            delta(0, 2, 2, Spin::None, true),
            ChainDelta { combo_after: 1, b2b_after: 3, continuing_b2b: true }
        );
    }

    #[test]
    fn tetris_or_spin_perfect_clear_charges_once() {
        assert_eq!(
            delta(0, 0, 4, Spin::None, true),
            ChainDelta { combo_after: 1, b2b_after: 1, continuing_b2b: false }
        );
        assert_eq!(
            delta(2, 3, 2, Spin::Full, true),
            ChainDelta { combo_after: 3, b2b_after: 4, continuing_b2b: true }
        );
    }

    #[test]
    fn b2b_is_not_saturated_at_charge_threshold() {
        assert_eq!(delta(1, B2B_CHARGING_AT, 4, Spin::None, false).b2b_after, 5);
        assert_eq!(delta(1, B2B_CHARGING_AT, 1, Spin::Mini, true).b2b_after, 5);
    }

    #[test]
    fn surge_boundaries_follow_canonical_break_semantics() {
        assert_eq!(super::s2_b2b_surge_rows(1, Spin::None, false, 4), 0);
        assert_eq!(super::s2_b2b_surge_rows(1, Spin::None, false, 5), 4);
        assert_eq!(super::s2_b2b_surge_rows(1, Spin::None, false, 6), 5);
        assert_eq!(super::s2_b2b_surge_rows(1, Spin::Full, false, 6), 0);
        assert_eq!(super::s2_b2b_surge_rows(0, Spin::None, false, 6), 0);
        assert_eq!(super::s2_b2b_surge_rows(1, Spin::None, true, 6), 0);
    }

    #[test]
    fn checked_chain_overflow_is_reported_without_mutation() {
        let mut state = GameState {
            board: Board { cols: [1, 1, 1, 1, 0, 0, 0, 0, 1, 1] },
            bag: enumset::EnumSet::all(),
            reserve: Piece::I,
            b2b: u32::MAX,
            combo: 0,
            pending_incoming_rows: 0,
            due_this_lock_rows: 0,
        };
        let before = state;
        let placement = Placement {
            location: PieceLocation { piece: Piece::I, rotation: Rotation::North, x: 5, y: 0 },
            spin: Spin::None,
        };
        assert_eq!(state.try_advance(Piece::I, placement), Err(AdvanceError::ChainOverflow));
        assert_eq!(state, before);
    }

    #[test]
    fn combo_saturates_at_u8_max() {
        assert_eq!(delta(255, 0, 1, Spin::None, false).combo_after, 255);
    }
}

#[cfg(test)]
mod amount_tests {
    use super::{
        advance_amount_only, amount_only_search_attack, s2_b2b_surge_rows, AdvanceError, Board, GameState, Piece, Spin,
        SEARCH_ATTACK_COMBO_LOG1P_FLOOR,
    };
    use enumset::EnumSet;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    fn empty_state(pending: u8, due: u8) -> GameState {
        GameState {
            board: Board { cols: [0; 10] },
            bag: EnumSet::all(),
            reserve: Piece::I,
            b2b: 0,
            combo: 0,
            pending_incoming_rows: pending,
            due_this_lock_rows: due,
        }
    }

    #[test]
    fn zero_amounts_hash_matches_five_field_prefix() {
        let state = empty_state(0, 0);
        let mut full = DefaultHasher::new();
        state.hash(&mut full);
        let mut prefix = DefaultHasher::new();
        state.board.hash(&mut prefix);
        state.bag.hash(&mut prefix);
        state.reserve.hash(&mut prefix);
        state.b2b.hash(&mut prefix);
        state.combo.hash(&mut prefix);
        assert_eq!(full.finish(), prefix.finish());
        const SIZE: usize = std::mem::size_of::<GameState>();
        assert!(SIZE <= 256, "GameState is {SIZE} bytes");
    }

    #[test]
    fn nonzero_amounts_split_the_hash() {
        let zero = empty_state(0, 0);
        let pending = empty_state(4, 0);
        let mut hz = DefaultHasher::new();
        let mut hp = DefaultHasher::new();
        zero.hash(&mut hz);
        pending.hash(&mut hp);
        assert_ne!(hz.finish(), hp.finish());
        assert_eq!(zero, empty_state(0, 0));
        assert_ne!(zero, pending);
    }

    #[test]
    fn search_attack_table_and_teto_rows() {
        assert_eq!(SEARCH_ATTACK_COMBO_LOG1P_FLOOR[0], 0);
        assert_eq!(SEARCH_ATTACK_COMBO_LOG1P_FLOOR[1], 0);
        assert_eq!(SEARCH_ATTACK_COMBO_LOG1P_FLOOR[2], 1);
        assert_eq!(amount_only_search_attack(0, Spin::Full, true, 9, 4, 4), Some(0));
        assert_eq!(amount_only_search_attack(1, Spin::None, false, 1, 0, 0), Some(0));
        assert_eq!(amount_only_search_attack(2, Spin::None, false, 1, 0, 0), Some(1));
        assert_eq!(amount_only_search_attack(1, Spin::Mini, false, 1, 0, 0), Some(0));
        assert_eq!(amount_only_search_attack(2, Spin::Mini, false, 1, 0, 0), Some(1));
        assert_eq!(amount_only_search_attack(1, Spin::Full, false, 1, 0, 0), Some(2));
        assert_eq!(amount_only_search_attack(2, Spin::None, false, 4, 0, 0), Some(1));
        let overflow = amount_only_search_attack(40, Spin::Full, true, 255, 4, 4).unwrap();
        assert!(overflow > 255);
    }

    #[test]
    fn canonical_surge_does_not_mix_with_legacy_amount_attack() {
        assert_eq!(amount_only_search_attack(1, Spin::None, false, 1, 0, 4), Some(3));
        assert_eq!(s2_b2b_surge_rows(1, Spin::None, false, 4), 0);
        assert_eq!(s2_b2b_surge_rows(1, Spin::None, false, 5), 4);
    }

    #[test]
    fn amount_advance_recurrence_and_overflow() {
        let skip = advance_amount_only(0, 0, 4, Spin::Full, false, 8, 4, 4).unwrap();
        assert!(!skip.search_attack_overflow);
        assert_eq!(skip.pending_after, 0);
        assert_eq!(skip.outgoing_before_cancel, 0);

        let clear = advance_amount_only(6, 2, 2, Spin::None, false, 1, 0, 0).unwrap();
        assert_eq!(clear.outgoing_before_cancel, 1);
        assert_eq!(clear.cancelled_rows, 1);
        assert_eq!(clear.tank_rows, 0);
        assert_eq!(clear.remaining_rows, 5);
        assert_eq!(clear.pending_after, 5);
        assert_eq!(clear.due_after, 5);

        let tank = advance_amount_only(6, 2, 0, Spin::None, false, 0, 0, 0).unwrap();
        assert_eq!(tank.tank_rows, 2);
        assert_eq!(tank.remaining_rows, 4);
        assert_eq!(tank.due_after, 4);

        let overflow = advance_amount_only(1, 1, 40, Spin::Full, true, 255, 4, 4).unwrap();
        assert!(overflow.search_attack_overflow);
        assert_eq!(overflow.pending_after, 1);
        assert_eq!(overflow.due_after, 1);

        assert_eq!(
            advance_amount_only(1, 2, 0, Spin::None, false, 0, 0, 0),
            Err(AdvanceError::InvalidIncoming)
        );
    }

    #[test]
    fn amount_transition_matches_canonical_amount_projection() {
        for pending in [0_u8, 1, 6, 20, 255] {
            for due in [0_u8, pending] {
                for lines in 0..=4 {
                    let old = advance_amount_only(
                        pending,
                        due,
                        lines,
                        Spin::None,
                        false,
                        if lines == 0 { 0 } else { 1 },
                        0,
                        0,
                    )
                    .unwrap();
                    assert!(!old.search_attack_overflow);
                    let canonical = crate::s2_core::advance_amounts(
                        crate::native_s2::Incoming {
                            pending_rows: u32::from(pending),
                            due_this_lock_rows: u32::from(due),
                        },
                        u32::from(old.outgoing_before_cancel),
                        lines,
                    )
                    .unwrap();
                    assert_eq!(
                        (
                            u32::from(old.cancelled_rows),
                            u32::from(old.tank_rows),
                            u32::from(old.remaining_rows),
                            u32::from(old.outgoing_after_cancel),
                            u32::from(old.due_after),
                        ),
                        (
                            canonical.cancelled_rows,
                            canonical.tank_rows,
                            canonical.remaining_rows,
                            canonical.outgoing_after_cancel,
                            canonical.due_rows_after_lock,
                        ),
                        "pending={pending} due={due} lines={lines}"
                    );
                }
            }
        }
    }

    #[test]
    fn invalid_incoming_transition_is_atomic() {
        let mut state = empty_state(1, 2);
        let before = state;
        let placement = super::Placement {
            location: super::PieceLocation {
                piece: Piece::I,
                rotation: super::Rotation::North,
                x: 5,
                y: 0,
            },
            spin: Spin::None,
        };
        assert_eq!(
            state.try_advance_with_surge(Piece::I, placement, false),
            Err(AdvanceError::InvalidIncoming)
        );
        assert_eq!(state, before);
    }
}
