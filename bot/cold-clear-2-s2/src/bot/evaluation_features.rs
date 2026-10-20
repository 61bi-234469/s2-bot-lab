//! Small, judgment-invariant board helpers shared by the legacy and S2 paths.
//!
//! This module deliberately contains only deterministic feature extraction and
//! T-slot geometry.  It does not own a selector, search policy, or a second
//! evaluator, so moving callers here cannot change candidate ordering.

use crate::data::{Board, Piece, PieceLocation, Rotation};

pub(crate) fn cell_coveredness(board: &Board, cap: u32) -> u32 {
    // Per hole at row y: min(height - y, cap). Holes below height - cap add
    // cap each; the rest add height - y, summed with popcounts instead of a
    // per-hole loop (same integer result, 2026-10-19 speed work).
    let heights: [u32; 10] = std::array::from_fn(|x| 64 - board.cols[x].leading_zeros());
    let holes: [u64; 10] = std::array::from_fn(|x| !board.cols[x] & ((1 << heights[x]) - 1));
    cell_coveredness_from(&heights, &holes, cap)
}

/// `cell_coveredness` from column heights and hole masks computed by the caller.
#[inline]
pub(crate) fn cell_coveredness_from(heights: &[u32; 10], holes: &[u64; 10], cap: u32) -> u32 {
    const BIT_PLANES: [u64; 6] = [
        0xAAAA_AAAA_AAAA_AAAA, 0xCCCC_CCCC_CCCC_CCCC, 0xF0F0_F0F0_F0F0_F0F0,
        0xFF00_FF00_FF00_FF00, 0xFFFF_0000_FFFF_0000, 0xFFFF_FFFF_0000_0000,
    ];
    let mut coveredness = 0;
    for (&height, &holes) in heights.iter().zip(holes.iter()) {
        if holes == 0 {
            continue;
        }
        let near = if height > cap { holes & !((1u64 << (height - cap)) - 1) } else { holes };
        let far = holes & !near;
        let row_sum: u32 = BIT_PLANES.iter().enumerate().map(|(j, &m)| (near & m).count_ones() << j).sum();
        coveredness += far.count_ones() * cap + near.count_ones() * height - row_sum;
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
    let heights: [u32; 10] = std::array::from_fn(|x| 64 - board.cols[x].leading_zeros());
    tetris_well_depth_from(board, &heights)
}

/// `tetris_well_depth` with the column heights computed by the caller.
#[inline]
pub(crate) fn tetris_well_depth_from(board: &Board, heights: &[u32; 10]) -> u32 {
    let (tetris_well_column, tetris_well_height) = heights
        .iter()
        .copied()
        .enumerate()
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

/// `well_known_tslot_left(board).or_else(|| well_known_tslot_right(board))`
/// with the column heights computed once (decision-compatible speed work,
/// 2026-10-18). Cells outside the 40-row board count as occupied, as in
/// `Board::occupied`.
pub(crate) fn well_known_tslot(board: &Board) -> Option<PieceLocation> {
    let mut heights = [0u32; 10];
    for (h, &c) in heights.iter_mut().zip(board.cols.iter()) {
        *h = 64 - c.leading_zeros();
    }
    let occupied = |x: usize, y: i32| y < 0 || y >= 40 || board.cols[x] >> y & 1 != 0;
    let slot = |x: usize, y: u32| PieceLocation { piece: Piece::T, rotation: Rotation::South, x: x as i8 + 1, y: y as i8 };
    for x in 0..8 {
        let y = heights[x];
        if heights[x + 1] >= y {
            continue;
        }
        let yi = y as i8 as i32;
        if occupied(x + 2, yi - 1) && !occupied(x + 2, yi) && occupied(x + 2, yi + 1) {
            return Some(slot(x, y));
        }
    }
    for x in 0..8 {
        let y = heights[x + 2];
        if heights[x + 1] >= y {
            continue;
        }
        let yi = y as i8 as i32;
        if occupied(x, yi - 1) && !occupied(x, yi) && occupied(x, yi + 1) {
            return Some(slot(x, y));
        }
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
    fn coveredness_popcount_sum_matches_the_per_hole_loop() {
        fn per_hole(board: &Board, cap: u32) -> u32 {
            let mut coveredness = 0;
            for &c in &board.cols {
                let height = 64 - c.leading_zeros();
                let mut holes = !c & ((1 << height) - 1);
                while holes != 0 {
                    let y = holes.trailing_zeros();
                    coveredness += (height - y).min(cap);
                    holes &= !(1 << y);
                }
            }
            coveredness
        }
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        for i in 0..20_000 {
            let mut board = Board::default();
            for column in board.cols.iter_mut() {
                state ^= state << 13; state ^= state >> 7; state ^= state << 17;
                *column = state >> (1 + state % 63);
            }
            for cap in [0, 1, 3, 6, 10, 40, 63, 100] {
                assert_eq!(cell_coveredness(&board, cap), per_hole(&board, cap), "case {i} cap {cap}");
            }
        }
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
    fn combined_tslot_matches_left_then_right_at_height_boundaries() {
        // Heights 39 and 40 touch the board edge; 63 and 64 are reachable only
        // through bits above the 40-row board, which `Board::occupied` treats
        // as occupied.
        for h in [1u32, 2, 38, 39, 40, 41, 63, 64] {
            for x in 0..10usize {
                for (lower, notch) in [(0u32, false), (1, false), (1, true), (2, true)] {
                    let mut board = Board::default();
                    for (i, c) in board.cols.iter_mut().enumerate() {
                        let height = if i == x { h } else if i % 2 == 0 { h.saturating_sub(lower) } else { h.saturating_sub(lower + 1) };
                        *c = if height >= 64 { !0 } else { (1u64 << height) - 1 };
                        if notch && height >= 2 { *c &= !(1u64 << (height - 2)); }
                    }
                    assert_eq!(well_known_tslot(&board), well_known_tslot_left(&board).or_else(|| well_known_tslot_right(&board)), "h {h} x {x}");
                }
            }
        }
    }

    #[test]
    fn combined_tslot_matches_left_then_right_on_random_boards() {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut next = || { state ^= state << 13; state ^= state >> 7; state ^= state << 17; state };
        for round in 0..200_000 {
            let mut board = Board::default();
            let top = (next() % 41) as u32;
            for c in &mut board.cols {
                let h = (next() % (u64::from(top) + 1)) as u32;
                let mask = if h == 0 { 0 } else { (1u64 << h) - 1 };
                *c = next() & mask | if h > 0 { 1u64 << (h - 1) } else { 0 };
                if round % 7 == 0 { *c |= (1u64 << h) - 1; }
            }
            assert_eq!(well_known_tslot(&board), well_known_tslot_left(&board).or_else(|| well_known_tslot_right(&board)), "{board:?}");
        }
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
