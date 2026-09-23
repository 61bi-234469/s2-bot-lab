//! Small, judgment-invariant board helpers shared by the legacy and S2 paths.
//!
//! This module deliberately contains only deterministic feature extraction and
//! T-slot geometry.  It does not own a selector, search policy, or a second
//! evaluator, so moving callers here cannot change candidate ordering.

use crate::data::{Board, Piece, PieceLocation, Rotation};

pub(crate) fn cell_coveredness(board: &Board, cap: u32) -> u32 {
    let mut coveredness = 0;
    for &c in &board.cols {
        let height = 64 - c.leading_zeros();
        let underneath = (1 << height) - 1;
        let mut holes = !c & underneath;
        while holes != 0 {
            let y = holes.trailing_zeros();
            coveredness += (height - y).min(cap);
            holes &= !(1 << y);
        }
    }
    coveredness
}

// Preserve CC2's 64-bit wall definition, including the constant empty upper rows.
pub(crate) fn row_transitions(board: &Board) -> u32 {
    let mut transitions = (!0 ^ board.cols[0]).count_ones();
    transitions += (!0 ^ board.cols[9]).count_ones();
    for cs in board.cols.windows(2) {
        transitions += (cs[0] ^ cs[1]).count_ones();
    }
    transitions
}

// Preserve the legacy evaluator's column-minimum tie break, 64-bit board
// mask, and trailing-ones arithmetic.  S2 uses this only as a committed
// preview leaf feature; it is not an edge reward or a selector.
pub(crate) fn tetris_well_depth(board: &Board) -> u32 {
    let (tetris_well_column, tetris_well_height) = board
        .cols
        .iter()
        .enumerate()
        .map(|(i, &c)| (i, 64 - c.leading_zeros()))
        .min_by_key(|&(_, h)| h)
        .expect("board has ten columns");
    let full_lines_except_well = board
        .cols
        .iter()
        .enumerate()
        .filter(|&(i, _)| i != tetris_well_column)
        .map(|(_, &c)| c)
        .fold(!0, |a, b| a & b);
    (full_lines_except_well >> tetris_well_height).trailing_ones()
}

pub(crate) fn well_known_tslot_left(board: &Board) -> Option<PieceLocation> {
    for (x, cols) in board.cols.windows(3).enumerate() {
        let y = 64 - cols[0].leading_zeros();
        if 64 - cols[1].leading_zeros() >= y {
            continue;
        }
        if !board.occupied((x as i8 + 2, y as i8 - 1)) {
            continue;
        }
        if board.occupied((x as i8 + 2, y as i8)) {
            continue;
        }
        if !board.occupied((x as i8 + 2, y as i8 + 1)) {
            continue;
        }
        return Some(PieceLocation {
            piece: Piece::T,
            rotation: Rotation::South,
            x: x as i8 + 1,
            y: y as i8,
        });
    }
    None
}

pub(crate) fn well_known_tslot_right(board: &Board) -> Option<PieceLocation> {
    for (x, cols) in board.cols.windows(3).enumerate() {
        let y = 64 - cols[2].leading_zeros();
        if 64 - cols[1].leading_zeros() >= y {
            continue;
        }
        if !board.occupied((x as i8, y as i8 - 1)) {
            continue;
        }
        if board.occupied((x as i8, y as i8)) {
            continue;
        }
        if !board.occupied((x as i8, y as i8 + 1)) {
            continue;
        }
        return Some(PieceLocation {
            piece: Piece::T,
            rotation: Rotation::South,
            x: x as i8 + 1,
            y: y as i8,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coveredness_cap_is_applied_per_hole() {
        let mut board = Board::default();
        board.cols[0] = 0b101;
        assert_eq!(cell_coveredness(&board, 1), 1);
        assert_eq!(cell_coveredness(&board, 10), 2);
    }

    #[test]
    fn empty_board_keeps_cc2s_64_bit_wall_transition_definition() {
        assert_eq!(row_transitions(&Board::default()), 128);
    }

    #[test]
    fn tetris_well_depth_keeps_legacy_minimum_column_and_64_bit_mask() {
        let mut board = Board::default();
        board.cols[0] = 0b111;
        for column in board.cols.iter_mut().skip(1) { *column = !0; }
        assert_eq!(tetris_well_depth(&board), 61);
        assert_eq!(tetris_well_depth(&Board::default()), 0);
    }

    #[test]
    fn tslot_helpers_are_stable_for_the_same_board() {
        let mut board = Board::default();
        for x in 0..10 {
            if x != 4 {
                board.cols[x] |= 1 << 1;
            }
            if !(3..=5).contains(&x) {
                board.cols[x] |= 1 << 2;
            }
        }
        board.cols[5] |= 1 << 3;
        let left = well_known_tslot_left(&board).expect("left T-slot");
        assert_eq!((left.piece, left.rotation, left.x, left.y), (Piece::T, Rotation::South, 4, 2));
        assert_eq!(well_known_tslot_left(&board), Some(left));

        let mut mirrored = Board::default();
        mirrored.cols[3] = 0b1010;
        mirrored.cols[5] = 0b010;
        let right = well_known_tslot_right(&mirrored).expect("right T-slot");
        assert_eq!((right.piece, right.rotation, right.x, right.y), (Piece::T, Rotation::South, 4, 2));
        assert_eq!(well_known_tslot_right(&mirrored), Some(right));
    }
}
