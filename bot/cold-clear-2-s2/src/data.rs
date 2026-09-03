use enum_map::Enum;
use enumset::{EnumSet, EnumSetType};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Deserialize)]
#[serde(from = "Vec<[Option<char>; 10]>")]
pub struct Board {
    pub cols: [u64; 10],
}

/// Search B2B is saturated at the observed `b2bcharge_at` (4). Eval only reads
/// `b2b > 0` and `b2b >= 4`; a fifth bucket would split transposition unused.
pub const B2B_SAT: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct GameState {
    pub board: Board,
    pub bag: EnumSet<Piece>,
    pub reserve: Piece,
    pub b2b: u8,
    pub combo: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainDelta {
    pub combo_after: u8,
    pub b2b_after: u8,
    pub continuing_b2b: bool,
}

/// Canonical `advanceChain` if-else with observed `perfectClearB2bBonus = 1`,
/// then B2B sat at [`B2B_SAT`]. PC charges +1 and is not stacked on difficult.
pub fn advance_chain(
    combo: u8,
    b2b: u8,
    lines: u32,
    spin: Spin,
    perfect_clear: bool,
) -> ChainDelta {
    let b2b = b2b.min(B2B_SAT);
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
            b2b_after: b2b.saturating_add(1).min(B2B_SAT),
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
    pub fn advance(&mut self, next: Piece, placement: Placement) -> PlacementInfo {
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
        let delta = advance_chain(
            self.combo,
            self.b2b,
            lines_cleared,
            placement.spin,
            perfect_clear,
        );
        self.combo = delta.combo_after;
        self.b2b = delta.b2b_after;
        PlacementInfo {
            placement,
            lines_cleared,
            combo: self.combo as u32,
            back_to_back: delta.continuing_b2b,
            perfect_clear,
        }
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
    use super::{advance_chain, ChainDelta, Spin, B2B_SAT};

    fn delta(combo: u8, b2b: u8, lines: u32, spin: Spin, pc: bool) -> ChainDelta {
        advance_chain(combo, b2b, lines, spin, pc)
    }

    #[test]
    fn golden_chain_cases_with_sat_4() {
        // fixtures/golden/chain-and-surge.json chainCases, B2B clamped to B2B_SAT.
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
            ChainDelta { combo_after: 0, b2b_after: B2B_SAT, continuing_b2b: false }
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
    fn b2b_saturates_at_charge_threshold() {
        assert_eq!(delta(1, 4, 4, Spin::None, false).b2b_after, 4);
        assert_eq!(delta(1, 4, 1, Spin::Mini, true).b2b_after, 4);
    }

    #[test]
    fn combo_saturates_at_u8_max() {
        assert_eq!(delta(255, 0, 1, Spin::None, false).combo_after, 255);
    }
}
