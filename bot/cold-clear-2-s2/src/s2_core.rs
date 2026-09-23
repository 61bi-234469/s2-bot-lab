//! Reviewed components for the CC2-based S2 integration, not the legacy/F14
//! amount kernel. This module alone is not an available decision engine.

use crate::data::{Board, Piece, PieceLocation};
use crate::native_s2::{self, Attack, CanonicalSpin, Chain, Clear, RootAmounts};
use crate::native_s2::{Error, Incoming};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmountDelta {
    pub cancelled_rows: u32,
    pub tank_rows: u32,
    pub remaining_rows: u32,
    pub outgoing_after_cancel: u32,
    pub due_rows_after_lock: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Horizon {
    Open,
    KnownNextExhausted,
    DepthLimit,
}

/// Request and actual lock depth belong to the layer namespace, not this key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct State {
    pub board: Board,
    pub materialized_g: Board,
    pub current: Option<Piece>,
    pub hold: Option<Piece>,
    pub hold_available: bool,
    pub known_cursor: u16,
    pub chain: Chain,
    pub incoming: Incoming,
    /// Rows that have been tanked but whose garbage shape is intentionally
    /// unknown to the bot. This scalar never creates occupancy or G cells.
    pub phantom_rows: u32,
    pub horizon: Horizon,
}

/// Move generation owns the proof; callers may inspect but cannot alter it.
/// ```compile_fail
/// use cold_clear_2_s2::{s2_core::Action, native_s2::CanonicalSpin};
/// fn forge(mut action: Action) { action.spin = CanonicalSpin::Normal; }
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    #[serde(skip)]
    source_board: Board,
    hold_used: bool,
    location: PieceLocation,
    spin: CanonicalSpin,
    soft_drops: u32,
    rotation_from: Option<PieceLocation>,
    native_kick_index: Option<usize>,
    native_kick_offset: Option<(i8, i8)>,
}

impl Action {
    pub fn hold_used(self) -> bool {
        self.hold_used
    }
    pub fn location(self) -> PieceLocation {
        self.location
    }
    pub fn spin(self) -> CanonicalSpin {
        self.spin
    }
    pub fn soft_drops(self) -> u32 {
        self.soft_drops
    }
    pub fn key(self) -> [i64; 17] {
        let from = self.rotation_from;
        let offset = self.native_kick_offset;
        [self.location.piece as i64, self.location.rotation as i64,
            self.location.x.into(), self.location.y.into(), self.hold_used.into(), self.spin as i64,
            self.soft_drops.into(), from.is_some().into(), from.map_or(0,|p|p.piece as i64),
            from.map_or(0,|p|p.rotation as i64), from.map_or(0,|p|i64::from(p.x)), from.map_or(0,|p|i64::from(p.y)),
            self.native_kick_index.is_some().into(), self.native_kick_index.map_or(0,|k|k as i64),
            offset.is_some().into(), offset.map_or(0,|p|i64::from(p.0)), offset.map_or(0,|p|i64::from(p.1))]
    }
    pub fn witness_json(self) -> serde_json::Value {
        serde_json::to_value(self.witness()).expect("typed move proof is serializable")
    }
    fn from_witness(hold_used: bool, w: crate::movegen::NativeS2Move) -> Self {
        Self {
            source_board: *w.source_board,
            hold_used,
            location: w.location,
            spin: w.spin,
            soft_drops: w.soft_drops,
            rotation_from: w.rotation_from,
            native_kick_index: w.native_kick_index,
            native_kick_offset: w.native_kick_offset,
        }
    }
    fn witness(self) -> crate::movegen::NativeS2Move {
        crate::movegen::NativeS2Move {
            source_board: std::rc::Rc::new(self.source_board),
            location: self.location,
            spin: self.spin,
            soft_drops: self.soft_drops,
            rotation_from: self.rotation_from,
            native_kick_index: self.native_kick_index,
            native_kick_offset: self.native_kick_offset,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PressureView {
    pub height_after_clear: u32,
    pub tank_rows: u32,
    pub remaining_rows: u32,
    pub lock_margin: i64,
    pub amount_topped_out: bool,
}
impl PressureView {
    pub fn new(height_after_clear: u32, tank_rows: u32, remaining_rows: u32) -> Self {
        Self {
            height_after_clear,
            tank_rows,
            remaining_rows,
            lock_margin: 20
                - i64::from(height_after_clear)
                - i64::from(tank_rows)
                - i64::from(remaining_rows),
            amount_topped_out: tank_rows > 0
                && u64::from(height_after_clear) + u64::from(tank_rows) > 20,
        }
    }
    pub fn inside_margin(self) -> bool {
        !self.amount_topped_out && self.lock_margin >= 0
    }
}
impl State {
    /// Collision-free diagnostic identity for the exact S2 state. The layer
    /// index remains separate from this key; all fields that participate in
    /// State equality are retained here for shared-node attribution.
    pub fn key(self) -> [i64;30] {
        let mut key=[0i64;30];let mut index=0;
        for value in self.board.cols.into_iter().chain(self.materialized_g.cols) {
            key[index]=value as i64;index+=1;
        }
        key[index]=self.current.map_or(-1,|piece|piece as i64);index+=1;
        key[index]=self.hold.map_or(-1,|piece|piece as i64);index+=1;
        key[index]=self.hold_available.into();index+=1;
        key[index]=self.known_cursor.into();index+=1;
        key[index]=self.chain.combo.into();index+=1;key[index]=self.chain.b2b.into();index+=1;
        key[index]=self.incoming.pending_rows.into();index+=1;key[index]=self.incoming.due_this_lock_rows.into();index+=1;
        match self.horizon {
            Horizon::Open=>{key[index]=0;}
            Horizon::KnownNextExhausted=>{key[index]=1;}
            Horizon::DepthLimit=>{key[index]=2;}
        }
        key[index+1]=self.phantom_rows.into();
        key
    }
    pub fn pressure(self) -> PressureView {
        let h = self
            .board
            .cols
            .iter()
            .map(|col| 64 - col.leading_zeros())
            .max()
            .unwrap_or(0);
        PressureView::new(h, self.phantom_rows, self.incoming.pending_rows)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AmountTable {
    pub entries: Vec<RootAmounts>,
    pub overflow_signatures: Vec<Clear>,
}

pub struct Context {
    root: State,
    known_queue: Arc<[Piece]>,
    multiplier: f64,
    max_depth: u16,
    root_amounts: AmountTable,
}

/// Immutable amounts are prepared once per expansion and bound to its request,
/// state and actual lock depth. Callers cannot substitute a deep table at root.
/// ```compile_fail
/// use cold_clear_2_s2::s2_core::{Expansion, AmountTable};
/// fn substitute(mut expansion: Expansion<'_>, table: AmountTable) { expansion.amounts = table; }
/// ```
pub struct Expansion<'a> {
    context: &'a Context,
    state: State,
    locks_from_root: u16,
    amounts: AmountTable,
}
impl Expansion<'_> {
    pub fn actions(&self) -> Result<Vec<Action>, Error> {
        self.context.actions(self.state)
    }
    pub fn transition(&self, action: Action) -> Result<Transition, Error> {
        self.context
            .transition(self.state, action, &self.amounts, self.locks_from_root)
    }
}

pub struct Transition {
    pub next: State,
    pub clear: Clear,
    pub attack: Attack,
    pub amounts: AmountDelta,
    pub pressure: PressureView,
}

pub fn clear_signatures() -> Vec<Clear> {
    let mut result = Vec::with_capacity(51);
    for lines in 0..=4 {
        for spin in [
            CanonicalSpin::None,
            CanonicalSpin::Mini,
            CanonicalSpin::Normal,
        ] {
            for perfect_clear in [false, true] {
                for cleared_any_g in [false, true] {
                    if lines == 0 && (perfect_clear || cleared_any_g) {
                        continue;
                    }
                    result.push(Clear {
                        lines,
                        spin,
                        perfect_clear,
                        cleared_any_g,
                    });
                }
            }
        }
    }
    result
}

pub fn modelled_amounts(
    chain: Chain,
    incoming: Incoming,
    multiplier: f64,
) -> Result<AmountTable, Error> {
    let mut table = AmountTable {
        entries: vec![],
        overflow_signatures: vec![],
    };
    for signature in clear_signatures() {
        match native_s2::attack(chain, signature, multiplier) {
            Ok((_, attack)) => {
                let a = advance_amounts(incoming, attack.outgoing_before_cancel, signature.lines)?;
                table.entries.push(RootAmounts {
                    signature,
                    outgoing_before_cancel: attack.outgoing_before_cancel,
                    cancelled_rows: a.cancelled_rows,
                    tank_rows: a.tank_rows,
                    remaining_rows: a.remaining_rows,
                    outgoing_after_cancel: a.outgoing_after_cancel,
                    due_rows_after_lock: a.due_rows_after_lock,
                });
            }
            Err(Error::NumericOverflow) => table.overflow_signatures.push(signature),
            Err(error) => return Err(error),
        }
    }
    Ok(table)
}

fn validate_table(
    table: &AmountTable,
    chain: Chain,
    incoming: Incoming,
    multiplier: f64,
) -> Result<(), Error> {
    if table.entries.len() + table.overflow_signatures.len() != 51 {
        return Err(Error::OracleMismatch);
    }
    for signature in clear_signatures() {
        let rows: Vec<_> = table
            .entries
            .iter()
            .filter(|row| row.signature == signature)
            .collect();
        let overflows = table
            .overflow_signatures
            .iter()
            .filter(|&&s| s == signature)
            .count();
        if rows.len() + overflows != 1 {
            return Err(Error::OracleMismatch);
        }
        match native_s2::attack(chain, signature, multiplier) {
            Ok((_, attack)) if rows.len() == 1 => {
                rows[0].validate(incoming, signature, attack.outgoing_before_cancel)?;
            }
            Err(Error::NumericOverflow) if overflows == 1 => {}
            Err(e) if e != Error::NumericOverflow => return Err(e),
            _ => return Err(Error::OracleMismatch),
        }
    }
    Ok(())
}

impl Context {
    pub fn root(&self) -> State {
        self.root
    }
    pub fn known_queue(&self) -> &[Piece] {
        &self.known_queue
    }
    pub fn multiplier(&self) -> f64 {
        self.multiplier
    }
    pub fn max_depth(&self) -> u16 {
        self.max_depth
    }
    pub fn new(
        root: native_s2::State,
        multiplier: f64,
        max_depth: u16,
        root_amounts: AmountTable,
    ) -> Result<Self, Error> {
        root.validate()?;
        if !multiplier.is_finite()
            || multiplier < 0.0
            || max_depth == 0
            || root.current.is_none()
            || root.horizon != native_s2::Horizon::Open
            || root.board.line_clears() != 0
            || (root.hold_available && root.hold.is_none() && root.known_next.is_empty())
        {
            return Err(Error::InvalidInput);
        }
        validate_table(&root_amounts, root.chain, root.incoming, multiplier)?;
        Ok(Self {
            root: State {
                board: root.board,
                materialized_g: root.materialized_g,
                current: root.current,
                hold: root.hold,
                hold_available: root.hold_available,
                known_cursor: 0,
                chain: root.chain,
                incoming: root.incoming,
                phantom_rows: 0,
                horizon: Horizon::Open,
            },
            known_queue: root.known_next.into(),
            multiplier,
            max_depth,
            root_amounts,
        })
    }

    fn native_view(&self, state: State) -> Result<native_s2::State, Error> {
        let known_next = self
            .known_queue
            .get(usize::from(state.known_cursor)..)
            .ok_or(Error::InvalidInput)?
            .to_vec();
        Ok(native_s2::State {
            board: state.board,
            materialized_g: state.materialized_g,
            current: state.current,
            hold: state.hold,
            hold_available: state.hold_available,
            chain: state.chain,
            incoming: state.incoming,
            known_next,
            horizon: native_s2::Horizon::Open,
        })
    }

    fn actions(&self, state: State) -> Result<Vec<Action>, Error> {
        if state.horizon != Horizon::Open {
            return Ok(vec![]);
        }
        self.native_view(state)?.root_moves().map(|moves| {
            moves
                .into_iter()
                .map(|(hold, w)| Action::from_witness(hold, w))
                .collect()
        })
    }

    pub fn prepare(&self, state: State, locks_from_root: u16) -> Result<Expansion<'_>, Error> {
        if state.horizon != Horizon::Open || locks_from_root >= self.max_depth {
            return Err(Error::InvalidInput);
        }
        self.native_view(state)?.validate()?;
        let amounts = if locks_from_root == 0 {
            if state != self.root {
                return Err(Error::InvalidInput);
            }
            self.root_amounts.clone()
        } else {
            modelled_amounts(state.chain, state.incoming, self.multiplier)?
        };
        Ok(Expansion {
            context: self,
            state,
            locks_from_root,
            amounts,
        })
    }

    fn transition(
        &self,
        state: State,
        action: Action,
        amounts: &AmountTable,
        locks_from_root: u16,
    ) -> Result<Transition, Error> {
        if state.horizon != Horizon::Open || locks_from_root >= self.max_depth {
            return Err(Error::InvalidInput);
        }
        let before = self.native_view(state)?;
        let (after, clear, attack) = before.lock(
            &action.witness(),
            action.hold_used,
            self.multiplier,
            &amounts.entries,
        )?;
        let a = amounts
            .entries
            .iter()
            .find(|row| row.signature == clear)
            .ok_or(Error::OracleMismatch)?;
        let consumed = before
            .known_next
            .len()
            .checked_sub(after.known_next.len())
            .ok_or(Error::InvalidInput)?;
        let known_cursor = state
            .known_cursor
            .checked_add(u16::try_from(consumed).map_err(|_| Error::NumericOverflow)?)
            .ok_or(Error::NumericOverflow)?;
        let depth = locks_from_root
            .checked_add(1)
            .ok_or(Error::NumericOverflow)?;
        let next = State {
            board: after.board,
            materialized_g: after.materialized_g,
            current: after.current,
            hold: after.hold,
            hold_available: after.hold_available,
            known_cursor,
            chain: after.chain,
            incoming: after.incoming,
            phantom_rows: state
                .phantom_rows
                .checked_add(a.tank_rows)
                .ok_or(Error::NumericOverflow)?,
            horizon: if after.current.is_none() {
                Horizon::KnownNextExhausted
            } else if depth == self.max_depth {
                Horizon::DepthLimit
            } else {
                Horizon::Open
            },
        };
        Ok(Transition {
            pressure: next.pressure(),
            next,
            clear,
            attack,
            amounts: AmountDelta {
                cancelled_rows: a.cancelled_rows,
                tank_rows: a.tank_rows,
                remaining_rows: a.remaining_rows,
                outgoing_after_cancel: a.outgoing_after_cancel,
                due_rows_after_lock: a.due_rows_after_lock,
            },
        })
    }
}

/// Modelled deep exchange with canonical attack supplied by the caller. The
/// next due amount is all remaining rows; no arrival/cap/hole is predicted.
pub fn advance_amounts(incoming: Incoming, attack: u32, lines: u32) -> Result<AmountDelta, Error> {
    incoming.validate()?;
    if lines > 4 || (lines == 0 && attack != 0) {
        return Err(Error::InvalidInput);
    }
    let cancelled_rows = if lines == 0 {
        0
    } else {
        incoming.pending_rows.min(attack)
    };
    let tank_rows = if lines == 0 {
        incoming.due_this_lock_rows
    } else {
        0
    };
    let remaining_rows = incoming
        .pending_rows
        .checked_sub(cancelled_rows)
        .and_then(|r| r.checked_sub(tank_rows))
        .ok_or(Error::NumericOverflow)?;
    let outgoing_after_cancel = attack
        .checked_sub(cancelled_rows)
        .ok_or(Error::NumericOverflow)?;
    Ok(AmountDelta {
        cancelled_rows,
        tank_rows,
        remaining_rows,
        outgoing_after_cancel,
        due_rows_after_lock: remaining_rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> native_s2::State {
        native_s2::State {
            board: Board::default(),
            materialized_g: Board::default(),
            current: Some(Piece::T),
            hold: None,
            hold_available: true,
            known_next: vec![Piece::I, Piece::O, Piece::L, Piece::J],
            chain: Chain { combo: 0, b2b: 0 },
            incoming: Incoming {
                pending_rows: 0,
                due_this_lock_rows: 0,
            },
            horizon: native_s2::Horizon::Open,
        }
    }
    fn context(root: native_s2::State, depth: u16) -> Context {
        let amounts = modelled_amounts(root.chain, root.incoming, 1.0).unwrap();
        Context::new(root, 1.0, depth, amounts).unwrap()
    }

    #[test]
    fn state_preserves_hold_cursor_and_all_key_fields() {
        let c = context(root(), 4);
        for hold in [false, true] {
            let a = c
                .actions(c.root)
                .unwrap()
                .into_iter()
                .find(|a| a.hold_used == hold)
                .unwrap();
            let t = c.prepare(c.root, 0).unwrap().transition(a).unwrap();
            assert_eq!(t.next.known_cursor, if hold { 2 } else { 1 });
            assert_eq!(t.next.current, Some(if hold { Piece::O } else { Piece::I }));
            assert_eq!(t.next.hold, if hold { Some(Piece::T) } else { None });
        }
        let mut keys = std::collections::HashSet::new();
        keys.insert(c.root);
        keys.insert(State {
            known_cursor: 1,
            ..c.root
        });
        keys.insert(State {
            hold_available: false,
            ..c.root
        });
        keys.insert(State {
            chain: Chain {
                combo: 256,
                b2b: 300,
            },
            ..c.root
        });
        keys.insert(State {
            incoming: Incoming {
                pending_rows: 256,
                due_this_lock_rows: 1,
            },
            ..c.root
        });
        keys.insert(State {
            phantom_rows: 1,
            ..c.root
        });
        let occupied = State {
            board: Board { cols: [1; 10] },
            ..c.root
        };
        keys.insert(occupied);
        keys.insert(State {
            materialized_g: Board { cols: [1; 10] },
            ..occupied
        });
        assert_eq!(keys.len(), 8);
        let mut short = root();
        short.known_next = vec![Piece::I];
        let c = context(short, 4);
        let a = c
            .actions(c.root)
            .unwrap()
            .into_iter()
            .find(|a| a.hold_used)
            .unwrap();
        let next = c.prepare(c.root, 0).unwrap().transition(a).unwrap().next;
        assert_eq!(next.horizon, Horizon::KnownNextExhausted);
        assert_eq!(next.current, None);
        assert_eq!(next.known_cursor, 1);
    }

    #[test]
    fn root_table_deep_due_and_unknown_tank_have_distinct_contracts() {
        let mut r = root();
        r.incoming = Incoming {
            pending_rows: 5,
            due_this_lock_rows: 0,
        };
        let mut table = modelled_amounts(r.chain, r.incoming, 1.0).unwrap();
        for row in &mut table.entries {
            row.due_rows_after_lock = 0;
        }
        let c = Context::new(r, 1.0, 4, table).unwrap();
        let mut state = c.root;
        for depth in 0..3 {
            let a = c
                .actions(state)
                .unwrap()
                .into_iter()
                .find(|a| !a.hold_used)
                .unwrap();
            let t = c.prepare(state, depth).unwrap().transition(a).unwrap();
            assert_eq!(t.clear.lines, 0);
            assert_eq!(t.next.incoming.pending_rows, if depth == 2 { 0 } else { 5 });
            assert_eq!(
                t.next.incoming.due_this_lock_rows,
                if depth == 1 { 5 } else { 0 }
            );
            if depth == 2 {
                assert_eq!(t.next.horizon, Horizon::Open);
                assert_eq!(t.next.phantom_rows, 5);
                assert_eq!(t.pressure.tank_rows, 5);
                assert!(!c.actions(t.next).unwrap().is_empty());
            }
            state = t.next;
        }
        assert!(!c.actions(state).unwrap().is_empty());
        assert_eq!(
            state.materialized_g,
            Board::default(),
            "unknown tank must not materialize garbage"
        );
        let c = context(root(), 1);
        let a = c.actions(c.root).unwrap()[0];
        assert_eq!(
            c.prepare(c.root, 0)
                .unwrap()
                .transition(a)
                .unwrap()
                .next
                .horizon,
            Horizon::DepthLimit
        );
        let c = context(root(), 2);
        let changed = State {
            board: Board {
                cols: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            },
            ..c.root
        };
        assert!(matches!(c.prepare(changed, 0), Err(Error::InvalidInput)));
        assert!(matches!(
            c.prepare(changed, 1).unwrap().transition(a),
            Err(Error::IllegalPlacement)
        ));
    }

    #[test]
    fn phantom_tank_rows_continue_search_without_materializing_garbage() {
        let mut r = root();
        r.incoming = Incoming {
            pending_rows: 5,
            due_this_lock_rows: 5,
        };
        let c = context(r, 4);
        let first = c
            .actions(c.root)
            .unwrap()
            .into_iter()
            .find(|a| !a.hold_used)
            .unwrap();
        let first_transition = c.prepare(c.root, 0).unwrap().transition(first).unwrap();
        assert_eq!(first_transition.next.phantom_rows, 5);
        assert_eq!(first_transition.next.horizon, Horizon::Open);
        assert_eq!(first_transition.next.materialized_g, Board::default());
        assert!(!c.actions(first_transition.next).unwrap().is_empty());

        let mut later = first_transition.next;
        later.incoming = Incoming {
            pending_rows: 4,
            due_this_lock_rows: 4,
        };
        let later_action = c
            .actions(later)
            .unwrap()
            .into_iter()
            .find(|a| !a.hold_used)
            .unwrap();
        let second = c.prepare(later, 1).unwrap().transition(later_action).unwrap();
        assert_eq!(second.amounts.tank_rows, 4);
        assert_eq!(second.next.phantom_rows, 9);
        assert_eq!(second.next.horizon, Horizon::Open);
        assert!(second
            .next
            .board
            .cols
            .iter()
            .zip(later.board.cols)
            .all(|(after, before)| after & before == before));
        assert_eq!(second.next.materialized_g, later.materialized_g);
    }

    #[test]
    fn phantom_rows_are_checked_and_survive_clear_cancellation() {
        let c = context(root(), 4);
        let mut overflow = c.root();
        overflow.phantom_rows = u32::MAX;
        overflow.incoming = Incoming {
            pending_rows: 1,
            due_this_lock_rows: 1,
        };
        let action = c
            .actions(overflow)
            .unwrap()
            .into_iter()
            .find(|a| !a.hold_used())
            .unwrap();
        assert!(matches!(
            c.prepare(overflow, 1).unwrap().transition(action),
            Err(Error::NumericOverflow)
        ));

        let mut r = root();
        r.current = Some(Piece::I);
        r.hold = Some(Piece::T);
        r.board = Board {
            cols: [1, 1, 1, 0, 0, 0, 0, 1, 1, 1],
        };
        r.incoming = Incoming {
            pending_rows: 8,
            due_this_lock_rows: 0,
        };
        let c = context(r, 4);
        let pressured = State {
            phantom_rows: 7,
            ..c.root
        };
        let clear_and_cancel = c
            .actions(pressured)
            .unwrap()
            .into_iter()
            .find_map(|action| {
                c.prepare(pressured, 1)
                    .unwrap()
                    .transition(action)
                    .ok()
                    .filter(|t| t.clear.lines == 1 && t.amounts.cancelled_rows > 0)
            })
            .unwrap();
        assert_eq!(clear_and_cancel.next.phantom_rows, 7);
        assert!(clear_and_cancel.amounts.cancelled_rows > 0);
    }

    #[test]
    fn phantom_pressure_above_board_height_stays_expandable_and_finite() {
        let mut r = root();
        r.current = Some(Piece::O);
        r.board.cols[0] = (1_u64 << 19) - 1;
        let c = context(r, 4);
        let state = State {
            phantom_rows: 2,
            ..c.root
        };
        assert!(state.pressure().amount_topped_out);
        assert!(!c.actions(state).unwrap().is_empty());
        let policy = crate::s2_eval::Policy::new(&crate::s2_eval::prototype()).unwrap();
        let features = crate::s2_eval::leaf_features(&c, state, &policy).unwrap();
        assert!(crate::s2_eval::Value::finite(policy.leaf(&features).unwrap()).is_ok());
    }

    #[test]
    fn canonical_lock_preserves_g_clear_and_wide_chain() {
        let mut r = root();
        r.current = Some(Piece::I);
        r.hold = Some(Piece::T);
        r.board = Board {
            cols: [1, 1, 1, 0, 0, 0, 0, 1, 1, 1],
        };
        r.materialized_g = Board {
            cols: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        r.chain = Chain {
            combo: 255,
            b2b: 300,
        };
        let c = context(r, 4);
        let t = c
            .actions(c.root)
            .unwrap()
            .into_iter()
            .filter(|a| !a.hold_used)
            .map(|a| c.prepare(c.root, 0).unwrap().transition(a).unwrap())
            .find(|t| t.clear.lines == 1)
            .unwrap();
        assert!(t.clear.cleared_any_g);
        assert!(t.clear.perfect_clear);
        assert_eq!(t.next.chain.combo, 256);
        assert_eq!(t.next.chain.b2b, 301);
        assert_eq!(t.next.materialized_g, Board::default());
        assert!(t.amounts.outgoing_after_cancel > 0);
    }

    #[test]
    fn coverage_checks_real_overflow_and_pressure_uses_wide_signed_arithmetic() {
        let mut r = root();
        r.chain.combo = u32::MAX;
        let table = modelled_amounts(r.chain, r.incoming, 1.0).unwrap();
        assert!(!table.overflow_signatures.is_empty());
        let c = Context::new(r.clone(), 1.0, 4, table.clone()).unwrap();
        let a = c.actions(c.root).unwrap()[0];
        assert!(c.prepare(c.root, 0).unwrap().transition(a).is_ok()); // unused overflow is admissible
        let mut bad = table.clone();
        bad.overflow_signatures[0] = bad.entries[0].signature;
        assert!(Context::new(r.clone(), 1.0, 4, bad).is_err());
        let mut bad = table;
        bad.entries.pop();
        assert!(Context::new(r, 1.0, 4, bad).is_err());
        for (h, t, r, margin) in [(12, 4, 8, -4), (12, 4, 0, 4), (20, 0, 0, 0), (18, 3, 0, -1)] {
            assert_eq!(PressureView::new(h, t, r).lock_margin, margin);
        }
        assert_eq!(
            PressureView::new(40, u32::MAX, u32::MAX).lock_margin,
            -8_589_934_610
        );
        let mut r = root();
        r.board.cols = [1; 10];
        assert!(Context::new(
            r.clone(),
            1.0,
            4,
            modelled_amounts(r.chain, r.incoming, 1.0).unwrap()
        )
        .is_err());
        let mut r = root();
        r.materialized_g.cols[0] = 1;
        assert!(Context::new(
            r.clone(),
            1.0,
            4,
            modelled_amounts(r.chain, r.incoming, 1.0).unwrap()
        )
        .is_err());
    }

    #[test]
    fn new_amount_contract_keeps_zero_incoming_attack_and_wide_counts() {
        let empty = Incoming {
            pending_rows: 0,
            due_this_lock_rows: 0,
        };
        assert_eq!(
            advance_amounts(empty, 6, 4).unwrap().outgoing_after_cancel,
            6
        );
        let old = crate::data::advance_amount_only(
            0,
            0,
            4,
            crate::data::Spin::None,
            false,
            1,
            0,
            0,
        )
        .unwrap();
        let f14 = crate::f14_compat::advance_f14_amount_only(
            crate::f14_compat::F14Incoming {
                pending_rows: 0,
                due_this_lock_rows: 0,
            },
            &crate::f14_compat::F14LockPublic {
                lines: 4,
                spin: "none".into(),
                perfect_clear: false,
                combo_after: 1,
                b2b_before: 0,
                b2b_after: 0,
            },
        )
        .unwrap();
        assert_eq!(old.outgoing_after_cancel, 0);
        assert_eq!(f14.outgoing_after_cancel, 0);
        for pending in [0, 1, 255, 256, u32::MAX] {
            for due in [0, pending] {
                for (lines, attack) in [(0, 0), (1, 0), (1, 6), (4, u32::MAX)] {
                    let delta = advance_amounts(
                        Incoming {
                            pending_rows: pending,
                            due_this_lock_rows: due,
                        },
                        attack,
                        lines,
                    )
                    .unwrap();
                    assert_eq!(
                        u64::from(delta.cancelled_rows)
                            + u64::from(delta.tank_rows)
                            + u64::from(delta.remaining_rows),
                        u64::from(pending)
                    );
                    assert_eq!(
                        u64::from(delta.cancelled_rows) + u64::from(delta.outgoing_after_cancel),
                        u64::from(attack)
                    );
                    assert_eq!(delta.due_rows_after_lock, delta.remaining_rows);
                }
            }
        }
        assert_eq!(advance_amounts(empty, 1, 0), Err(Error::InvalidInput));
        assert_eq!(advance_amounts(empty, 0, 5), Err(Error::InvalidInput));
        assert_eq!(
            advance_amounts(
                Incoming {
                    pending_rows: 1,
                    due_this_lock_rows: 2
                },
                0,
                0
            ),
            Err(Error::InvalidInput)
        );
    }

    #[test]
    fn nonzero_exchange_matches_legacy_for_the_same_attack_only() {
        use crate::data::{advance_amount_only, Spin};
        // The legacy function computes its own old attack. Feed that exact attack
        // to the new kernel; this checks row arithmetic, not attack equivalence.
        for pending in [1, 6, 20, 255] {
            for due in [0, pending] {
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
                    let new = advance_amounts(
                        Incoming {
                            pending_rows: pending.into(),
                            due_this_lock_rows: due.into(),
                        },
                        old.outgoing_before_cancel.into(),
                        lines,
                    )
                    .unwrap();
                    assert_eq!(
                        (
                            new.cancelled_rows,
                            new.tank_rows,
                            new.remaining_rows,
                            new.outgoing_after_cancel,
                            new.due_rows_after_lock
                        ),
                        (
                            old.cancelled_rows.into(),
                            old.tank_rows.into(),
                            old.remaining_rows.into(),
                            old.outgoing_after_cancel.into(),
                            old.due_after.into()
                        )
                    );
                }
            }
        }
    }
}
