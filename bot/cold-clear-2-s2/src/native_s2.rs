//! ADR-063 state/value contract for the opt-in s2-native-integrated/1 route.
//! The finite DAG and transport use this contract; legacy data/Eval stay intact.
use crate::data::{Board, Piece, PieceLocation, Rotation};
use ordered_float::OrderedFloat;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Error {
    InvalidInput,
    IllegalPlacement,
    NumericOverflow,
    OracleMismatch,
}
type Result<T> = std::result::Result<T, Error>;

/// Versioned native transport uses decimal strings for canonical f64 values:
/// the legacy serde_json number parser is not an exact round-trip parser.
pub fn parse_nonnegative_f64(decimal: &str) -> Result<f64> {
    let value = decimal.parse::<f64>().map_err(|_| Error::InvalidInput)?;
    if !value.is_finite() || value < 0.0 {
        Err(Error::InvalidInput)
    } else {
        Ok(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chain {
    pub combo: u32,
    pub b2b: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Incoming {
    pub pending_rows: u32,
    pub due_this_lock_rows: u32,
}
impl Incoming {
    pub fn validate(self) -> Result<Self> {
        if self.due_this_lock_rows > self.pending_rows {
            Err(Error::InvalidInput)
        } else {
            Ok(self)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Clear {
    pub lines: u32,
    pub spin: CanonicalSpin,
    pub perfect_clear: bool,
    pub cleared_any_g: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanonicalSpin {
    None,
    Mini,
    Normal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainDelta {
    pub combo_before: u32,
    pub combo_after: u32,
    pub b2b_before: u32,
    pub b2b_after: u32,
    pub broke_b2b: bool,
    pub broken_b2b_count: u32,
}
impl Clear {
    fn validate(self) -> Result<()> {
        if self.lines > 4 || (self.lines == 0 && (self.perfect_clear || self.cleared_any_g)) {
            Err(Error::InvalidInput)
        } else {
            Ok(())
        }
    }
}
pub fn advance_chain(before: Chain, clear: Clear) -> Result<ChainDelta> {
    clear.validate()?;
    let combo = if clear.lines == 0 {
        0
    } else {
        before.combo.checked_add(1).ok_or(Error::NumericOverflow)?
    };
    let charge = clear.lines > 0
        && (clear.perfect_clear || clear.lines == 4 || clear.spin != CanonicalSpin::None);
    let broke = clear.lines > 0 && !charge && before.b2b > 0;
    let b2b = if charge {
        before.b2b.checked_add(1).ok_or(Error::NumericOverflow)?
    } else if clear.lines > 0 {
        0
    } else {
        before.b2b
    };
    Ok(ChainDelta {
        combo_before: before.combo,
        combo_after: combo,
        b2b_before: before.b2b,
        b2b_after: b2b,
        broke_b2b: broke,
        broken_b2b_count: if broke { before.b2b } else { 0 },
    })
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attack {
    pub raw: f64,
    pub after_multiplier: f64,
    pub after_rounding: u32,
    pub special_bonus: u32,
    pub perfect_clear_bonus: u32,
    pub surge_chunks: Vec<u32>,
    pub outgoing_before_cancel: u32,
}
fn rows(value: f64) -> Result<u32> {
    if !value.is_finite() || value < 0.0 || value.floor() > u32::MAX as f64 {
        return Err(Error::NumericOverflow);
    }
    Ok(value.floor() as u32)
}
pub fn attack(before: Chain, clear: Clear, multiplier: f64) -> Result<(ChainDelta, Attack)> {
    if !multiplier.is_finite() || multiplier < 0.0 {
        return Err(Error::InvalidInput);
    }
    let chain = advance_chain(before, clear)?;
    let table = match clear.spin {
        CanonicalSpin::None => [0., 0., 1., 2., 4.],
        CanonicalSpin::Mini => [0., 0., 1., 2., 10.],
        CanonicalSpin::Normal => [0., 2., 4., 6., 10.],
    };
    let mut raw = table[clear.lines as usize];
    if clear.lines > 0 && chain.b2b_after > 1 {
        raw += 1.;
    }
    let combo = chain.combo_after.saturating_sub(1);
    if combo > 0 {
        raw *= 1. + 0.25 * combo as f64;
    }
    if combo > 1 {
        raw = raw.max((1.25 * combo as f64).ln_1p());
    }
    let special =
        u32::from(clear.cleared_any_g && (clear.spin != CanonicalSpin::None || clear.lines == 4));
    let after_multiplier = raw * multiplier;
    let after_rounding = rows(after_multiplier + special as f64)?;
    let pc = if clear.perfect_clear {
        rows(5. * multiplier)?
    } else {
        0
    };
    let surge = if chain.broken_b2b_count > 4 {
        rows((chain.broken_b2b_count as f64 - 4. + 3.) * multiplier)?
    } else {
        0
    };
    let first = (surge as f64 / 3.).round() as u32;
    let surge_chunks = if surge == 0 {
        vec![]
    } else {
        [first, first, surge - 2 * first]
            .into_iter()
            .filter(|n| *n > 0)
            .collect()
    };
    let outgoing = after_rounding
        .checked_add(pc)
        .and_then(|n| n.checked_add(surge))
        .ok_or(Error::NumericOverflow)?;
    Ok((
        chain,
        Attack {
            raw,
            after_multiplier,
            after_rounding,
            special_bonus: special,
            perfect_clear_bonus: pc,
            surge_chunks,
            outgoing_before_cancel: outgoing,
        },
    ))
}

/// Canonical amount projection only. No referee packet/seed fields deserialize.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootAmounts {
    pub signature: Clear,
    pub outgoing_before_cancel: u32,
    pub cancelled_rows: u32,
    pub outgoing_after_cancel: u32,
    pub remaining_rows: u32,
    pub tank_rows: u32,
    pub due_rows_after_lock: u32,
}
impl RootAmounts {
    pub fn validate(self, incoming: Incoming, clear: Clear, outgoing: u32) -> Result<Self> {
        incoming.validate()?;
        if self.signature != clear
            || self.outgoing_before_cancel != outgoing
            || self.outgoing_after_cancel > outgoing
            || self.due_rows_after_lock > self.remaining_rows
            || self
                .cancelled_rows
                .checked_add(self.tank_rows)
                .and_then(|v| v.checked_add(self.remaining_rows))
                != Some(incoming.pending_rows)
            || (clear.lines > 0 && self.tank_rows != 0)
            || (clear.lines == 0
                && (self.cancelled_rows != 0 || self.tank_rows != incoming.due_this_lock_rows))
        {
            return Err(Error::OracleMismatch);
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Horizon {
    Open,
    KnownNextExhausted,
    UnknownTank { rows: u32 },
}

/// Admitted state value. The queue is public; no random future tail is synthesized.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct State {
    pub board: Board,
    pub materialized_g: Board,
    pub current: Option<Piece>,
    pub hold: Option<Piece>,
    pub hold_available: bool,
    pub known_next: Vec<Piece>,
    pub chain: Chain,
    pub incoming: Incoming,
    pub horizon: Horizon,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateInput {
    occupancy: [u64; 10],
    materialized_g: [u64; 10],
    current: Piece,
    hold: Option<Piece>,
    hold_available: bool,
    known_next: Vec<Piece>,
    chain: Chain,
    incoming: Incoming,
}
impl State {
    pub fn root_moves(&self) -> Result<Vec<(bool, crate::movegen::NativeS2Move)>> {
        self.validate()?;
        if self.horizon != Horizon::Open {
            return Err(Error::InvalidInput);
        }
        let current = self.current.ok_or(Error::InvalidInput)?;
        let mut sources = vec![(false, current)];
        if self.hold_available {
            if let Some(piece) = self.hold.or(self.known_next.first().copied()) {
                sources.push((true, piece));
            }
        }
        let generate = |entry| {
            sources
                .iter()
                .flat_map(|&(hold, piece)| {
                    crate::movegen::find_native_s2_moves(&self.board, piece, entry)
                        .into_iter()
                        .map(move |mv| (hold, mv))
                })
                .collect::<Vec<_>>()
        };
        let mut moves = generate(crate::movegen::RootEntry::Normal);
        if moves.is_empty() {
            moves = generate(crate::movegen::RootEntry::SpawnBufferFallback);
        }
        Ok(moves)
    }
    /// State payload, not the transport envelope.
    pub fn from_json(json: &str) -> Result<Self> {
        // Option<T> normally treats missing as null. Required null hold is checked explicitly.
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|_| Error::InvalidInput)?;
        if value.get("hold").is_none() {
            return Err(Error::InvalidInput);
        }
        let input: StateInput = serde_json::from_value(value).map_err(|_| Error::InvalidInput)?;
        let state = Self {
            board: Board {
                cols: input.occupancy,
            },
            materialized_g: Board {
                cols: input.materialized_g,
            },
            current: Some(input.current),
            hold: input.hold,
            hold_available: input.hold_available,
            known_next: input.known_next,
            chain: input.chain,
            incoming: input.incoming,
            horizon: Horizon::Open,
        };
        state.validate()?;
        Ok(state)
    }
    pub fn validate(&self) -> Result<()> {
        self.incoming.validate()?;
        if self.known_next.len() > 100
            || self.board.cols.iter().any(|c| c >> 40 != 0)
            || self
                .materialized_g
                .cols
                .iter()
                .zip(self.board.cols)
                .any(|(g, c)| g & !c != 0)
        {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }
    /// Consumes a lock whose final rotation evidence was validated by move generation.
    /// This function validates final geometry; it does not claim full path reachability.
    pub fn lock(
        &self,
        witness: &crate::movegen::NativeS2Move,
        hold_used: bool,
        multiplier: f64,
        root: &[RootAmounts],
    ) -> Result<(Self, Clear, Attack)> {
        self.lock_model(witness, hold_used, multiplier, Some(root))
    }
    pub fn lock_future(&self, witness: &crate::movegen::NativeS2Move, hold_used: bool, multiplier: f64)
        -> Result<(Self, Clear, Attack)> {
        self.lock_model(witness, hold_used, multiplier, None)
    }
    fn lock_model(&self, witness: &crate::movegen::NativeS2Move, hold_used: bool, multiplier: f64,
        root: Option<&[RootAmounts]>) -> Result<(Self, Clear, Attack)> {
        self.validate()?;
        if *witness.source_board != self.board {
            return Err(Error::IllegalPlacement);
        }
        let location = witness.location;
        let spin = witness.spin;
        if self.horizon != Horizon::Open {
            return Err(Error::InvalidInput);
        }
        let current = self.current.ok_or(Error::InvalidInput)?;
        let mut next = self.clone();
        let expected = if hold_used {
            if !self.hold_available {
                return Err(Error::IllegalPlacement);
            }
            next.hold = Some(current);
            match self.hold {
                Some(p) => p,
                None => {
                    if next.known_next.is_empty() {
                        return Err(Error::IllegalPlacement);
                    }
                    next.known_next.remove(0)
                }
            }
        } else {
            current
        };
        // Check coordinates before PieceLocation i8 arithmetic or bit shifts.
        if location.piece != expected
            || !(-4..=43).contains(&location.y)
            || !(-4..=13).contains(&location.x)
            || location.obstructed(&self.board)
            || location.drop_distance(&self.board) != 0
        {
            return Err(Error::IllegalPlacement);
        }
        next.board.place(location);
        let cleared = next.board.line_clears();
        let any_g = next.materialized_g.cols.iter().any(|g| g & cleared != 0);
        next.board.remove_lines(cleared);
        next.materialized_g.remove_lines(cleared);
        let clear = Clear {
            lines: cleared.count_ones(),
            spin,
            perfect_clear: cleared != 0 && next.board.cols.iter().all(|c| *c == 0),
            cleared_any_g: any_g,
        };
        let (chain, attack) = attack(self.chain, clear, multiplier)?;
        let amounts = if let Some(root) = root {
            let mut matching = root.iter().filter(|row| row.signature == clear);
            let row = matching.next().ok_or(Error::OracleMismatch)?;
            if matching.next().is_some() { return Err(Error::OracleMismatch); }
            row.validate(self.incoming, clear, attack.outgoing_before_cancel)?
        } else {
            let cancelled = attack.outgoing_before_cancel.min(self.incoming.pending_rows);
            let tank = if clear.lines == 0 { self.incoming.due_this_lock_rows } else { 0 };
            RootAmounts { signature: clear, outgoing_before_cancel: attack.outgoing_before_cancel,
                cancelled_rows: cancelled, outgoing_after_cancel: attack.outgoing_before_cancel - cancelled,
                remaining_rows: self.incoming.pending_rows - cancelled - tank, tank_rows: tank,
                due_rows_after_lock: if tank > 0 { 0 } else { self.incoming.due_this_lock_rows.saturating_sub(cancelled) }
            }.validate(self.incoming, clear, attack.outgoing_before_cancel)?
        };
        next.chain = Chain {
            combo: chain.combo_after,
            b2b: chain.b2b_after,
        };
        next.incoming = Incoming {
            pending_rows: amounts.remaining_rows,
            due_this_lock_rows: amounts.due_rows_after_lock,
        };
        next.current = if next.known_next.is_empty() {
            None
        } else {
            Some(next.known_next.remove(0))
        };
        next.hold_available = true;
        next.horizon = if amounts.tank_rows > 0 {
            Horizon::UnknownTank {
                rows: amounts.tank_rows,
            }
        } else if next.current.is_none() {
            Horizon::KnownNextExhausted
        } else {
            Horizon::Open
        };
        Ok((next, clear, attack))
    }
}

/// S-02/S-03: no finite sentinel and no f32 narrowing. Fields are private so NaN
/// cannot be constructed through the public API or deserialization.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Value(ValueKind);
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum ValueKind {
    TerminalLoss,
    Finite(OrderedFloat<f64>),
}
impl Value {
    pub const LOSS: Self = Self(ValueKind::TerminalLoss);
    pub fn finite(value: f64) -> Result<Self> {
        if !value.is_finite() {
            Err(Error::NumericOverflow)
        } else {
            Ok(Self(ValueKind::Finite(OrderedFloat(if value == 0. {
                0.
            } else {
                value
            }))))
        }
    }
    pub fn add_reward(self, reward: f64) -> Result<Self> {
        let reward = Self::finite(reward)?;
        match (self.0, reward.0) {
            (ValueKind::Finite(v), ValueKind::Finite(r)) => Self::finite(v.0 + r.0),
            _ => Ok(Self::LOSS),
        }
    }
    pub fn best(children: impl Iterator<Item = Self>) -> Self {
        children.max().unwrap_or(Self::LOSS)
    }
    pub fn diagnostic(self) -> serde_json::Value {
        match self.0 {
            ValueKind::TerminalLoss => serde_json::json!({"kind":"terminal-loss"}),
            ValueKind::Finite(v) => serde_json::json!({"kind":"finite", "value":v.0}),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RootStatus {
    Move,
    RootNoMove,
    Incomplete,
}
/// No score/pressure argument: prediction cannot turn legal actions into no-move.
pub fn classify_root(
    root_expansion_complete: bool,
    legal_count: usize,
    budget_complete: bool,
    frontier_complete: bool,
) -> RootStatus {
    if !root_expansion_complete {
        RootStatus::Incomplete
    } else if legal_count == 0 {
        RootStatus::RootNoMove
    } else if budget_complete || frontier_complete {
        RootStatus::Move
    } else {
        RootStatus::Incomplete
    }
}

/// Canonical all-mini+ spin from validated last-rotation proof. CC2 labels are
/// intentionally not inputs. Fin/TST is the canonical transition+offset rule.
pub(crate) fn spin_from_evidence(
    board: &Board,
    target: PieceLocation,
    last_rotation: bool,
    from_rotation: Rotation,
    kick_offset: (i8, i8),
) -> CanonicalSpin {
    if !last_rotation {
        return CanonicalSpin::None;
    }
    let stuck = [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().all(|&(dx, dy)| {
        PieceLocation {
            x: target.x + dx,
            y: target.y + dy,
            ..target
        }
        .obstructed(board)
    });
    if target.piece == Piece::T {
        let count = [(-1, -1), (1, -1), (-1, 1), (1, 1)]
            .iter()
            .filter(|&&(x, y)| board.occupied((target.x + x, target.y + y)))
            .count();
        if count >= 3 {
            let front = [(-1, 1), (1, 1)]
                .iter()
                .filter(|&&cell| {
                    let (x, y) = target.rotation.rotate_cell(cell);
                    board.occupied((target.x + x, target.y + y))
                })
                .count();
            let fin = matches!(from_rotation, Rotation::North | Rotation::South)
                && ((target.rotation == Rotation::West && kick_offset == (1, -2))
                    || (target.rotation == Rotation::East && kick_offset == (-1, -2)));
            return if front == 2 || fin {
                CanonicalSpin::Normal
            } else {
                CanonicalSpin::Mini
            };
        }
    }
    if stuck {
        CanonicalSpin::Mini
    } else {
        CanonicalSpin::None
    }
}

#[cfg(test)]
mod tests;

pub mod transport;
