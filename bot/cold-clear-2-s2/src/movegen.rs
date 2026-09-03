use std::cmp::Ordering;
use std::collections::BinaryHeap;

use ahash::AHashMap;
use serde::Serialize;

use crate::data::*;
use crate::generated_direct_180_kicks::direct_180_transition;

/// A root frontier produced without any search, suggestion limit, or selector.
///
/// The generator has no truncation path: returning this value means every
/// enqueued root movement state has been exhausted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompleteRootMoves {
    pub moves: Vec<(Placement, u32)>,
    pub queue_exhausted: bool,
}

/// Diagnostic-only route provenance for one complete-frontier target.
///
/// This deliberately does not participate in `find_moves_complete`: production
/// dominance remains keyed by `Placement`, while this expanded state retains a
/// direct-180 bit and a deterministic predecessor solely for games-zero audits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Direct180RouteSearch {
    pub queue_exhausted: bool,
    pub states_explored: usize,
    pub target_candidates: usize,
    pub witness: Option<Direct180RouteWitness>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Direct180RouteWitness {
    pub placement: Placement,
    pub soft_drops: u32,
    pub used_direct_180: bool,
    pub route_key: String,
    pub actions: Vec<DiagnosticRouteAction>,
    pub direct_180_transitions: Vec<DiagnosticDirect180Event>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRouteAction {
    pub kind: &'static str,
    pub from: Option<Placement>,
    pub to: Placement,
    pub soft_drops_before: u32,
    pub soft_drops_after: u32,
    pub drop_distance: Option<i8>,
    pub entry_rotation_index: Option<u8>,
    pub entry_x: Option<i8>,
    pub initial_lock_soft_drops: Option<u32>,
    pub kick_index: Option<usize>,
    pub native_offset: Option<[i8; 2]>,
    pub direct_180: Option<DiagnosticDirect180Event>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticDirect180Event {
    pub from: PieceLocation,
    pub to: PieceLocation,
    pub source_transition: &'static str,
    pub source_table: &'static str,
    pub accepted_row_index: usize,
    pub source_row: Option<u8>,
    pub source_offset: [i8; 2],
    pub native_offset: [i8; 2],
}

/// Exhaustively collect one deterministic direct-180 route to an exact target.
/// The complete OFF/ON frontier remains owned by `find_moves_complete`.
pub fn find_direct_180_route_witness_complete(
    board: &Board,
    piece: Piece,
    target: Placement,
    target_soft_drops: u32,
) -> Direct180RouteSearch {
    let collision_map = CollisionMaps::new(board, piece);
    let fast_mode = board.cols.iter().all(|&c| c.leading_zeros() > 64 - 16);
    let mut states: AHashMap<(Placement, bool), DiagnosticState> = AHashMap::new();
    let mut queue = BinaryHeap::new();
    let mut best_witness: Option<Direct180RouteWitness> = None;
    let mut target_candidates = 0;

    if fast_mode {
        for (rotation_index, &rotation) in [
            Rotation::North,
            Rotation::East,
            Rotation::South,
            Rotation::West,
        ]
        .iter()
        .enumerate()
        {
            for x in 0..10 {
                let source = PieceLocation {
                    piece,
                    rotation,
                    x,
                    y: 19,
                };
                if collision_map.obstructed(source) {
                    continue;
                }
                let distance = source.drop_distance(board);
                let landed = PieceLocation {
                    y: source.y - distance,
                    ..source
                };
                let source_placement = Placement {
                    location: source,
                    spin: Spin::None,
                };
                let landed_placement = Placement {
                    location: landed,
                    spin: Spin::None,
                };
                let action = DiagnosticRouteAction {
                    kind: "fast-entry",
                    from: Some(source_placement),
                    to: landed_placement,
                    soft_drops_before: 0,
                    soft_drops_after: distance as u32,
                    drop_distance: Some(distance),
                    entry_rotation_index: Some(rotation_index as u8),
                    entry_x: Some(x),
                    initial_lock_soft_drops: Some(0),
                    kick_index: None,
                    native_offset: None,
                    direct_180: None,
                };
                update_diagnostic_state(
                    &mut states,
                    &mut queue,
                    DiagnosticState {
                        mv: landed_placement,
                        used_direct_180: false,
                        soft_drops: distance as u32,
                        actions: vec![action],
                    },
                    false,
                    board,
                );
            }
        }
    } else {
        let mut spawned = PieceLocation {
            piece,
            rotation: Rotation::North,
            x: 4,
            y: 19,
        };
        let mut corrected = false;
        if collision_map.obstructed(spawned) {
            spawned.y += 1;
            corrected = true;
            if collision_map.obstructed(spawned) {
                return Direct180RouteSearch {
                    queue_exhausted: true,
                    states_explored: 0,
                    target_candidates: 0,
                    witness: None,
                };
            }
        }
        let placement = Placement {
            location: spawned,
            spin: Spin::None,
        };
        update_diagnostic_state(
            &mut states,
            &mut queue,
            DiagnosticState {
                mv: placement,
                used_direct_180: false,
                soft_drops: 0,
                actions: vec![DiagnosticRouteAction {
                    kind: "spawn-entry",
                    from: None,
                    to: placement,
                    soft_drops_before: 0,
                    soft_drops_after: 0,
                    drop_distance: Some(if corrected { -1 } else { 0 }),
                    entry_rotation_index: Some(0),
                    entry_x: Some(4),
                    initial_lock_soft_drops: None,
                    kick_index: None,
                    native_offset: None,
                    direct_180: None,
                }],
            },
            fast_mode,
            board,
        );
    }

    let mut states_explored = 0;
    while let Some(entry) = queue.pop() {
        let key = (entry.mv, entry.used_direct_180);
        let Some(current) = states.get(&key).cloned() else {
            continue;
        };
        if diagnostic_rank(&current) != entry.rank {
            continue;
        }
        states_explored += 1;

        let drop_distance = current.mv.location.drop_distance(board);
        let dropped = Placement {
            location: PieceLocation {
                y: current.mv.location.y - drop_distance,
                ..current.mv.location
            }
            .canonical_form(),
            spin: if drop_distance == 0 {
                current.mv.spin
            } else {
                Spin::None
            },
        };
        if current.used_direct_180 && dropped == target && current.soft_drops == target_soft_drops {
            target_candidates += 1;
            let mut actions = current.actions.clone();
            actions.push(DiagnosticRouteAction {
                kind: "lock",
                from: Some(current.mv),
                to: dropped,
                soft_drops_before: current.soft_drops,
                soft_drops_after: current.soft_drops,
                drop_distance: Some(drop_distance),
                entry_rotation_index: None,
                entry_x: None,
                initial_lock_soft_drops: None,
                kick_index: None,
                native_offset: None,
                direct_180: None,
            });
            let route_key = diagnostic_route_key(&actions);
            let direct_180_transitions = actions
                .iter()
                .filter_map(|action| action.direct_180.clone())
                .collect();
            let candidate = Direct180RouteWitness {
                placement: dropped,
                soft_drops: current.soft_drops,
                used_direct_180: true,
                route_key,
                actions,
                direct_180_transitions,
            };
            if best_witness
                .as_ref()
                .map(|best| witness_rank(&candidate) < witness_rank(best))
                .unwrap_or(true)
            {
                best_witness = Some(candidate);
            }
        }

        let mut push = |mv: Placement,
                        soft_drops: u32,
                        kind: &'static str,
                        distance: Option<i8>,
                        kick_index: Option<usize>,
                        native_offset: Option<[i8; 2]>,
                        direct_180: Option<DiagnosticDirect180Event>| {
            let mut actions = current.actions.clone();
            actions.push(DiagnosticRouteAction {
                kind,
                from: Some(current.mv),
                to: mv,
                soft_drops_before: current.soft_drops,
                soft_drops_after: soft_drops,
                drop_distance: distance,
                entry_rotation_index: None,
                entry_x: None,
                initial_lock_soft_drops: None,
                kick_index,
                native_offset,
                direct_180: direct_180.clone(),
            });
            update_diagnostic_state(
                &mut states,
                &mut queue,
                DiagnosticState {
                    mv,
                    used_direct_180: current.used_direct_180 || direct_180.is_some(),
                    soft_drops,
                    actions,
                },
                fast_mode,
                board,
            );
        };

        let expanded_drop = Placement {
            location: PieceLocation {
                y: current.mv.location.y - drop_distance,
                ..current.mv.location
            },
            spin: if drop_distance == 0 {
                current.mv.spin
            } else {
                Spin::None
            },
        };
        push(
            expanded_drop,
            current.soft_drops + drop_distance as u32,
            "drop",
            Some(drop_distance),
            None,
            None,
            None,
        );
        if let Some(mv) = shift(current.mv.location, &collision_map, -1) {
            push(mv, current.soft_drops, "shift-left", None, None, None, None);
        }
        if let Some(mv) = shift(current.mv.location, &collision_map, 1) {
            push(
                mv,
                current.soft_drops,
                "shift-right",
                None,
                None,
                None,
                None,
            );
        }
        if let Some((mv, row, offset)) =
            diagnostic_rotate_90(current.mv.location, &collision_map, board, true)
        {
            push(
                mv,
                current.soft_drops,
                "rotate-cw",
                None,
                Some(row),
                Some(offset),
                None,
            );
        }
        if let Some((mv, row, offset)) =
            diagnostic_rotate_90(current.mv.location, &collision_map, board, false)
        {
            push(
                mv,
                current.soft_drops,
                "rotate-ccw",
                None,
                Some(row),
                Some(offset),
                None,
            );
        }
        if let Some((mv, event)) = diagnostic_rotate_180(current.mv.location, &collision_map, board)
        {
            let row = event.accepted_row_index;
            let offset = event.native_offset;
            push(
                mv,
                current.soft_drops,
                "rotate-180",
                None,
                Some(row),
                Some(offset),
                Some(event),
            );
        }
    }

    Direct180RouteSearch {
        queue_exhausted: true,
        states_explored,
        target_candidates,
        witness: best_witness,
    }
}

pub fn find_moves(board: &Board, piece: Piece, enable_direct_180: bool) -> Vec<(Placement, u32)> {
    find_moves_complete(board, piece, enable_direct_180).moves
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RootEntry {
    Normal,
    SpawnBufferFallback,
}

pub fn find_moves_complete(
    board: &Board,
    piece: Piece,
    enable_direct_180: bool,
) -> CompleteRootMoves {
    find_moves_complete_with_entry(board, piece, enable_direct_180, RootEntry::Normal)
}

pub fn find_moves_complete_with_entry(
    board: &Board,
    piece: Piece,
    enable_direct_180: bool,
    entry: RootEntry,
) -> CompleteRootMoves {
    puffin::profile_function!();
    let mut queue = BinaryHeap::new();
    let mut values = AHashMap::new();
    let mut underground_locks = AHashMap::new();
    let mut locks = Vec::with_capacity(64);
    let collision_map = CollisionMaps::new(board, piece).with_ceiling(
        if entry == RootEntry::SpawnBufferFallback { 21 } else { 20 },
    );

    let fast_mode = board.cols.iter().all(|&c| c.leading_zeros() > 64 - 16);
    if entry == RootEntry::SpawnBufferFallback && fast_mode {
        debug_assert!(!fast_mode, "spawn buffer fallback requires a blocked normal root");
        return CompleteRootMoves { moves: Vec::new(), queue_exhausted: true };
    }
    if fast_mode {
        for &rotation in &[
            Rotation::North,
            Rotation::East,
            Rotation::South,
            Rotation::West,
        ] {
            for x in 0..10 {
                let mut location = PieceLocation {
                    piece,
                    rotation,
                    x,
                    y: 19,
                };
                if collision_map.obstructed(location) {
                    continue;
                }
                let distance = location.drop_distance(board);
                location.y -= distance;
                let mv = Placement {
                    location,
                    spin: Spin::None,
                };

                let mut update_position =
                    update_position(&mut queue, &mut values, fast_mode, board);

                if let Some(mv) = shift(location, &collision_map, -1) {
                    update_position(mv, distance as u32);
                }
                if let Some(mv) = shift(location, &collision_map, 1) {
                    update_position(mv, distance as u32);
                }
                if let Some(mv) = rotate_cw(location, &collision_map, board) {
                    update_position(mv, distance as u32);
                }
                if let Some(mv) = rotate_ccw(location, &collision_map, board) {
                    update_position(mv, distance as u32);
                }
                if enable_direct_180 {
                    if let Some(mv) = rotate_180(location, &collision_map, board) {
                        update_position(mv, distance as u32);
                    }
                }

                if location.canonical_form() == location {
                    locks.push((mv, 0));
                }
            }
        }
    } else {
        let mut spawned = PieceLocation {
            piece,
            rotation: Rotation::North,
            x: 4,
            y: if entry == RootEntry::SpawnBufferFallback { 20 } else { 19 },
        };
        if collision_map.obstructed(spawned) {
            if entry == RootEntry::Normal { spawned.y += 1; }
            if collision_map.obstructed(spawned) {
                return CompleteRootMoves {
                    moves: Vec::new(),
                    queue_exhausted: true,
                };
            }
        }
        let spawned = Placement {
            location: spawned,
            spin: Spin::None,
        };
        queue.push(Intermediate {
            soft_drops: 0,
            mv: spawned,
        });
        values.insert(spawned, 0);
    }

    while let Some(expand) = queue.pop() {
        if expand.soft_drops != values.get(&expand.mv).copied().unwrap_or(40) {
            continue;
        }

        let drop_dist = expand.mv.location.drop_distance(board);
        let dropped = Placement {
            location: PieceLocation {
                y: expand.mv.location.y - drop_dist,
                ..expand.mv.location
            },
            spin: if drop_dist == 0 {
                expand.mv.spin
            } else {
                Spin::None
            },
        };

        let sds = underground_locks
            .entry(Placement {
                location: dropped.location.canonical_form(),
                ..dropped
            })
            .or_insert(expand.soft_drops);
        *sds = expand.soft_drops.min(*sds);

        let mut update_position = update_position(&mut queue, &mut values, fast_mode, board);

        update_position(dropped, expand.soft_drops + drop_dist as u32);

        if let Some(mv) = shift(expand.mv.location, &collision_map, -1) {
            update_position(mv, expand.soft_drops);
        }
        if let Some(mv) = shift(expand.mv.location, &collision_map, 1) {
            update_position(mv, expand.soft_drops);
        }
        if let Some(mv) = rotate_cw(expand.mv.location, &collision_map, board) {
            update_position(mv, expand.soft_drops);
        }
        if let Some(mv) = rotate_ccw(expand.mv.location, &collision_map, board) {
            update_position(mv, expand.soft_drops);
        }
        if enable_direct_180 {
            if let Some(mv) = rotate_180(expand.mv.location, &collision_map, board) {
                update_position(mv, expand.soft_drops);
            }
        }
    }

    // AHashMap iteration order depends on a per-process random hasher seed, so
    // draining it directly makes the returned move order differ between runs of
    // the same binary. The search picks children by index, so that alone makes a
    // fixed selection budget non-reproducible once underground locks exist.
    // Sorting only this tail leaves the order of every other lock untouched.
    let mut underground: Vec<_> = underground_locks.into_iter().collect();
    underground.sort_unstable_by_key(|(placement, value)| {
        (
            placement.location.piece as u8,
            placement.location.rotation as u8,
            placement.location.x,
            placement.location.y,
            placement.spin as u8,
            *value,
        )
    });
    locks.extend(underground);
    if entry == RootEntry::SpawnBufferFallback {
        locks.retain(|(placement, _)| placement.location.cells().iter().all(|&(_, y)| y < 20));
    }
    CompleteRootMoves {
        moves: locks,
        queue_exhausted: true,
    }
}

fn update_position<'a>(
    queue: &'a mut BinaryHeap<Intermediate>,
    values: &'a mut AHashMap<Placement, u32>,
    fast_mode: bool,
    board: &'a Board,
) -> impl FnMut(Placement, u32) + 'a {
    move |target: Placement, soft_drops: u32| {
        if fast_mode && target.location.above_stack(board) {
            return;
        }
        let prev_sds = values.entry(target).or_insert(40);
        if soft_drops < *prev_sds {
            *prev_sds = soft_drops;
            queue.push(Intermediate {
                soft_drops,
                mv: target,
            });
        }
    }
}

fn shift(mut location: PieceLocation, collision_map: &CollisionMaps, dx: i8) -> Option<Placement> {
    location.x += dx;
    if collision_map.obstructed(location) {
        return None;
    }
    Some(Placement {
        location,
        spin: Spin::None,
    })
}

fn rotate_cw(
    from: PieceLocation,
    collision_map: &CollisionMaps,
    board: &Board,
) -> Option<Placement> {
    if from.piece == Piece::O {
        return None;
    }
    const KICKS: [[[(i8, i8); 5]; 4]; 7] =
        piece_lut!(piece => rotation_lut!(rotation => kicks(piece, rotation, rotation.cw())));
    let unkicked = PieceLocation {
        rotation: from.rotation.cw(),
        ..from
    };
    rotate(
        unkicked,
        collision_map,
        board,
        KICKS[from.piece as usize][from.rotation as usize]
            .iter()
            .copied()
            .enumerate()
            .map(|(row_index, offset)| RotationAttempt {
                offset,
                fin_or_tst_override: legacy_native_90_full_override(row_index),
            }),
    )
}

fn rotate_ccw(
    from: PieceLocation,
    collision_map: &CollisionMaps,
    board: &Board,
) -> Option<Placement> {
    if from.piece == Piece::O {
        return None;
    }
    const KICKS: [[[(i8, i8); 5]; 4]; 7] =
        piece_lut!(piece => rotation_lut!(rotation => kicks(piece, rotation, rotation.ccw())));
    let unkicked = PieceLocation {
        rotation: from.rotation.ccw(),
        ..from
    };
    rotate(
        unkicked,
        collision_map,
        board,
        KICKS[from.piece as usize][from.rotation as usize]
            .iter()
            .copied()
            .enumerate()
            .map(|(row_index, offset)| RotationAttempt {
                offset,
                fin_or_tst_override: legacy_native_90_full_override(row_index),
            }),
    )
}

fn rotate_180(
    from: PieceLocation,
    collision_map: &CollisionMaps,
    board: &Board,
) -> Option<Placement> {
    let transition = direct_180_transition(from.piece, from.rotation);
    debug_assert_eq!(transition.to, from.rotation.flip());
    debug_assert!(transition.row_count as usize <= transition.rows.len());
    debug_assert!(transition
        .rows
        .iter()
        .take(transition.row_count as usize)
        .all(|row| !row.fin_or_tst_override));

    let unkicked = PieceLocation {
        rotation: from.rotation.flip(),
        ..from
    };
    rotate(
        unkicked,
        collision_map,
        board,
        transition
            .rows
            .iter()
            .take(transition.row_count as usize)
            .map(|row| RotationAttempt {
                offset: row.native_offset,
                fin_or_tst_override: row.fin_or_tst_override,
            }),
    )
}

const fn offsets(piece: Piece, rotation: Rotation) -> [(i8, i8); 5] {
    match piece {
        Piece::O => match rotation {
            Rotation::North => [(0, 0); 5],
            Rotation::East => [(0, -1); 5],
            Rotation::South => [(-1, -1); 5],
            Rotation::West => [(-1, 0); 5],
        },
        Piece::I => match rotation {
            Rotation::North => [(0, 0), (-1, 0), (2, 0), (-1, 0), (2, 0)],
            Rotation::East => [(-1, 0), (0, 0), (0, 0), (0, 1), (0, -2)],
            Rotation::South => [(-1, 1), (1, 1), (-2, 1), (1, 0), (-2, 0)],
            Rotation::West => [(0, 1), (0, 1), (0, 1), (0, -1), (0, 2)],
        },
        _ => match rotation {
            Rotation::North => [(0, 0); 5],
            Rotation::East => [(0, 0), (1, 0), (1, -1), (0, 2), (1, 2)],
            Rotation::South => [(0, 0); 5],
            Rotation::West => [(0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)],
        },
    }
}

const fn kicks(piece: Piece, from: Rotation, to: Rotation) -> [(i8, i8); 5] {
    let mut kicks = [(0, 0); 5];
    let from = offsets(piece, from);
    let to = offsets(piece, to);
    let mut i = 0;
    while i < kicks.len() {
        kicks[i] = (from[i].0 - to[i].0, from[i].1 - to[i].1);
        i += 1;
    }
    kicks
}

fn rotate(
    unkicked: PieceLocation,
    collision_map: &CollisionMaps,
    board: &Board,
    attempts: impl Iterator<Item = RotationAttempt>,
) -> Option<Placement> {
    for attempt in attempts {
        let (dx, dy) = attempt.offset;
        let target = PieceLocation {
            x: unkicked.x + dx,
            y: unkicked.y + dy,
            ..unkicked
        };
        if collision_map.obstructed(target) {
            continue;
        }

        let spin;
        if target.piece != Piece::T {
            // TETR.IO S2 rewards all-spin locks. Keep CC2's compact movement
            // representation, but retain a rotation-earned non-T spin when the
            // final pose cannot translate in any cardinal direction. The
            // canonical S2 Simulator remains authoritative when reranking.
            let stuck = [(1, 0), (-1, 0), (0, 1), (0, -1)]
                .iter()
                .filter(|&&(cx, cy)| {
                    collision_map.obstructed(PieceLocation {
                        x: target.x + cx,
                        y: target.y + cy,
                        ..target
                    })
                })
                .count();
            spin = if stuck == 4 { Spin::Mini } else { Spin::None };
        } else {
            let corners = [(-1, -1), (1, -1), (-1, 1), (1, 1)]
                .iter()
                .filter(|&&(cx, cy)| board.occupied((cx + target.x, cy + target.y)))
                .count();
            let mini_corners = [(-1, 1), (1, 1)]
                .iter()
                .map(|&c| target.rotation.rotate_cell(c))
                .filter(|&(cx, cy)| board.occupied((cx + target.x, cy + target.y)))
                .count();

            if corners < 3 {
                spin = Spin::None;
            } else if mini_corners == 2 || attempt.fin_or_tst_override {
                spin = Spin::Full;
            } else {
                spin = Spin::Mini;
            }
        }

        return Some(Placement {
            location: target,
            spin,
        });
    }

    None
}

#[derive(Clone, Copy, Debug)]
struct RotationAttempt {
    offset: (i8, i8),
    fin_or_tst_override: bool,
}

const fn legacy_native_90_full_override(row_index: usize) -> bool {
    // This is intentionally the exact pre-direct-180 CC2 proposal-metadata
    // behavior. Canonical S2 independently rechecks the accepted placement's
    // true Fin/TST status; changing this local row-4 label would contaminate the
    // disabled control frontier. Generated direct-180 rows never call this.
    row_index == 4
}

#[derive(Clone, Debug)]
struct DiagnosticState {
    mv: Placement,
    used_direct_180: bool,
    soft_drops: u32,
    actions: Vec<DiagnosticRouteAction>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DiagnosticIntermediate {
    mv: Placement,
    used_direct_180: bool,
    rank: (u32, usize, String),
}

impl Ord for DiagnosticIntermediate {
    fn cmp(&self, other: &Self) -> Ordering {
        other.rank.cmp(&self.rank)
    }
}

impl PartialOrd for DiagnosticIntermediate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn diagnostic_route_key(actions: &[DiagnosticRouteAction]) -> String {
    // serde_json::Value objects use sorted keys without `preserve_order`, which
    // matches CS1 for this integer/string/null-only schema.
    serde_json::to_string(&serde_json::to_value(actions).unwrap()).unwrap()
}

fn diagnostic_rank(state: &DiagnosticState) -> (u32, usize, String) {
    (
        state.soft_drops,
        state.actions.len(),
        diagnostic_route_key(&state.actions),
    )
}

fn witness_rank(witness: &Direct180RouteWitness) -> (u32, usize, &str) {
    (
        witness.soft_drops,
        witness.actions.len(),
        witness.route_key.as_str(),
    )
}

fn update_diagnostic_state(
    states: &mut AHashMap<(Placement, bool), DiagnosticState>,
    queue: &mut BinaryHeap<DiagnosticIntermediate>,
    candidate: DiagnosticState,
    fast_mode: bool,
    board: &Board,
) {
    if fast_mode && candidate.mv.location.above_stack(board) {
        return;
    }
    let key = (candidate.mv, candidate.used_direct_180);
    let rank = diagnostic_rank(&candidate);
    if states
        .get(&key)
        .map(|previous| diagnostic_rank(previous) <= rank)
        .unwrap_or(false)
    {
        return;
    }
    states.insert(key, candidate);
    queue.push(DiagnosticIntermediate {
        mv: key.0,
        used_direct_180: key.1,
        rank,
    });
}

fn diagnostic_rotate_90(
    from: PieceLocation,
    collision_map: &CollisionMaps,
    board: &Board,
    clockwise: bool,
) -> Option<(Placement, usize, [i8; 2])> {
    if from.piece == Piece::O {
        return None;
    }
    let to = if clockwise {
        from.rotation.cw()
    } else {
        from.rotation.ccw()
    };
    let attempts = kicks(from.piece, from.rotation, to);
    let unkicked = PieceLocation {
        rotation: to,
        ..from
    };
    let placement = rotate(
        unkicked,
        collision_map,
        board,
        attempts
            .iter()
            .copied()
            .enumerate()
            .map(|(row_index, offset)| RotationAttempt {
                offset,
                fin_or_tst_override: legacy_native_90_full_override(row_index),
            }),
    )?;
    for (row_index, (dx, dy)) in attempts.iter().copied().enumerate() {
        let target = PieceLocation {
            x: unkicked.x + dx,
            y: unkicked.y + dy,
            ..unkicked
        };
        if !collision_map.obstructed(target) {
            debug_assert_eq!(target, placement.location);
            return Some((placement, row_index, [dx, dy]));
        }
    }
    unreachable!("successful native 90 rotation must have an accepted row")
}

fn diagnostic_rotate_180(
    from: PieceLocation,
    collision_map: &CollisionMaps,
    board: &Board,
) -> Option<(Placement, DiagnosticDirect180Event)> {
    let placement = rotate_180(from, collision_map, board)?;
    let transition = direct_180_transition(from.piece, from.rotation);
    let unkicked = PieceLocation {
        rotation: transition.to,
        ..from
    };
    for (accepted_row_index, row) in transition
        .rows
        .iter()
        .take(transition.row_count as usize)
        .enumerate()
    {
        let target = PieceLocation {
            x: unkicked.x + row.native_offset.0,
            y: unkicked.y + row.native_offset.1,
            ..unkicked
        };
        if !collision_map.obstructed(target) {
            debug_assert_eq!(target, placement.location);
            return Some((
                placement,
                DiagnosticDirect180Event {
                    from,
                    to: target,
                    source_transition: transition.source_transition,
                    source_table: transition.source_table,
                    accepted_row_index,
                    source_row: row.source_row,
                    source_offset: [row.source_offset.0, row.source_offset.1],
                    native_offset: [row.native_offset.0, row.native_offset.1],
                },
            ));
        }
    }
    unreachable!("successful native 180 rotation must have an accepted row")
}

#[derive(Clone, Copy, Debug, Eq)]
struct Intermediate {
    mv: Placement,
    soft_drops: u32,
}

impl PartialEq for Intermediate {
    fn eq(&self, other: &Intermediate) -> bool {
        self.soft_drops == other.soft_drops
    }
}

impl Ord for Intermediate {
    fn cmp(&self, other: &Intermediate) -> Ordering {
        self.soft_drops.cmp(&other.soft_drops)
    }
}

impl PartialOrd for Intermediate {
    fn partial_cmp(&self, other: &Intermediate) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

struct CollisionMaps {
    boards: [[u64; 10]; 4],
    ceiling: i8,
}

impl CollisionMaps {
    fn new(board: &Board, piece: Piece) -> Self {
        let mut boards = [[0; 10]; 4];
        for rot in [
            Rotation::North,
            Rotation::West,
            Rotation::South,
            Rotation::East,
        ] {
            for (dx, dy) in rot.rotate_cells(piece.cells()) {
                for x in 0..10 {
                    let c = board.cols.get((x + dx) as usize).copied().unwrap_or(!0);
                    let c = match dy < 0 {
                        true => !(!c << -dy),
                        false => c >> dy,
                    };
                    boards[rot as usize][x as usize] |= c;
                }
            }
        }
        CollisionMaps { boards, ceiling: 20 }
    }

    fn with_ceiling(mut self, ceiling: i8) -> Self {
        self.ceiling = ceiling;
        self
    }

    fn obstructed(&self, piece: PieceLocation) -> bool {
        if piece.y < 0 || piece.x < 0 || piece.x >= 10 || piece.y >= self.ceiling {
            return true;
        }
        let v = self.boards[piece.rotation as usize]
            .get(piece.x as usize)
            .map(|&c| c & 1 << piece.y != 0)
            .unwrap_or(true);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::{
        direct_180_transition, find_direct_180_route_witness_complete, find_moves,
        find_moves_complete, kicks, legacy_native_90_full_override, rotate, rotate_180,
        CollisionMaps, RotationAttempt,
    };
    use crate::data::{Board, Piece, PieceLocation, Placement, Rotation, Spin};
    use crate::generated_direct_180_kicks::DIRECT_180_MAX_ROWS;


    fn a3_board() -> Board { Board { cols: [524287, 1048448, 1048191, 1048575, 1048575, 1048575, 262143, 196607, 511, 65535] } }
    #[test]
    fn spawn_buffer_recovers_a3_with_visible_deterministic_locks() {
        for piece in [Piece::L, Piece::Z] {
            let board = a3_board();
            assert!(find_moves(&board, piece, false).is_empty());
            let fallback = super::find_moves_complete_with_entry(&board, piece, false, super::RootEntry::SpawnBufferFallback);
            assert!(fallback.queue_exhausted);
            assert!(!fallback.moves.is_empty());
            assert!(fallback.moves.iter().all(|(p, _)| p.location.cells().iter().all(|&(_, y)| y < 20)));
            assert_eq!(fallback.moves, super::find_moves_complete_with_entry(&board, piece, false, super::RootEntry::SpawnBufferFallback).moves);
        }
    }
    #[test]
    fn spawn_buffer_fails_closed_when_hidden_origin_is_occupied() {
        let mut board = a3_board();
        for col in &mut board.cols { *col |= 1 << 20; }
        for piece in [Piece::L, Piece::Z] {
            assert!(super::find_moves_complete_with_entry(&board, piece, false, super::RootEntry::SpawnBufferFallback).moves.is_empty());
        }
    }
    #[test]
    fn normal_entry_keeps_the_legacy_ceiling() {
        let board = Board::default();
        for piece in NON_O_PIECES {
            let map = CollisionMaps::new(&board, piece);
            let location = PieceLocation { piece, rotation: Rotation::North, x: 4, y: 20 };
            assert!(map.obstructed(location));
            assert!(!map.with_ceiling(21).obstructed(location));
            assert_eq!(find_moves(&board, piece, false), super::find_moves_complete_with_entry(&board, piece, false, super::RootEntry::Normal).moves);
        }
    }

    const ROTATIONS: [Rotation; 4] = [
        Rotation::North,
        Rotation::West,
        Rotation::South,
        Rotation::East,
    ];

    const NON_O_PIECES: [Piece; 6] = [Piece::I, Piece::T, Piece::L, Piece::J, Piece::S, Piece::Z];

    #[test]
    fn diagnostic_expanded_state_retains_j_double_route_and_first_legal_row() {
        let mut board = Board::default();
        for &(x, y) in &[
            (0, 0),
            (1, 0),
            (3, 0),
            (4, 0),
            (5, 0),
            (6, 0),
            (7, 0),
            (8, 0),
            (9, 0),
            (3, 1),
            (4, 1),
            (5, 1),
            (6, 1),
            (7, 1),
            (8, 1),
            (9, 1),
            (0, 2),
            (3, 2),
            (4, 2),
            (5, 2),
            (6, 2),
            (8, 2),
            (9, 2),
            (1, 3),
            (3, 3),
            (4, 3),
            (7, 3),
            (8, 3),
            (9, 3),
        ] {
            board.cols[x] |= 1 << y;
        }
        let target = Placement {
            location: PieceLocation {
                piece: Piece::J,
                rotation: Rotation::South,
                x: 1,
                y: 1,
            },
            spin: Spin::Mini,
        };
        let search = find_direct_180_route_witness_complete(&board, Piece::J, target, 17);
        assert!(search.queue_exhausted);
        let witness = search
            .witness
            .expect("JSD must retain the frozen cost-17 route");
        assert_eq!(witness.placement, target);
        assert_eq!(witness.soft_drops, 17);
        assert!(witness.used_direct_180);
        assert!(!witness.direct_180_transitions.is_empty());
        for event in witness.direct_180_transitions {
            let transition = direct_180_transition(Piece::J, event.from.rotation);
            assert_eq!(event.source_transition, transition.source_transition);
            assert_eq!(
                event.native_offset,
                [
                    transition.rows[event.accepted_row_index].native_offset.0,
                    transition.rows[event.accepted_row_index].native_offset.1
                ]
            );
            let collision = CollisionMaps::new(&board, Piece::J);
            for row in transition.rows.iter().take(event.accepted_row_index) {
                let attempted = PieceLocation {
                    rotation: transition.to,
                    x: event.from.x + row.native_offset.0,
                    y: event.from.y + row.native_offset.1,
                    ..event.from
                };
                assert!(collision.obstructed(attempted));
            }
            assert!(!collision.obstructed(event.to));
        }
    }

    fn direct_target(from: PieceLocation, offset: (i8, i8)) -> PieceLocation {
        PieceLocation {
            rotation: from.rotation.flip(),
            x: from.x + offset.0,
            y: from.y + offset.1,
            ..from
        }
    }

    fn collision_map_blocking(targets: impl IntoIterator<Item = PieceLocation>) -> CollisionMaps {
        let mut collision_map = CollisionMaps {
            boards: [[0; 10]; 4], ceiling: 20,
        };
        for target in targets {
            assert!((0..10).contains(&target.x));
            assert!((0..20).contains(&target.y));
            collision_map.boards[target.rotation as usize][target.x as usize] |=
                1_u64 << target.y as u32;
        }
        collision_map
    }

    fn board_with_cells(cells: &[(i8, i8)]) -> Board {
        let mut board = Board::default();
        for &(x, y) in cells {
            assert!((0..10).contains(&x));
            assert!((0..40).contains(&y));
            board.cols[x as usize] |= 1_u64 << y as u32;
        }
        board
    }

    fn sorted_cells(location: PieceLocation) -> [(i8, i8); 4] {
        let mut cells = location.cells();
        cells.sort_unstable();
        cells
    }

    fn translated_t_corners(target: PieceLocation) -> ([(i8, i8); 2], [(i8, i8); 2]) {
        let front = [(-1, 1), (1, 1)].map(|corner| {
            let (x, y) = target.rotation.rotate_cell(corner);
            (target.x + x, target.y + y)
        });
        let all = [(-1, -1), (1, -1), (-1, 1), (1, 1)].map(|(x, y)| (target.x + x, target.y + y));
        let back: Vec<_> = all
            .into_iter()
            .filter(|corner| !front.contains(corner))
            .collect();
        (front, [back[0], back[1]])
    }

    fn spin_for_single_t_attempt(
        from: PieceLocation,
        offset: (i8, i8),
        fin_or_tst_override: bool,
        occupied_corners: &[(i8, i8)],
    ) -> Spin {
        let board = board_with_cells(occupied_corners);
        let collision_map = CollisionMaps::new(&board, Piece::T);
        let unkicked = PieceLocation {
            rotation: from.rotation.flip(),
            ..from
        };
        rotate(
            unkicked,
            &collision_map,
            &board,
            std::iter::once(RotationAttempt {
                offset,
                fin_or_tst_override,
            }),
        )
        .expect("corner fixtures must leave the T target unobstructed")
        .spin
    }

    #[test]
    fn disabled_root_api_preserves_the_ordinary_move_list() {
        let board = Board::default();
        assert_eq!(
            find_moves(&board, Piece::T, false),
            find_moves_complete(&board, Piece::T, false).moves
        );
    }

    #[test]
    fn generated_direct_rows_are_complete_bounded_and_never_fin_overrides() {
        for piece in [
            Piece::I,
            Piece::O,
            Piece::T,
            Piece::L,
            Piece::J,
            Piece::S,
            Piece::Z,
        ] {
            for rotation in [
                Rotation::North,
                Rotation::West,
                Rotation::South,
                Rotation::East,
            ] {
                let transition = direct_180_transition(piece, rotation);
                assert_eq!(transition.to, rotation.flip());
                assert!(transition.row_count as usize <= DIRECT_180_MAX_ROWS);
                assert!(transition.rows[0].initial);
                assert!(transition
                    .rows
                    .iter()
                    .take(transition.row_count as usize)
                    .all(|row| !row.fin_or_tst_override));
                assert!(transition
                    .rows
                    .iter()
                    .skip(transition.row_count as usize)
                    .all(|row| !row.initial && row.source_row.is_none()));
            }
        }
    }

    #[test]
    fn every_non_o_direct_kick_row_is_reached_when_all_prior_rows_are_obstructed() {
        let board = Board::default();
        for piece in NON_O_PIECES {
            for rotation in ROTATIONS {
                let from = PieceLocation {
                    piece,
                    rotation,
                    x: 4,
                    y: 8,
                };
                let transition = direct_180_transition(piece, rotation);

                // Row zero is the initial test.  Every later configured row must
                // be observable in source order once all earlier target poses fail.
                for row_index in 1..transition.row_count as usize {
                    let prior_targets = transition.rows[..row_index]
                        .iter()
                        .map(|row| direct_target(from, row.native_offset));
                    let collision_map = collision_map_blocking(prior_targets);
                    let result = rotate_180(from, &collision_map, &board)
                        .expect("the requested direct-180 row must remain reachable");
                    assert_eq!(
                        result.location,
                        direct_target(from, transition.rows[row_index].native_offset),
                        "wrong accepted row for {piece:?} {rotation:?} at row {row_index}"
                    );
                }
            }
        }
    }

    #[test]
    fn direct_rotation_fails_when_every_configured_row_is_obstructed() {
        let board = Board::default();
        for piece in [
            Piece::I,
            Piece::O,
            Piece::T,
            Piece::L,
            Piece::J,
            Piece::S,
            Piece::Z,
        ] {
            for rotation in ROTATIONS {
                let from = PieceLocation {
                    piece,
                    rotation,
                    x: 4,
                    y: 8,
                };
                let transition = direct_180_transition(piece, rotation);
                let targets = transition.rows[..transition.row_count as usize]
                    .iter()
                    .map(|row| direct_target(from, row.native_offset));
                let collision_map = collision_map_blocking(targets);
                assert_eq!(
                    rotate_180(from, &collision_map, &board),
                    None,
                    "all blocked direct-180 rows must fail for {piece:?} {rotation:?}"
                );
            }
        }
    }

    #[test]
    fn direct_rows_respect_real_wall_and_floor_collisions_in_source_order() {
        let board = Board::default();
        let mut wall_kick_rescues = 0;
        let mut floor_kick_rescues = 0;
        for piece in [
            Piece::I,
            Piece::O,
            Piece::T,
            Piece::L,
            Piece::J,
            Piece::S,
            Piece::Z,
        ] {
            let collision_map = CollisionMaps::new(&board, piece);
            for rotation in ROTATIONS {
                let transition = direct_180_transition(piece, rotation);
                for (x, y, boundary) in [
                    (0, 8, "wall"),
                    (1, 8, "wall"),
                    (8, 8, "wall"),
                    (9, 8, "wall"),
                    (4, 0, "floor"),
                    (4, 1, "floor"),
                    (4, 2, "floor"),
                ] {
                    let from = PieceLocation {
                        piece,
                        rotation,
                        x,
                        y,
                    };
                    if collision_map.obstructed(from) {
                        continue;
                    }
                    let expected = transition.rows[..transition.row_count as usize]
                        .iter()
                        .enumerate()
                        .find_map(|(row_index, row)| {
                            let target = direct_target(from, row.native_offset);
                            (!collision_map.obstructed(target)).then_some((row_index, target))
                        });
                    let actual = rotate_180(from, &collision_map, &board);
                    assert_eq!(
                        actual.map(|placement| placement.location),
                        expected.map(|(_, target)| target),
                        "boundary row mismatch for {piece:?} {rotation:?} at ({x},{y})"
                    );
                    if let Some((row_index, _)) = expected {
                        if row_index > 0 && boundary == "wall" {
                            wall_kick_rescues += 1;
                        }
                        if row_index > 0 && boundary == "floor" {
                            floor_kick_rescues += 1;
                        }
                    }
                }
            }
        }
        assert!(
            wall_kick_rescues > 0,
            "fixture matrix must exercise a wall kick"
        );
        assert!(
            floor_kick_rescues > 0,
            "fixture matrix must exercise a floor kick"
        );
    }

    #[test]
    fn every_legal_o_direct_rotation_uses_the_cell_preserving_initial_row() {
        let board = Board::default();
        let collision_map = CollisionMaps::new(&board, Piece::O);
        for rotation in ROTATIONS {
            let from = PieceLocation {
                piece: Piece::O,
                rotation,
                x: 4,
                y: 8,
            };
            let transition = direct_180_transition(Piece::O, rotation);
            let configured_rows = &transition.rows[..transition.row_count as usize];

            // The open-board fixture makes every configured target legal.  The
            // returned pose must nevertheless be row zero, proving that the
            // cell-preserving initial test shadows every later generic O row.
            assert!(configured_rows
                .iter()
                .all(|row| { !collision_map.obstructed(direct_target(from, row.native_offset)) }));
            let expected = direct_target(from, configured_rows[0].native_offset);
            let result = rotate_180(from, &collision_map, &board).unwrap();
            assert_eq!(
                result.location, expected,
                "O {rotation:?} must accept its initial direct-180 row first"
            );
            assert_eq!(sorted_cells(result.location), sorted_cells(from));
            assert_eq!(result.location.canonical_form(), from.canonical_form());
            assert!(configured_rows[1..]
                .iter()
                .map(|row| direct_target(from, row.native_offset))
                .all(|later| sorted_cells(later) != sorted_cells(from)));
        }
    }

    #[test]
    fn stuck_direct_o_spin_survives_frontier_canonicalization_only_when_enabled() {
        // The O drops from North (4,19) into North (4,18).  Its direct-180
        // initial row is the same physical cells at South (5,19).  The board
        // blocks down/left/right and the native y=20 boundary blocks up, so
        // that rotation earns Mini without making the spawn or drop illegal.
        let board = board_with_cells(&[(4, 17), (5, 17), (3, 18), (6, 18)]);
        let from = PieceLocation {
            piece: Piece::O,
            rotation: Rotation::North,
            x: 4,
            y: 18,
        };
        let initial_row = direct_180_transition(Piece::O, from.rotation).rows[0];
        let direct_target = direct_target(from, initial_row.native_offset);
        let collision_map = CollisionMaps::new(&board, Piece::O);
        let direct = rotate_180(from, &collision_map, &board).unwrap();
        assert_eq!(direct.location, direct_target);
        assert_eq!(sorted_cells(direct.location), sorted_cells(from));
        assert_eq!(direct.spin, Spin::Mini);

        let canonical_location = from.canonical_form();
        assert_eq!(direct.location.canonical_form(), canonical_location);
        let ordinary_lock = Placement {
            location: canonical_location,
            spin: Spin::None,
        };
        let direct_spin_lock = Placement {
            location: canonical_location,
            spin: Spin::Mini,
        };

        let disabled = find_moves_complete(&board, Piece::O, false);
        let enabled = find_moves_complete(&board, Piece::O, true);
        assert!(disabled.queue_exhausted && enabled.queue_exhausted);
        assert!(disabled
            .moves
            .iter()
            .any(|&(placement, _)| placement == ordinary_lock));
        assert!(enabled
            .moves
            .iter()
            .any(|&(placement, _)| placement == ordinary_lock));
        assert!(!disabled
            .moves
            .iter()
            .any(|&(placement, _)| placement == direct_spin_lock));
        assert_eq!(
            enabled
                .moves
                .iter()
                .filter(|&&(placement, _)| placement == direct_spin_lock)
                .count(),
            1,
            "the spin-distinct canonical O lock must survive exactly once"
        );
    }

    #[test]
    fn every_direct_t_row_preserves_the_none_mini_full_corner_boundary() {
        for rotation in ROTATIONS {
            let from = PieceLocation {
                piece: Piece::T,
                rotation,
                x: 4,
                y: 8,
            };
            let transition = direct_180_transition(Piece::T, rotation);
            for (row_index, row) in transition.rows[..transition.row_count as usize]
                .iter()
                .enumerate()
            {
                let target = direct_target(from, row.native_offset);
                let (front, back) = translated_t_corners(target);

                assert_eq!(
                    spin_for_single_t_attempt(
                        from,
                        row.native_offset,
                        row.fin_or_tst_override,
                        &[front[0], back[0]],
                    ),
                    Spin::None,
                    "two corners must not spin for {rotation:?} row {row_index}"
                );
                assert_eq!(
                    spin_for_single_t_attempt(
                        from,
                        row.native_offset,
                        row.fin_or_tst_override,
                        &[front[0], back[0], back[1]],
                    ),
                    Spin::Mini,
                    "a direct row must not upgrade three corners with one front for {rotation:?} row {row_index}"
                );
                assert_eq!(
                    spin_for_single_t_attempt(
                        from,
                        row.native_offset,
                        row.fin_or_tst_override,
                        &[front[0], front[1], back[0]],
                    ),
                    Spin::Full,
                    "two front corners must remain full for {rotation:?} row {row_index}"
                );
            }
        }
    }

    #[test]
    fn legacy_native_90_full_override_matches_every_preexisting_row_index() {
        for from in ROTATIONS {
            for to in [from.cw(), from.ccw()] {
                for (row_index, offset) in kicks(Piece::T, from, to).into_iter().enumerate() {
                    let expected = row_index == 4;
                    assert_eq!(
                        legacy_native_90_full_override(row_index),
                        expected,
                        "legacy native 90-degree metadata mismatch for {from:?}->{to:?} row {row_index} offset {offset:?}"
                    );
                }
            }
        }
    }
}
