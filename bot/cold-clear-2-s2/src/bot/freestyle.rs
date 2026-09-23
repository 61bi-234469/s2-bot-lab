use std::ops::Add;

use enum_map::EnumMap;
use enumset::EnumSet;
use ordered_float::OrderedFloat;
use parking_lot::Mutex;
use rand::{rngs::StdRng, SeedableRng};
use serde::{Deserialize, Serialize};

use super::{BotOptions, Mode, ModeSwitch, Statistics};
use super::evaluation_features::{
    cell_coveredness, row_transitions, tetris_well_depth, well_known_tslot_left,
    well_known_tslot_right,
};
use crate::dag::{ChildData, Dag, Evaluation};
use crate::data::*;
use crate::movegen::{find_moves, find_moves_complete_with_entry, RootEntry};
use crate::f14_compat::{CompatError, select::{PublicRootLockContext, RootObjectiveSession}};

pub struct Freestyle {
    dag: Dag<Eval>,
    rng: Mutex<StdRng>,
}

impl Freestyle {
    pub fn new(options: &BotOptions, root: GameState, queue: &[Piece]) -> Self {
        Freestyle {
            dag: Dag::new(root, queue),
            rng: Mutex::new(StdRng::seed_from_u64(options.config.search_seed)),
        }
    }
}

impl Mode for Freestyle {
    fn advance(&mut self, _options: &BotOptions, mv: Placement) -> Option<ModeSwitch> {
        puffin::profile_function!();
        self.dag.advance_with_surge(mv, _options.config.enable_s2_b2b_surge);
        None
    }

    fn new_piece(&mut self, _options: &BotOptions, piece: Piece) {
        puffin::profile_function!();
        self.dag.add_piece(piece);
    }

    fn suggest(&self, options: &BotOptions) -> Vec<(Placement, f32)> {
        puffin::profile_function!();
        self.dag
            .suggest(options.config.suggestion_count.clamp(1, 64))
    }

    fn do_work(
        &self,
        options: &BotOptions,
        session: Option<&RootObjectiveSession>,
    ) -> Result<Statistics, CompatError> {
        if let Some(root) = session {
            // Observe the Legacy root before the next native draw. Existing
            // OFF sessions keep this as a no-op; root-value mode refreshes its
            // accepted depth-one values without remapping the native draw.
            root.observe_legacy_root(self.dag.legacy_root_snapshot())?;
            if root.uses_root_values() {
                self.apply_root_values(root)?;
            }
        }
        // Allocation OFF owns only the post-search ranking bundle. It must not
        // feed public-root priority back into native search ordering.
        let stats = self.do_work_with_root_priority_observed(options, None, session)?;
        if let Some(root) = session {
            if root.uses_root_values() {
                root.observe_legacy_root(self.dag.legacy_root_snapshot())?;
                self.apply_root_values(root)?;
            }
            root.complete_work(&stats, || {
                self.dag.suggest(options.config.suggestion_count.clamp(1, 64))
            })?;
        }
        Ok(stats)
    }
}

impl Freestyle {
    pub(super) fn root_priorities(&self) -> Vec<(Placement, bool, f32)> {
        self.dag.root_priorities()
    }

    pub(super) fn do_work_with_root_priority(
        &self, options: &BotOptions, priority: Option<&PublicRootLockContext>,
    ) -> Result<Statistics, CompatError> {
        self.do_work_with_root_priority_observed(options, priority, None)
    }

    fn do_work_with_root_priority_observed(
        &self,
        options: &BotOptions,
        priority: Option<&PublicRootLockContext>,
        observation: Option<&RootObjectiveSession>,
    ) -> Result<Statistics, CompatError> {
        puffin::profile_function!();
        let mut new_stats = Statistics::default();
        new_stats.selections += 1;

        let node = if let Some(root) = observation.filter(|root| {
            root.allocation_mode() == crate::f14_compat::select::AllocationMode::PermutationV1
        }) {
            let map = crate::f14_compat::select::RootSelectionBinding::new(root);
            self.dag.select_with_surge_root(
                options.speculate,
                options.config.freestyle_exploitation,
                &mut *self.rng.lock(),
                options.config.enable_s2_b2b_surge,
                Some(&map),
            )?
        } else {
            self.dag.select_with_surge(
                options.speculate,
                options.config.freestyle_exploitation,
                &mut *self.rng.lock(),
                options.config.enable_s2_b2b_surge,
            )
        };
        if let Some(node) = node {
            if let (Some(root), Some(draw_index)) = (observation, node.root_draw_index()) {
                root.record_native_draw(draw_index);
            }
            let (state, next) = node.state();
            let root_edge = node.is_root();
            let next_possibilities = next.map(EnumSet::only).unwrap_or(state.bag);

            let mut moves = EnumMap::default();
            {
                puffin::profile_scope!("movegen");
                for piece in next_possibilities | state.reserve {
                    moves[piece] =
                        find_moves(&state.board, piece, options.config.enable_direct_180);
                }
                if options.config.enable_spawn_buffer_entry
                    && node.is_root()
                    && (next_possibilities | state.reserve)
                        .iter()
                        .all(|p| moves[p].is_empty())
                {
                    for piece in next_possibilities | state.reserve {
                        moves[piece] = find_moves_complete_with_entry(
                            &state.board,
                            piece,
                            options.config.enable_direct_180,
                            RootEntry::SpawnBufferFallback,
                        )
                        .moves;
                    }
                }
            }

            let mut children: EnumMap<_, Vec<_>> = EnumMap::default();

            {
                puffin::profile_scope!("eval");
                for next in next_possibilities {
                    let moves = moves[next].iter().chain(if next == state.reserve {
                        [].iter()
                    } else {
                        moves[state.reserve].iter()
                    });
                    for &(mv, sd_distance) in moves {
                        let mut state = state;
                        let pending_rows_before_lock = state.pending_incoming_rows;
                        let info = state
                            .try_advance_with_surge(next, mv, options.config.enable_s2_b2b_surge)
                            .map_err(|_| CompatError::ChainOverflow)?;
                        if info.search_attack_overflow {
                            continue;
                        }
                        let amount_top_out = amount_tops_out(
                            options.config.enable_s2_amount_only_incoming,
                            &state.board,
                            &info,
                        );
                        if amount_top_out && !options.config.amount_top_out_edge_retention() {
                            new_stats.amount_top_out_omitted += 1;
                            continue;
                        }
                        if amount_top_out {
                            new_stats.amount_top_out_retained += 1;
                        }
                        let amount_top_out_reward =
                            amount_top_out && options.config.amount_top_out_reward();
                        if amount_top_out_reward {
                            new_stats.amount_top_out_priced += 1;
                        }

                        let (eval, reward) = evaluate_with_surge(
                            &options.config.freestyle_weights,
                            state,
                            &info,
                            sd_distance,
                            options.config.enable_spawn_occupancy_eval,
                            options.config.enable_s2_amount_only_incoming,
                            amount_top_out_reward,
                            options.config.enable_real_board_structural_eval,
                            options.config.enable_tslot_nonmutating_dedup,
                            options.config.enable_s2_tank_risk_shaping,
                            options.config.enable_s2_b2b_surge,
                            root_edge,
                            pending_rows_before_lock,
                        );

                        children[next].push(ChildData {
                            resulting_state: state,
                            mv,
                            eval,
                            reward,
                            root_priority: if node.is_root() {
                                priority.map(|context| context.inside_margin(mv)).transpose()?.unwrap_or(false)
                            } else { false },
                        });
                    }

                    new_stats.nodes += children[next].len() as u64;
                }
            }

            new_stats.expansions += 1;
            node.expand(children);
        }

        Ok(new_stats)
    }

    fn apply_root_values(&self, root: &RootObjectiveSession) -> Result<(), CompatError> {
        let values = root.root_value_assignments()?;
        let applied = self.dag.apply_legacy_root_scores(&values, |value| Eval {
            value: OrderedFloat(value),
        });
        if applied != values.len() {
            return Err(CompatError::RootAllocationBindingMismatch);
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Weights {
    pub cell_coveredness: f32,
    pub max_cell_covered_height: u32,
    pub holes: f32,
    pub row_transitions: f32,
    pub height: f32,
    pub height_upper_half: f32,
    pub height_upper_quarter: f32,
    pub tetris_well_depth: f32,
    pub tslot: [f32; 4],

    pub has_back_to_back: f32,
    pub wasted_t: f32,
    pub softdrop: f32,

    pub normal_clears: [f32; 5],
    pub mini_spin_clears: [f32; 4],
    pub spin_clears: [f32; 4],
    pub back_to_back_clear: f32,
    pub combo_attack: f32,
    pub perfect_clear: f32,
    pub perfect_clear_override: bool,
    #[serde(default)]
    pub s2_amount_exchange: f32,
    #[serde(default, skip_serializing_if = "is_zero_f32")]
    pub s2_cancel_value: f32,
    #[serde(default, skip_serializing_if = "is_zero_f32")]
    pub s2_amount_top_out: f32,
    #[serde(default, skip_serializing_if = "is_zero_f32")]
    pub s2_b2b_surge: f32,
    #[serde(default, skip_serializing_if = "is_zero_f32")]
    pub s2_b2b_charge: f32,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub s2_b2b_charge_cap_rows: u32,
    #[serde(default, skip_serializing_if = "is_zero_f32")]
    pub s2_amount_solvency_rescue_value: f32,
}

fn is_zero_f32(value: &f32) -> bool {
    *value == 0.0
}

fn is_zero_u32(value: &u32) -> bool {
    *value == 0
}

fn evaluate(
    weights: &Weights,
    state: GameState,
    info: &PlacementInfo,
    softdrop: u32,
    enable_spawn_occupancy_eval: bool,
    enable_s2_amount_only_incoming: bool,
    amount_top_out: bool,
    enable_real_board_structural_eval: bool,
    enable_tslot_nonmutating_dedup: bool,
    enable_s2_tank_risk_shaping: bool,
) -> (Eval, Reward) {
    evaluate_with_surge(
        weights, state, info, softdrop, enable_spawn_occupancy_eval,
        enable_s2_amount_only_incoming, amount_top_out, enable_real_board_structural_eval,
        enable_tslot_nonmutating_dedup, enable_s2_tank_risk_shaping, false, false, 0,
    )
}

fn evaluate_with_surge(
    weights: &Weights,
    mut state: GameState,
    info: &PlacementInfo,
    softdrop: u32,
    enable_spawn_occupancy_eval: bool,
    enable_s2_amount_only_incoming: bool,
    amount_top_out: bool,
    enable_real_board_structural_eval: bool,
    enable_tslot_nonmutating_dedup: bool,
    enable_s2_tank_risk_shaping: bool,
    enable_s2_b2b_surge: bool,
    is_root_edge: bool,
    pending_rows_before_lock: u8,
) -> (Eval, Reward) {
    let real_board = state.board;
    let mut eval = 0.0;
    let mut reward = 0.0;

    // line clear rewards
    if info.perfect_clear {
        reward += weights.perfect_clear;
    }
    if !info.perfect_clear || !weights.perfect_clear_override {
        if info.back_to_back {
            reward += weights.back_to_back_clear;
        }
        match info.placement.spin {
            Spin::None => reward += weights.normal_clears[info.lines_cleared as usize],
            Spin::Mini => reward += weights.mini_spin_clears[info.lines_cleared as usize],
            Spin::Full => reward += weights.spin_clears[info.lines_cleared as usize],
        }
        reward += weights.combo_attack * (info.combo.saturating_sub(1) / 2) as f32;
    }

    // checklist
    if info.placement.location.piece == Piece::T
        && (info.lines_cleared < 2 || !matches!(info.placement.spin, Spin::Full))
    {
        reward += weights.wasted_t;
    }
    if state.b2b > 0 {
        eval += weights.has_back_to_back;
    }
    if state.b2b >= 4 {
        eval += weights.has_back_to_back;
    }
    reward += weights.softdrop * softdrop as f32;
    if enable_s2_b2b_surge {
        reward += weights.s2_b2b_surge * info.surge_rows as f32;
    }
    if enable_s2_b2b_surge && weights.s2_b2b_charge != 0.0 && weights.s2_b2b_charge_cap_rows > 0 {
        eval += weights.s2_b2b_charge
            * potential_surge_rows(state.b2b).min(weights.s2_b2b_charge_cap_rows) as f32;
    }
    if enable_s2_amount_only_incoming {
        reward += weights.s2_amount_exchange * amount_exchange_rows(&state.board, info);
        if info.cancelled_rows > 0 && weights.s2_cancel_value != 0.0 {
            reward += weights.s2_cancel_value * f32::from(info.cancelled_rows);
        }
        if enable_s2_tank_risk_shaping && info.tank_rows > 0 {
            // This is an edge cost, not shared node Eval: it must survive expansion
            // and must not leak between parents of a transposed child.
            reward += tank_height_cost(weights, &real_board, info.tank_rows);
        }
        if amount_top_out {
            reward += weights.s2_amount_top_out;
        }
        if is_root_edge {
            reward += amount_solvency_rescue_reward(
                weights, pending_rows_before_lock, &real_board, info,
            );
        }
    }

    // Inspect the real post-lock/post-clear board before the cutout preview
    // below mutates only this evaluator's local state copy.
    if enable_spawn_occupancy_eval {
        let sources = if state.bag.is_empty() {
            EnumSet::all()
        } else {
            state.bag | state.reserve
        };
        let blocked = sources
            .iter()
            .filter(|&piece| native_spawn_obstructed(&state.board, piece))
            .count();
        eval += weights.height_upper_quarter * blocked as f32;
    }

    // cutouts
    let cutout_count = state.bag.contains(Piece::T) as usize
        + (state.reserve == Piece::T) as usize
        + (state.bag.len() <= 3) as usize;
    for _ in 0..cutout_count {
        let location =
            well_known_tslot_left(&state.board).or_else(|| well_known_tslot_right(&state.board));
        let location = match location {
            Some(v) => v,
            None => break,
        };
        let mut board = state.board;
        board.place(location);
        eval += weights.tslot[board.line_clears().count_ones() as usize];
        if board.line_clears().count_ones() > 1 {
            board.remove_lines(board.line_clears());
            state.board = board;
        } else if enable_tslot_nonmutating_dedup {
            // The next iteration would score the identical non-mutating preview.
            break;
        }
    }

    // Preserve the entire preview above (including repeated bonuses). Only the
    // existing structural costs below switch their scoring board.
    if enable_real_board_structural_eval {
        state.board = real_board;
    }

    // holes
    eval += weights.holes
        * state
            .board
            .cols
            .iter()
            .map(|&c| {
                let height = 64 - c.leading_zeros();
                let underneath = (1 << height) - 1;
                let holes = !c & underneath;
                holes.count_ones()
            })
            .sum::<u32>() as f32;

    // cell coveredness
    let coveredness = cell_coveredness(&state.board, weights.max_cell_covered_height);
    eval += weights.cell_coveredness * coveredness as f32;

    // tetris well depth
    eval += tetris_well_depth(&state.board) as f32 * weights.tetris_well_depth;

    // height
    let highest_point = state
        .board
        .cols
        .iter()
        .map(|&c| 64 - c.leading_zeros())
        .max()
        .unwrap();
    eval += weights.height * highest_point as f32;
    if highest_point > 10 {
        eval += weights.height_upper_half * (highest_point - 10) as f32;
    }
    if highest_point > 15 {
        eval += weights.height_upper_quarter * (highest_point - 15) as f32;
    }

    // row transitions
    eval += row_transitions(&state.board) as f32 * weights.row_transitions;

    (
        Eval { value: eval.into() },
        Reward {
            value: reward.into(),
        },
    )
}

fn potential_surge_rows(b2b: u32) -> u32 {
    crate::data::s2_b2b_surge_rows(1, Spin::None, false, b2b)
}

fn occupied_height(board: &Board) -> u32 {
    board
        .cols
        .iter()
        .map(|&c| 64 - c.leading_zeros())
        .max()
        .unwrap()
}

fn tank_height_cost(weights: &Weights, board: &Board, tank_rows: u8) -> f32 {
    let h = occupied_height(board);
    let height_cost = |x: u32| {
        weights.height * x as f32
            + weights.height_upper_half * x.saturating_sub(10) as f32
            + weights.height_upper_quarter * x.saturating_sub(15) as f32
    };
    height_cost(h + u32::from(tank_rows)) - height_cost(h)
}

fn amount_exchange_rows(board: &Board, info: &PlacementInfo) -> f32 {
    let h = occupied_height(board);
    let t = info.tank_rows;
    let c = info.cancelled_rows;
    let o = info.outgoing_after_cancel;
    let r = info.remaining_rows;
    let post_tank_headroom = 20 - 20.min(h.saturating_add(u32::from(t)));
    let tank_risk_rows = f32::from(t) * ((20 - post_tank_headroom) as f32) / 20.0;
    f32::from(c) + f32::from(o) - f32::from(r) - tank_risk_rows
}

fn amount_solvency_rescue_reward(
    weights: &Weights,
    pending_rows_before_lock: u8,
    post_lock_board: &Board,
    info: &PlacementInfo,
) -> f32 {
    let coefficient = weights.s2_amount_solvency_rescue_value;
    if coefficient == 0.0 || pending_rows_before_lock == 0 {
        return 0.0;
    }
    let projected_pending = u16::from(info.cancelled_rows)
        + u16::from(info.tank_rows)
        + u16::from(info.remaining_rows);
    if projected_pending != u16::from(pending_rows_before_lock) {
        debug_assert_eq!(projected_pending, u16::from(pending_rows_before_lock));
        return 0.0;
    }
    let occupied = occupied_height(post_lock_board);
    let tank = u32::from(info.tank_rows);
    let remaining = i32::from(info.remaining_rows);
    let solvency = 20 - occupied as i32 - tank as i32 - remaining;
    let amount_topped_out = occupied + tank > 20;
    if !amount_topped_out && solvency >= 0 { coefficient } else { 0.0 }
}

fn amount_tops_out(enabled: bool, board: &Board, info: &PlacementInfo) -> bool {
    enabled
        && info.tank_rows > 0
        && occupied_height(board).saturating_add(u32::from(info.tank_rows)) > 20
}

fn native_spawn_obstructed(board: &Board, piece: Piece) -> bool {
    PieceLocation {
        piece,
        rotation: Rotation::North,
        x: 4,
        y: 19,
    }
    .obstructed(board)
}

#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
struct Eval {
    value: OrderedFloat<f32>,
}

#[derive(Copy, Clone, Debug)]
struct Reward {
    value: OrderedFloat<f32>,
}

impl Evaluation for Eval {
    type Reward = Reward;
    type Domain = crate::dag::domain::LegacyDomain;

    fn average(of: impl Iterator<Item = Option<Self>>) -> Self {
        let mut count = 0;
        let sum: f32 = of
            .map(|v| {
                count += 1;
                v.map(|e| e.value.0).unwrap_or(-1000.0)
            })
            .sum();
        Eval {
            value: (sum / count as f32).into(),
        }
    }

    fn value(self) -> f32 {
        self.value.0
    }
}

impl Add<Reward> for Eval {
    type Output = Self;

    fn add(self, rhs: Reward) -> Eval {
        Eval {
            value: self.value + rhs.value,
        }
    }
}

#[cfg(test)]
mod real_board_tests {
    use super::*;

    fn cutout(base: u32) -> Board {
        let mut board = Board::default();
        for x in 0..10 {
            if x != 4 { board.cols[x] |= 1 << base; }
            if !(3..=5).contains(&x) { board.cols[x] |= 1 << (base + 1); }
        }
        board.cols[5] |= 1 << (base + 2);
        board
    }

    fn score(board: Board, weights: &Weights, enabled: bool) -> (Eval, Reward) {
        score_with_dedup(board, weights, enabled, false)
    }

    fn score_with_dedup(board: Board, weights: &Weights, enabled: bool, dedup: bool) -> (Eval, Reward) {
        let state = GameState { board, bag: EnumSet::only(Piece::T), reserve: Piece::T,
            b2b: 0, combo: 0, pending_incoming_rows: 0, due_this_lock_rows: 0 };
        let info = PlacementInfo {
            placement: Placement { location: PieceLocation { piece: Piece::I,
                rotation: Rotation::North, x: 4, y: 0 }, spin: Spin::None },
            lines_cleared: 0, combo: 0, back_to_back: false, perfect_clear: false,
            cancelled_rows: 0, tank_rows: 0, remaining_rows: 0, outgoing_after_cancel: 0,
            surge_rows: 0,
            search_attack_overflow: false,
        };
        evaluate(weights, state, &info, 0, false, false, false, enabled, dedup, false)
    }

    fn weights() -> Weights {
        let mut w = crate::bot::BotConfig::default().freestyle_weights;
        w.holes = 1.0; w.cell_coveredness = 1.0; w.height = 1.0;
        w.height_upper_half = 1.0; w.height_upper_quarter = 1.0;
        w.row_transitions = 1.0; w.tetris_well_depth = 1.0;
        w.tslot = [0.0, 2.0, 3.0, 4.0];
        w
    }

    #[test]
    fn low_cutout_real_board_oracle_and_off_preview_are_distinct() {
        let board = cutout(1);
        let before = board;
        let (on, on_reward) = score(board, &weights(), true);
        let (off, off_reward) = score(board, &weights(), false);
        // Real board: 10 holes, 29 coveredness, height 4, 130 horizontal
        // transitions, zero well depth and no upper-height terms; TSD preview +3.
        assert_eq!(on.value.0, 10.0 + 29.0 + 4.0 + 130.0 + 3.0);
        // Preview has one cell at (5,1): one hole, cover 2, height 2, transitions 130.
        assert_eq!(off.value.0, 1.0 + 2.0 + 2.0 + 130.0 + 3.0);
        assert_eq!(on_reward.value, off_reward.value);
        assert_eq!(board, before);
    }

    #[test]
    fn high_cutout_charges_all_real_height_bands() {
        let mut w = weights();
        w.holes = 0.0; w.cell_coveredness = 0.0; w.row_transitions = 0.0;
        w.tetris_well_depth = 0.0;
        assert_eq!(score(cutout(19), &w, true).0.value.0, 22.0 + 12.0 + 7.0 + 3.0);
        assert_eq!(score(cutout(19), &w, false).0.value.0, 20.0 + 10.0 + 5.0 + 3.0);
    }

    #[test]
    fn no_cutout_identity_and_repeated_single_clear_preview_bonus() {
        let w = weights();
        assert_eq!(score(Board::default(), &w, true).0, score(Board::default(), &w, false).0);
        let mut board = cutout(1);
        board.cols[9] &= !(1 << 2); // Only one preview line; loop never replaces board.
        let mut no_bonus = w.clone(); no_bonus.tslot = [0.0; 4];
        for flag in [false, true] {
            assert_eq!(score(board, &w, flag).0.value.0 - score(board, &no_bonus, flag).0.value.0, 6.0);
        }
        assert_eq!(score(board, &w, true).0, score(board, &w, false).0);
    }

    fn preview_lines(mut board: Board, dedup: bool) -> Vec<u32> {
        let mut lines = Vec::new();
        for _ in 0..3 {
            let Some(location) = well_known_tslot_left(&board).or_else(|| well_known_tslot_right(&board)) else { break; };
            let mut next = board;
            next.place(location);
            let count = next.line_clears().count_ones();
            lines.push(count);
            if count > 1 { next.remove_lines(next.line_clears()); board = next; }
            else if dedup { break; }
        }
        lines
    }

    #[test]
    fn dedup_retains_first_zero_penalty_and_single_reward() {
        let mut w = weights(); w.tslot[0] = -1.0;
        for lines in [0, 1] {
            let mut board = cutout(1);
            board.cols[9] &= !(1 << 2);
            if lines == 0 { board.cols[9] &= !(1 << 1); }
            assert_eq!(preview_lines(board, false), vec![lines; 3]);
            assert_eq!(preview_lines(board, true), vec![lines]);
            let mut no_bonus = w.clone(); no_bonus.tslot = [0.0; 4];
            let base = score_with_dedup(board, &no_bonus, false, false).0.value.0;
            let (off, off_reward) = score_with_dedup(board, &w, false, false);
            let (on, on_reward) = score_with_dedup(board, &w, false, true);
            assert_eq!(off.value.0 - base, 3.0 * w.tslot[lines as usize]);
            assert_eq!(on.value.0 - base, w.tslot[lines as usize]);
            assert_eq!(off_reward.value, on_reward.value);
        }
    }

    #[test]
    fn dedup_preserves_multi_cutouts_and_stops_only_nonmutating_tail() {
        let mut board = cutout(1);
        let top = cutout(4);
        for x in 0..10 { board.cols[x] |= top.cols[x]; }
        assert_eq!(preview_lines(board, false), vec![2, 2]);
        assert_eq!(preview_lines(board, true), vec![2, 2]);
        let w = weights();
        assert_eq!(score_with_dedup(board, &w, false, false).0, score_with_dedup(board, &w, false, true).0);
        board.cols[9] &= !(1 << 2);
        assert_eq!(preview_lines(board, false), vec![2, 1, 1]);
        assert_eq!(preview_lines(board, true), vec![2, 1]);
        let (off, off_reward) = score_with_dedup(board, &w, false, false);
        let (on, on_reward) = score_with_dedup(board, &w, false, true);
        assert_eq!(off.value.0 - on.value.0, w.tslot[1]);
        assert_eq!(off_reward.value, on_reward.value);
        assert_eq!(score_with_dedup(Board::default(), &w, false, false).0,
            score_with_dedup(Board::default(), &w, false, true).0);
    }

    #[test]
    fn config_default_is_off_and_omitted_from_serialization() {
        let config = crate::bot::BotConfig::default();
        assert!(!config.enable_real_board_structural_eval);
        assert!(!config.enable_tslot_nonmutating_dedup);
        assert!(serde_json::to_value(&config).unwrap().get("enable_tslot_nonmutating_dedup").is_none());
        assert!(serde_json::to_value(&config).unwrap().get("enable_real_board_structural_eval").is_none());
    }
}

#[cfg(test)]
mod spawn_occupancy_tests {
    use super::*;
    use crate::bot::BotConfig;

    fn state(board: Board, bag: EnumSet<Piece>, reserve: Piece) -> GameState {
        GameState {
            board,
            bag,
            reserve,
            b2b: 0,
            combo: 0,
            pending_incoming_rows: 0,
            due_this_lock_rows: 0,
        }
    }

    fn penalty(state: GameState) -> f32 {
        let mut weights = BotConfig::default().freestyle_weights;
        weights.height_upper_quarter = -45.0;
        let info = PlacementInfo {
            placement: Placement {
                location: PieceLocation {
                    piece: Piece::I,
                    rotation: Rotation::North,
                    x: 4,
                    y: 0,
                },
                spin: Spin::None,
            },
            lines_cleared: 0,
            combo: 0,
            back_to_back: false,
            perfect_clear: false,
            cancelled_rows: 0,
            tank_rows: 0,
            remaining_rows: 0,
            outgoing_after_cancel: 0,
            surge_rows: 0,
            search_attack_overflow: false,
        };
        let (off, off_reward) = evaluate(&weights, state, &info, 0, false, false, false, false, false, false);
        let (on, on_reward) = evaluate(&weights, state, &info, 0, true, false, false, false, false, false);
        assert_eq!(off_reward.value, on_reward.value);
        on.value.0 - off.value.0
    }

    #[test]
    fn pose_matches_shared_js_oracle_cases() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../fixtures/cross-runtime/native-spawn-occupancy.json"
        ))
        .unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let mut board = Board::default();
            for cell in case["occupiedCells"].as_array().unwrap() {
                board.cols[cell[0].as_u64().unwrap() as usize] |= 1 << cell[1].as_u64().unwrap();
            }
            for piece in EnumSet::<Piece>::all() {
                let expected = case["blocked"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| serde_json::from_value::<Piece>(p.clone()).unwrap() == piece);
                assert_eq!(
                    native_spawn_obstructed(&board, piece),
                    expected,
                    "case {} piece {:?}",
                    case["id"],
                    piece
                );
            }
        }
    }

    #[test]
    fn bag_and_reserve_sources_are_counted_once() {
        let mut board = Board::default();
        board.cols[3] = 1 << 20; // J and Z are blocked.
        let jz = EnumSet::only(Piece::J) | Piece::Z;
        assert_eq!(penalty(state(board, jz, Piece::J)), -90.0);
        assert_eq!(penalty(state(board, EnumSet::empty(), Piece::I)), -90.0);
        assert_eq!(
            penalty(state(board, EnumSet::only(Piece::I), Piece::J)),
            -45.0
        );
        assert_eq!(
            penalty(state(board, EnumSet::only(Piece::I), Piece::I)),
            0.0
        );
    }

    #[test]
    fn spawn_penalty_uses_real_board_before_tslot_preview() {
        let mut board = Board::default();
        for x in 0..10 {
            if x != 4 {
                board.cols[x] |= 1 << 19;
            }
            if !(3..=5).contains(&x) {
                board.cols[x] |= 1 << 20;
            }
        }
        board.cols[5] |= 1 << 21;
        assert!(native_spawn_obstructed(&board, Piece::S));
        let mut preview = board;
        preview.place(well_known_tslot_left(&board).unwrap());
        assert_eq!(preview.line_clears().count_ones(), 2);
        preview.remove_lines(preview.line_clears());
        assert!(!native_spawn_obstructed(&preview, Piece::S));
        assert_eq!(
            penalty(state(board, EnumSet::only(Piece::S), Piece::S)),
            -45.0
        );
    }
}

#[cfg(test)]
mod amount_exchange_tests {
    use std::sync::Arc;

    use super::*;

    fn board_with_height(height: u32) -> Board {
        let mut board = Board::default();
        if height > 0 {
            board.cols[0] = 1_u64 << (height - 1);
        }
        board
    }

    fn info(cancelled: u8, tank: u8, remaining: u8, outgoing: u8) -> PlacementInfo {
        PlacementInfo {
            placement: Placement {
                location: PieceLocation {
                    piece: Piece::I,
                    rotation: Rotation::North,
                    x: 4,
                    y: 0,
                },
                spin: Spin::None,
            },
            lines_cleared: 0,
            combo: 0,
            back_to_back: false,
            perfect_clear: false,
            cancelled_rows: cancelled,
            tank_rows: tank,
            remaining_rows: remaining,
            outgoing_after_cancel: outgoing,
            surge_rows: 0,
            search_attack_overflow: false,
        }
    }

    #[test]
    fn tank_risk_cast_points_are_fractional_and_exact() {
        let cases = [
            (0, 1, 0.05_f32.to_bits()),
            (9, 1, 0.5_f32.to_bits()),
            (10, 10, 10.0_f32.to_bits()),
        ];
        for (height, tank, expected_risk_bits) in cases {
            let value = amount_exchange_rows(&board_with_height(height), &info(0, tank, 0, 0));
            assert_eq!(
                (-value).to_bits(),
                expected_risk_bits,
                "h={height} t={tank}"
            );
        }
    }

    #[test]
    fn tank_risk_is_monotone_in_public_post_tank_height() {
        let low = -amount_exchange_rows(&board_with_height(0), &info(0, 2, 0, 0));
        let middle = -amount_exchange_rows(&board_with_height(8), &info(0, 2, 0, 0));
        let high = -amount_exchange_rows(&board_with_height(18), &info(0, 2, 0, 0));
        assert!(low < middle && middle < high);
    }

    #[test]
    fn remaining_debt_is_an_intentional_per_edge_holding_cost() {
        let debt_edge = amount_exchange_rows(&Board::default(), &info(0, 0, 4, 0));
        assert_eq!(debt_edge, -4.0);
        assert_eq!(debt_edge + debt_edge, -8.0);

        let cancellation = amount_exchange_rows(&Board::default(), &info(4, 0, 0, 0));
        let resolved_next = amount_exchange_rows(&Board::default(), &info(0, 0, 0, 0));
        assert_eq!(cancellation, 4.0);
        assert_eq!(cancellation + resolved_next, 4.0);
    }

    #[test]
    fn b2b_surge_reward_is_opt_in_and_added_once() {
        let mut weights = crate::bot::BotConfig::default().freestyle_weights;
        weights.s2_b2b_surge = 1.0;
        let state = GameState {
            board: Board::default(),
            bag: EnumSet::all(),
            reserve: Piece::I,
            b2b: 0,
            combo: 0,
            pending_incoming_rows: 0,
            due_this_lock_rows: 0,
        };
        let mut placement = info(0, 0, 0, 0);
        placement.surge_rows = 4;
        let off = evaluate_with_surge(&weights, state, &placement, 0, false, false, false, false, false, false, false, false, 0).1.value;
        let on = evaluate_with_surge(&weights, state, &placement, 0, false, false, false, false, false, false, true, false, 0).1.value;
        assert_eq!(on.0 - off.0, 4.0);
    }

    fn charge_value(weights: &Weights, b2b: u32, enabled: bool) -> f32 {
        let state = GameState {
            board: Board::default(),
            bag: EnumSet::all(),
            reserve: Piece::I,
            b2b,
            combo: 0,
            pending_incoming_rows: 0,
            due_this_lock_rows: 0,
        };
        evaluate_with_surge(
            weights, state, &info(0, 0, 0, 0), 0, false, false, false, false, false, false,
            enabled, false, 0,
        )
        .0
        .value
        .0
    }

    #[test]
    fn b2b_charge_value_is_opt_in_by_flag_weight_and_cap() {
        let mut weights = crate::bot::BotConfig::default().freestyle_weights;
        weights.s2_b2b_charge = 1.0;
        weights.s2_b2b_charge_cap_rows = 12;
        let mut baseline = weights.clone();
        baseline.s2_b2b_charge = 0.0;
        baseline.s2_b2b_charge_cap_rows = 0;
        assert_eq!(charge_value(&weights, 8, false), charge_value(&baseline, 8, false));

        let mut zero_weight = weights.clone();
        zero_weight.s2_b2b_charge = 0.0;
        assert_eq!(charge_value(&zero_weight, 8, true), charge_value(&baseline, 8, true));

        let mut zero_cap = weights;
        zero_cap.s2_b2b_charge_cap_rows = 0;
        assert_eq!(charge_value(&zero_cap, 8, true), charge_value(&baseline, 8, true));
    }

    #[test]
    fn b2b_charge_value_is_added_once_and_capped() {
        let mut weights = crate::bot::BotConfig::default().freestyle_weights;
        weights.s2_b2b_charge = 1.0;
        weights.s2_b2b_charge_cap_rows = 4;
        let mut baseline = weights.clone();
        baseline.s2_b2b_charge = 0.0;
        assert_eq!(charge_value(&weights, 8, true) - charge_value(&baseline, 8, true), 4.0);

        weights.s2_b2b_charge_cap_rows = 12;
        assert_eq!(charge_value(&weights, 8, true) - charge_value(&baseline, 8, true), 7.0);
    }

    #[test]
    fn b2b_charge_value_matches_canonical_surge_on_break_edges() {
        let mut weights = crate::bot::BotConfig::default().freestyle_weights;
        weights.s2_b2b_charge = 1.0;
        weights.s2_b2b_charge_cap_rows = 12;
        let mut baseline = weights.clone();
        baseline.s2_b2b_charge = 0.0;
        for b2b in 5..=8 {
            let value = charge_value(&weights, b2b, true) - charge_value(&baseline, b2b, true);
            assert_eq!(
                value,
                crate::data::s2_b2b_surge_rows(1, Spin::None, false, b2b) as f32,
                "b2b={b2b}",
            );
        }
    }

    #[test]
    fn b2b_charge_value_is_zero_at_or_below_charge_threshold() {
        let mut weights = crate::bot::BotConfig::default().freestyle_weights;
        weights.s2_b2b_charge = 1.0;
        weights.s2_b2b_charge_cap_rows = 12;
        let mut baseline = weights.clone();
        baseline.s2_b2b_charge = 0.0;
        for b2b in 0..=4 {
            assert_eq!(
                charge_value(&weights, b2b, true) - charge_value(&baseline, b2b, true),
                0.0,
                "b2b={b2b}",
            );
        }
    }

    #[test]
    fn amount_reward_is_flag_gated_and_zero_weight_is_identity() {
        let mut weights = crate::bot::BotConfig::default().freestyle_weights;
        let state = GameState {
            board: Board::default(),
            bag: EnumSet::only(Piece::I),
            reserve: Piece::T,
            b2b: 0,
            combo: 0,
            pending_incoming_rows: 4,
            due_this_lock_rows: 0,
        };
        let placement = info(4, 0, 0, 0);
        weights.s2_amount_exchange = 0.0;
        let zero = evaluate(&weights, state, &placement, 0, false, true, false, false, false, false)
            .1
            .value;
        let off = evaluate(&weights, state, &placement, 0, false, false, false, false, false, false)
            .1
            .value;
        assert_eq!(zero, off);

        weights.s2_amount_exchange = 1.0;
        let on = evaluate(&weights, state, &placement, 0, false, true, false, false, false, false)
            .1
            .value;
        assert_eq!(on.0 - off.0, 4.0);

        let zero_incoming = info(0, 0, 0, 0);
        let zero_on = evaluate(&weights, state, &zero_incoming, 0, false, true, false, false, false, false)
            .1
            .value;
        let zero_off = evaluate(&weights, state, &zero_incoming, 0, false, false, false, false, false, false)
            .1
            .value;
        assert_eq!(zero_on, zero_off);

        weights.s2_amount_top_out = -1.25;
        let without_top_out = evaluate(&weights, state, &placement, 0, false, true, false, false, false, false)
            .1
            .value;
        let with_top_out = evaluate(&weights, state, &placement, 0, false, true, true, false, false, false)
            .1
            .value;
        assert_eq!(with_top_out - without_top_out, -1.25);
    }

    #[test]
    fn cancel_value_rewards_only_canonical_cancelled_rows() {
        let mut weights = crate::bot::BotConfig::default().freestyle_weights;
        weights.s2_amount_exchange = 0.0;
        weights.s2_cancel_value = 1.0;
        let state = GameState {
            board: Board::default(),
            bag: EnumSet::only(Piece::I),
            reserve: Piece::T,
            b2b: 0,
            combo: 0,
            pending_incoming_rows: 8,
            due_this_lock_rows: 3,
        };
        let cancelled = info(3, 2, 4, 5);
        let on = evaluate(&weights, state, &cancelled, 0, false, true, false, false, false, false)
            .1.value;
        let mut baseline = weights.clone();
        baseline.s2_cancel_value = 0.0;
        let off = evaluate(&baseline, state, &cancelled, 0, false, true, false, false, false, false)
            .1.value;
        assert_eq!(on.0 - off.0, 3.0);

        // A no-cancel edge has no reward effect, even with pending/tanked rows.
        let no_cancel = info(0, 2, 6, 5);
        let on = evaluate(&weights, state, &no_cancel, 0, false, true, false, false, false, false)
            .1.value;
        let off = evaluate(&baseline, state, &no_cancel, 0, false, true, false, false, false, false)
            .1.value;
        assert_eq!(on, off);

        // With zero incoming and zero cancellation, the enabled path is identical.
        let zero_incoming = GameState {
            pending_incoming_rows: 0,
            due_this_lock_rows: 0,
            ..state
        };
        let no_incoming_info = info(0, 0, 0, 0);
        let on = evaluate(
            &weights, zero_incoming, &no_incoming_info, 0, false, true, false, false, false, false,
        ).1.value;
        let off = evaluate(
            &weights, zero_incoming, &no_incoming_info, 0, false, false, false, false, false, false,
        ).1.value;
        assert_eq!(on, off);
    }

    #[test]
    fn s4_formula_matches_f14_solvency_boundaries_and_amount_components() {
        let mut weights = crate::bot::BotConfig::default().freestyle_weights;
        weights.s2_amount_solvency_rescue_value = 1.0;

        for (height, tank, remaining, pending, expected) in [
            (10, 2, 9, 11, 0.0),
            (10, 2, 8, 10, 1.0),
            (10, 2, 7, 9, 1.0),
        ] {
            let edge = info(0, tank, remaining, 0);
            assert_eq!(u16::from(edge.cancelled_rows) + u16::from(edge.tank_rows) + u16::from(edge.remaining_rows), u16::from(pending));
            assert_eq!(
                amount_solvency_rescue_reward(&weights, pending, &board_with_height(height), &edge),
                expected,
                "height={height} tank={tank} remaining={remaining}",
            );
        }

        // Cancellation, tank, and remaining rows preserve the full pending amount.
        let cancelled = info(3, 2, 6, 0);
        assert_eq!(amount_solvency_rescue_reward(&weights, 11, &board_with_height(10), &cancelled), 1.0);
        // A no-tank edge is solvent when the outgoing attack clears the incoming amount.
        assert_eq!(amount_solvency_rescue_reward(&weights, 5, &board_with_height(19), &info(5, 0, 0, 0)), 1.0);
        // Tanking over the visible height and an already over-height board are never solvent.
        assert_eq!(amount_solvency_rescue_reward(&weights, 1, &board_with_height(20), &info(0, 1, 0, 0)), 0.0);
        assert_eq!(amount_solvency_rescue_reward(&weights, 1, &board_with_height(21), &info(1, 0, 0, 0)), 0.0);
    }

    #[test]
    fn s4_reward_is_root_only_amount_gated_and_zero_is_identity() {
        let mut weights = crate::bot::BotConfig::default().freestyle_weights;
        weights.s2_amount_solvency_rescue_value = 1.0;
        let state = GameState {
            board: Board::default(),
            bag: EnumSet::only(Piece::I),
            reserve: Piece::I,
            b2b: 0,
            combo: 0,
            pending_incoming_rows: 1,
            due_this_lock_rows: 1,
        };
        let edge = info(0, 1, 0, 0);
        let score = |weights: &Weights, incoming, root| evaluate_with_surge(
            weights, state, &edge, 0, false, incoming, false, false, false, false, false, root, 1,
        ).1.value.0;

        assert_eq!(score(&weights, true, true), 1.0);
        assert_eq!(score(&weights, true, false), 0.0, "deep search edges must receive no S4 reward");
        assert_eq!(score(&weights, false, true), 0.0, "amount-only path is required");

        let mut zero = weights.clone();
        zero.s2_amount_solvency_rescue_value = 0.0;
        assert_eq!(score(&zero, true, true), score(&weights, false, true));
        assert_eq!(amount_solvency_rescue_reward(&weights, 0, &Board::default(), &info(0, 0, 0, 0)), 0.0);
    }

    #[test]
    fn cancel_value_defaults_to_zero_and_is_omitted_from_legacy_config_bytes() {
        let default_config = crate::bot::BotConfig::default();
        assert_eq!(default_config.freestyle_weights.s2_amount_solvency_rescue_value, 0.0);
        assert_eq!(default_config.freestyle_weights.s2_cancel_value, 0.0);
        assert_eq!(default_config.freestyle_weights.s2_b2b_charge, 0.0);
        assert_eq!(default_config.freestyle_weights.s2_b2b_charge_cap_rows, 0);
        let serialized = serde_json::to_value(&default_config).unwrap();
        assert!(serialized["freestyle_weights"].get("s2_cancel_value").is_none());
        assert!(serialized["freestyle_weights"].get("s2_amount_solvency_rescue_value").is_none());
        assert!(serialized["freestyle_weights"].get("s2_b2b_charge").is_none());
        assert!(serialized["freestyle_weights"].get("s2_b2b_charge_cap_rows").is_none());

        let mut configured = serialized;
        configured["freestyle_weights"]["s2_cancel_value"] = serde_json::json!(1.0);
        configured["freestyle_weights"]["s2_amount_solvency_rescue_value"] = serde_json::json!(1.0);
        configured["freestyle_weights"]["s2_b2b_charge"] = serde_json::json!(1.0);
        configured["freestyle_weights"]["s2_b2b_charge_cap_rows"] = serde_json::json!(12);
        let parsed: crate::bot::BotConfig = serde_json::from_value(configured).unwrap();
        assert_eq!(parsed.freestyle_weights.s2_cancel_value, 1.0);
        assert_eq!(parsed.freestyle_weights.s2_amount_solvency_rescue_value, 1.0);
        assert_eq!(parsed.freestyle_weights.s2_b2b_charge, 1.0);
        assert_eq!(parsed.freestyle_weights.s2_b2b_charge_cap_rows, 12);
    }
    fn top_out_search(enable_top_out_cost: bool) -> (Freestyle, BotOptions, Statistics) {
        let mut config = crate::bot::BotConfig::default();
        config.enable_s2_amount_only_incoming = true;
        config.enable_s2_amount_top_out_cost = enable_top_out_cost;
        config.freestyle_weights.s2_amount_top_out = -1.0;
        config.search_seed = 7;
        config.suggestion_count = 16;
        let options = BotOptions { speculate: false, config: Arc::new(config) };
        let root = GameState {
            board: board_with_height(20),
            bag: EnumSet::only(Piece::I),
            reserve: Piece::I,
            b2b: 0,
            combo: 0,
            pending_incoming_rows: 2,
            due_this_lock_rows: 1,
        };
        let search = Freestyle::new(&options, root, &[Piece::I, Piece::O]);
        let stats = search.do_work(&options, None).unwrap();
        (search, options, stats)
    }

    fn state_only_top_out_search() -> (Freestyle, BotOptions, Statistics) {
        let mut config = crate::bot::BotConfig::default();
        config.enable_s2_amount_only_incoming = true;
        config.enable_s2_amount_top_out_edge_retention = true;
        config.enable_s2_amount_top_out_reward = false;
        config.freestyle_weights.s2_amount_top_out = -1.0;
        config.search_seed = 7;
        config.suggestion_count = 16;
        let options = BotOptions { speculate: false, config: Arc::new(config) };
        let root = GameState {
            board: board_with_height(20),
            bag: EnumSet::only(Piece::I),
            reserve: Piece::I,
            b2b: 0,
            combo: 0,
            pending_incoming_rows: 2,
            due_this_lock_rows: 1,
        };
        let search = Freestyle::new(&options, root, &[Piece::I, Piece::O]);
        let stats = search.do_work(&options, None).unwrap();
        (search, options, stats)
    }

    #[test]
    fn amount_top_out_frontier_is_priced_at_the_production_call_site() {
        let (off_search, off_options, off_stats) = top_out_search(false);
        assert!(off_stats.amount_top_out_omitted > 0);
        assert_eq!(off_stats.amount_top_out_priced, 0);
        assert!(off_search.dag.suggest(off_options.config.suggestion_count).is_empty());

        let (on_search, on_options, on_stats) = top_out_search(true);
        assert_eq!(on_stats.amount_top_out_omitted, 0);
        assert!(on_stats.amount_top_out_priced > 0);
        assert!(!on_search.dag.suggest(on_options.config.suggestion_count).is_empty());
        let mut accumulated = Statistics::default();
        accumulated.accumulate(on_stats);
        assert_eq!(accumulated.amount_top_out_priced, on_stats.amount_top_out_priced);
    }

    #[test]
    fn state_only_top_out_retains_edge_without_reward() {
        let (search, options, stats) = state_only_top_out_search();
        assert_eq!(stats.amount_top_out_omitted, 0);
        assert!(stats.amount_top_out_retained > 0);
        assert_eq!(stats.amount_top_out_priced, 0);
        assert!(!search.dag.suggest(options.config.suggestion_count).is_empty());

        let state = GameState {
            board: Board::default(),
            bag: EnumSet::only(Piece::I),
            reserve: Piece::T,
            b2b: 0,
            combo: 0,
            pending_incoming_rows: 4,
            due_this_lock_rows: 1,
        };
        let top_out = info(0, 1, 0, 0);
        let mut weights = options.config.freestyle_weights.clone();
        let reward_without = evaluate(
            &weights, state, &top_out, 0, false, true, false, false, false, false,
        ).1.value;
        weights.s2_amount_top_out = 0.0;
        let reward_zero_weight = evaluate(
            &weights, state, &top_out, 0, false, true, true, false, false, false,
        ).1.value;
        assert_eq!(reward_without, reward_zero_weight);
    }

    #[test]
    fn amount_top_out_frontier_remains_finite_at_a_deep_node() {
        let (search, options, first) = top_out_search(true);
        assert!(first.amount_top_out_priced > 0);
        let second = search.do_work(&options, None).unwrap();
        assert!(second.amount_top_out_priced > 0);
        assert!(search
            .dag
            .suggest(options.config.suggestion_count)
            .iter()
            .any(|(_, value)| *value > -1000.0));
    }

    #[test]
    fn amount_top_out_predicate_keeps_the_p0_prime_boundary() {
        assert!(!amount_tops_out(
            true,
            &board_with_height(19),
            &info(0, 1, 0, 0)
        ));
        assert!(amount_tops_out(
            true,
            &board_with_height(20),
            &info(0, 1, 0, 0)
        ));
        assert!(!amount_tops_out(
            false,
            &board_with_height(20),
            &info(0, 1, 0, 0)
        ));
        assert!(!amount_tops_out(
            true,
            &board_with_height(21),
            &info(0, 0, 0, 0)
        ));
    }

    #[test]
    fn tank_shaping_thresholds_and_flags_preserve_node_eval() {
        let config = crate::bot::BotConfig::default();
        assert!(!config.enable_s2_tank_risk_shaping);
        assert!(serde_json::to_value(&config).unwrap().get("enable_s2_tank_risk_shaping").is_none());
        let mut weights = config.freestyle_weights;
        weights.height = -2.0;
        weights.height_upper_half = -3.0;
        weights.height_upper_quarter = -5.0;
        for (h, t, expected) in [(9, 2, -7.0), (14, 2, -15.0), (16, 2, -20.0), (15, 0, 0.0)] {
            assert_eq!(tank_height_cost(&weights, &board_with_height(h), t), expected);
        }
        let mut board = Board::default();
        // A T-slot preview reduces this real height; the edge cost must use h=14.
        for x in 0..10 {
            if x != 4 { board.cols[x] |= 1 << 11; }
            if !(3..=5).contains(&x) { board.cols[x] |= 1 << 12; }
        }
        board.cols[5] |= 1 << 13;
        let state = GameState { board, bag: EnumSet::only(Piece::T), reserve: Piece::T,
            b2b: 0, combo: 0, pending_incoming_rows: 0, due_this_lock_rows: 0 };
        let score = |incoming, shaping, t| evaluate(&weights, state, &info(0, t, 0, 0),
            0, false, incoming, false, false, false, shaping);
        let off = score(true, false, 2);
        let on = score(true, true, 2);
        assert_eq!(on.0, off.0);
        assert_eq!(on.1.value.0 - off.1.value.0, -15.0);
        assert_eq!(score(false, true, 2).1.value, score(false, false, 2).1.value);
        assert_eq!(score(true, true, 0).1.value, score(true, false, 0).1.value);
        assert_eq!(state.board, board);
    }
}
