use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

use serde::{Deserialize, Serialize};

use cold_clear_2_s2::data::{Board, Piece, Placement};
use cold_clear_2_s2::movegen::{find_moves_complete, CompleteRootMoves};

const DIAGNOSTIC_ID: &str = "cc2-depth-one-movegen-diagnostic/1";
const REQUEST_SCHEMA_V1: &str = "s2-analysis-engine/cc2-s2-direct-180-depth-one-native-request/1";
const REQUEST_SCHEMA_V2: &str =
    "s2-analysis-engine/cc2-s2-direct-180-canonical-child-native-request/2";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    schema: String,
    positions: Vec<PositionRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionRequest {
    id: String,
    board: Board,
    root_routes: Vec<RootRouteRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootRouteRequest {
    route: String,
    used_hold: bool,
    piece: Piece,
    next_pieces: Vec<NextPieceRequest>,
    #[serde(default)]
    child_cases: Vec<ChildCaseRequest>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildCaseRequest {
    parent_move: RawMove,
    child_board: Board,
    child_piece: Piece,
    child_route_labels: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NextPieceRequest {
    labels: Vec<String>,
    piece: Piece,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    diagnostic: &'static str,
    request_schema: String,
    direct_180_arms: [bool; 2],
    positions: Vec<PositionResponse>,
    accounting: Accounting,
    queue_exhausted: bool,
    truncated: bool,
    selection_applied: bool,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Accounting {
    positions: usize,
    root_routes: usize,
    distinct_root_moves: usize,
    effective_child_piece_routes: usize,
    root_raw_order_differences: usize,
    child_raw_order_differences: usize,
    root_enabled_only_pose_spins: usize,
    root_cost_improvements: usize,
    child_enabled_only_pose_spins: usize,
    child_cost_improvements: usize,
    root_non_monotone: usize,
    child_non_monotone: usize,
    root_exact_only_changes: usize,
    child_exact_only_changes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionResponse {
    id: String,
    root_routes: Vec<RootRouteResponse>,
    distinct_root_moves: usize,
    effective_child_piece_routes: usize,
    child_differences: Vec<ChildDifference>,
    consumed_child_cases: Vec<ConsumedChildCase>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootRouteResponse {
    route: String,
    used_hold: bool,
    piece: Piece,
    comparison: Comparison,
    distinct_root_moves: usize,
    effective_child_piece_routes: usize,
    control_moves: Vec<RawMove>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChildDifference {
    parent_route: String,
    parent_used_hold: bool,
    parent_piece: Piece,
    parent_move: RawMove,
    child_board_cols: [u64; 10],
    child_piece: Piece,
    child_route_labels: Vec<String>,
    comparison: Comparison,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsumedChildCase {
    parent_route: String,
    parent_used_hold: bool,
    parent_piece: Piece,
    parent_move: RawMove,
    child_board_cols: [u64; 10],
    child_piece: Piece,
    child_route_labels: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawMove {
    placement: Placement,
    soft_drops: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PoseMinimum {
    placement: Placement,
    minimum_soft_drops: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CostChange {
    placement: Placement,
    control_minimum_soft_drops: u32,
    candidate_minimum_soft_drops: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    control_exact_count: usize,
    candidate_exact_count: usize,
    control_pose_spin_count: usize,
    candidate_pose_spin_count: usize,
    raw_order_equal: bool,
    enabled_only_exact: Vec<RawMove>,
    disabled_only_exact: Vec<RawMove>,
    enabled_only_pose_spin: Vec<PoseMinimum>,
    lost_disabled_pose_spin: Vec<PoseMinimum>,
    cost_improvements: Vec<CostChange>,
    cost_regressions: Vec<CostChange>,
    exact_only_change: bool,
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let request: Request = serde_json::from_str(&input).unwrap();
    assert!(
        request.schema == REQUEST_SCHEMA_V1 || request.schema == REQUEST_SCHEMA_V2,
        "unexpected request schema"
    );
    let request_schema = request.schema.clone();
    let canonical_children = request.schema == REQUEST_SCHEMA_V2;
    assert!(!request.positions.is_empty(), "positions must not be empty");

    let mut accounting = Accounting::default();
    let mut positions = Vec::with_capacity(request.positions.len());
    for position in request.positions {
        positions.push(measure_position(
            position,
            canonical_children,
            &mut accounting,
        ));
    }
    accounting.positions = positions.len();

    serde_json::to_writer(
        std::io::stdout(),
        &Response {
            diagnostic: DIAGNOSTIC_ID,
            request_schema,
            direct_180_arms: [false, true],
            positions,
            accounting,
            queue_exhausted: true,
            truncated: false,
            selection_applied: false,
        },
    )
    .unwrap();
    println!();
}

fn measure_position(
    request: PositionRequest,
    canonical_children: bool,
    accounting: &mut Accounting,
) -> PositionResponse {
    assert!(!request.id.is_empty(), "position id must not be empty");
    assert!(
        !request.root_routes.is_empty(),
        "root routes must not be empty"
    );
    let mut root_routes = Vec::with_capacity(request.root_routes.len());
    let mut child_differences = Vec::new();
    let mut consumed_child_cases = Vec::new();
    let mut position_root_moves = 0;
    let mut position_child_routes = 0;

    for route in request.root_routes {
        assert!(!route.route.is_empty(), "root route must not be empty");
        assert!(
            !route.next_pieces.is_empty(),
            "next pieces must not be empty"
        );
        let mut seen_pieces = BTreeSet::new();
        for child in &route.next_pieces {
            assert!(
                !child.labels.is_empty(),
                "child route labels must not be empty"
            );
            assert!(
                seen_pieces.insert(child.piece as u8),
                "duplicate child piece"
            );
        }

        let control = find_moves_complete(&request.board, route.piece, false);
        let candidate = find_moves_complete(&request.board, route.piece, true);
        assert!(control.queue_exhausted && candidate.queue_exhausted);
        let root_comparison = compare(&control, &candidate);
        account_comparison(&root_comparison, true, accounting);

        let distinct_root_moves = control.moves.len();
        let effective_child_piece_routes = if canonical_children {
            route.child_cases.len()
        } else {
            distinct_root_moves * route.next_pieces.len()
        };
        position_root_moves += distinct_root_moves;
        position_child_routes += effective_child_piece_routes;
        accounting.root_routes += 1;
        accounting.distinct_root_moves += distinct_root_moves;
        accounting.effective_child_piece_routes += effective_child_piece_routes;

        if canonical_children {
            let control_exact = exact_map(&control.moves);
            let mut seen_cases = BTreeSet::new();
            for child in &route.child_cases {
                assert!(
                    control_exact.contains_key(&exact_key_from_raw(&child.parent_move)),
                    "canonical child parent is outside the complete control root"
                );
                assert!(
                    !child.child_route_labels.is_empty(),
                    "child route labels must not be empty"
                );
                let case_key = (
                    exact_key_from_raw(&child.parent_move),
                    child.child_piece as u8,
                    child.child_route_labels.clone(),
                );
                assert!(
                    seen_cases.insert(case_key),
                    "duplicate canonical child case"
                );
                let child_control =
                    find_moves_complete(&child.child_board, child.child_piece, false);
                let child_candidate =
                    find_moves_complete(&child.child_board, child.child_piece, true);
                assert!(child_control.queue_exhausted && child_candidate.queue_exhausted);
                let comparison = compare(&child_control, &child_candidate);
                account_comparison(&comparison, false, accounting);
                consumed_child_cases.push(ConsumedChildCase {
                    parent_route: route.route.clone(),
                    parent_used_hold: route.used_hold,
                    parent_piece: route.piece,
                    parent_move: child.parent_move.clone(),
                    child_board_cols: child.child_board.cols,
                    child_piece: child.child_piece,
                    child_route_labels: child.child_route_labels.clone(),
                });
                if has_difference(&comparison) {
                    child_differences.push(ChildDifference {
                        parent_route: route.route.clone(),
                        parent_used_hold: route.used_hold,
                        parent_piece: route.piece,
                        parent_move: child.parent_move.clone(),
                        child_board_cols: child.child_board.cols,
                        child_piece: child.child_piece,
                        child_route_labels: child.child_route_labels.clone(),
                        comparison,
                    });
                }
            }
        } else {
            for &(placement, soft_drops) in &control.moves {
                let mut child_board = request.board;
                child_board.place(placement.location);
                let cleared = child_board.line_clears();
                if cleared != 0 {
                    child_board.remove_lines(cleared);
                }
                for child in &route.next_pieces {
                    let child_control = find_moves_complete(&child_board, child.piece, false);
                    let child_candidate = find_moves_complete(&child_board, child.piece, true);
                    assert!(child_control.queue_exhausted && child_candidate.queue_exhausted);
                    let comparison = compare(&child_control, &child_candidate);
                    account_comparison(&comparison, false, accounting);
                    if has_difference(&comparison) {
                        child_differences.push(ChildDifference {
                            parent_route: route.route.clone(),
                            parent_used_hold: route.used_hold,
                            parent_piece: route.piece,
                            parent_move: RawMove {
                                placement,
                                soft_drops,
                            },
                            child_board_cols: child_board.cols,
                            child_piece: child.piece,
                            child_route_labels: child.labels.clone(),
                            comparison,
                        });
                    }
                }
            }
        }

        root_routes.push(RootRouteResponse {
            route: route.route,
            used_hold: route.used_hold,
            piece: route.piece,
            comparison: root_comparison,
            distinct_root_moves,
            effective_child_piece_routes,
            control_moves: control
                .moves
                .iter()
                .map(|&(placement, soft_drops)| RawMove {
                    placement,
                    soft_drops,
                })
                .collect(),
        });
    }

    PositionResponse {
        id: request.id,
        root_routes,
        distinct_root_moves: position_root_moves,
        effective_child_piece_routes: position_child_routes,
        child_differences,
        consumed_child_cases,
    }
}

fn compare(control: &CompleteRootMoves, candidate: &CompleteRootMoves) -> Comparison {
    let control_exact = exact_map(&control.moves);
    let candidate_exact = exact_map(&candidate.moves);
    let control_minimum = minimum_map(&control.moves);
    let candidate_minimum = minimum_map(&candidate.moves);

    let enabled_only_exact = candidate_exact
        .iter()
        .filter(|(key, _)| !control_exact.contains_key(key))
        .map(|(_, value)| value.clone())
        .collect::<Vec<_>>();
    let disabled_only_exact = control_exact
        .iter()
        .filter(|(key, _)| !candidate_exact.contains_key(key))
        .map(|(_, value)| value.clone())
        .collect::<Vec<_>>();
    let enabled_only_pose_spin = candidate_minimum
        .iter()
        .filter(|(key, _)| !control_minimum.contains_key(key))
        .map(|(_, value)| value.clone())
        .collect::<Vec<_>>();
    let lost_disabled_pose_spin = control_minimum
        .iter()
        .filter(|(key, _)| !candidate_minimum.contains_key(key))
        .map(|(_, value)| value.clone())
        .collect::<Vec<_>>();
    let mut cost_improvements = Vec::new();
    let mut cost_regressions = Vec::new();
    for (key, control_pose) in &control_minimum {
        if let Some(candidate_pose) = candidate_minimum.get(key) {
            let change = CostChange {
                placement: control_pose.placement,
                control_minimum_soft_drops: control_pose.minimum_soft_drops,
                candidate_minimum_soft_drops: candidate_pose.minimum_soft_drops,
            };
            if candidate_pose.minimum_soft_drops < control_pose.minimum_soft_drops {
                cost_improvements.push(change);
            } else if candidate_pose.minimum_soft_drops > control_pose.minimum_soft_drops {
                cost_regressions.push(change);
            }
        }
    }
    let pose_or_cost_change = !enabled_only_pose_spin.is_empty()
        || !lost_disabled_pose_spin.is_empty()
        || !cost_improvements.is_empty()
        || !cost_regressions.is_empty();
    let exact_changed = !enabled_only_exact.is_empty() || !disabled_only_exact.is_empty();

    Comparison {
        control_exact_count: control_exact.len(),
        candidate_exact_count: candidate_exact.len(),
        control_pose_spin_count: control_minimum.len(),
        candidate_pose_spin_count: candidate_minimum.len(),
        raw_order_equal: control.moves == candidate.moves,
        enabled_only_exact,
        disabled_only_exact,
        enabled_only_pose_spin,
        lost_disabled_pose_spin,
        cost_improvements,
        cost_regressions,
        exact_only_change: exact_changed && !pose_or_cost_change,
    }
}

fn has_difference(comparison: &Comparison) -> bool {
    !comparison.raw_order_equal
        || !comparison.enabled_only_exact.is_empty()
        || !comparison.disabled_only_exact.is_empty()
        || !comparison.enabled_only_pose_spin.is_empty()
        || !comparison.lost_disabled_pose_spin.is_empty()
        || !comparison.cost_improvements.is_empty()
        || !comparison.cost_regressions.is_empty()
}

fn account_comparison(comparison: &Comparison, root: bool, accounting: &mut Accounting) {
    let raw_order = (!comparison.raw_order_equal) as usize;
    let additions = comparison.enabled_only_pose_spin.len();
    let improvements = comparison.cost_improvements.len();
    let non_monotone = comparison.lost_disabled_pose_spin.len() + comparison.cost_regressions.len();
    let exact_only = comparison.exact_only_change as usize;
    if root {
        accounting.root_raw_order_differences += raw_order;
        accounting.root_enabled_only_pose_spins += additions;
        accounting.root_cost_improvements += improvements;
        accounting.root_non_monotone += non_monotone;
        accounting.root_exact_only_changes += exact_only;
    } else {
        accounting.child_raw_order_differences += raw_order;
        accounting.child_enabled_only_pose_spins += additions;
        accounting.child_cost_improvements += improvements;
        accounting.child_non_monotone += non_monotone;
        accounting.child_exact_only_changes += exact_only;
    }
}

type PoseKey = (u8, u8, i8, i8, u8);
type ExactKey = (u8, u8, i8, i8, u8, u32);

fn pose_key(placement: Placement) -> PoseKey {
    (
        placement.location.piece as u8,
        placement.location.rotation as u8,
        placement.location.x,
        placement.location.y,
        placement.spin as u8,
    )
}

fn exact_map(moves: &[(Placement, u32)]) -> BTreeMap<ExactKey, RawMove> {
    let mut result = BTreeMap::new();
    for &(placement, soft_drops) in moves {
        let key = {
            let pose = pose_key(placement);
            (pose.0, pose.1, pose.2, pose.3, pose.4, soft_drops)
        };
        assert!(
            result
                .insert(
                    key,
                    RawMove {
                        placement,
                        soft_drops
                    }
                )
                .is_none(),
            "duplicate exact move"
        );
    }
    result
}

fn exact_key_from_raw(value: &RawMove) -> ExactKey {
    let pose = pose_key(value.placement);
    (pose.0, pose.1, pose.2, pose.3, pose.4, value.soft_drops)
}

fn minimum_map(moves: &[(Placement, u32)]) -> BTreeMap<PoseKey, PoseMinimum> {
    let mut result = BTreeMap::new();
    for &(placement, soft_drops) in moves {
        result
            .entry(pose_key(placement))
            .and_modify(|value: &mut PoseMinimum| {
                value.minimum_soft_drops = value.minimum_soft_drops.min(soft_drops)
            })
            .or_insert(PoseMinimum {
                placement,
                minimum_soft_drops: soft_drops,
            });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{
        compare, has_difference, measure_position, Accounting, ChildCaseRequest, NextPieceRequest,
        PositionRequest, RawMove, RootRouteRequest,
    };
    use cold_clear_2_s2::data::{Board, Piece, PieceLocation, Placement, Rotation, Spin};
    use cold_clear_2_s2::movegen::{find_moves_complete, CompleteRootMoves};

    fn placement(x: i8) -> Placement {
        Placement {
            location: PieceLocation {
                piece: Piece::T,
                rotation: Rotation::North,
                x,
                y: 0,
            },
            spin: Spin::None,
        }
    }

    #[test]
    fn separates_exact_only_cost_paths_from_activation() {
        let control = CompleteRootMoves {
            moves: vec![(placement(0), 0)],
            queue_exhausted: true,
        };
        let candidate = CompleteRootMoves {
            moves: vec![(placement(0), 0), (placement(0), 1)],
            queue_exhausted: true,
        };
        let comparison = compare(&control, &candidate);
        assert!(comparison.exact_only_change);
        assert!(has_difference(&comparison));
        assert!(comparison.enabled_only_pose_spin.is_empty());
        assert!(comparison.cost_improvements.is_empty());
    }

    #[test]
    fn reports_pose_additions_and_non_monotone_loss() {
        let control = CompleteRootMoves {
            moves: vec![(placement(0), 0)],
            queue_exhausted: true,
        };
        let added = CompleteRootMoves {
            moves: vec![(placement(0), 0), (placement(1), 0)],
            queue_exhausted: true,
        };
        assert_eq!(compare(&control, &added).enabled_only_pose_spin.len(), 1);
        assert_eq!(compare(&added, &control).lost_disabled_pose_spin.len(), 1);
    }

    fn canonical_request(cases: Vec<ChildCaseRequest>) -> PositionRequest {
        PositionRequest {
            id: "test".to_owned(),
            board: Board::default(),
            root_routes: vec![RootRouteRequest {
                route: "current".to_owned(),
                used_hold: false,
                piece: Piece::T,
                next_pieces: vec![NextPieceRequest {
                    labels: vec!["current".to_owned()],
                    piece: Piece::I,
                }],
                child_cases: cases,
            }],
        }
    }

    fn first_control_case() -> ChildCaseRequest {
        let (placement, soft_drops) = find_moves_complete(&Board::default(), Piece::T, false)
            .moves
            .into_iter()
            .next()
            .unwrap();
        let mut child_board = Board::default();
        child_board.place(placement.location);
        ChildCaseRequest {
            parent_move: RawMove {
                placement,
                soft_drops,
            },
            child_board,
            child_piece: Piece::I,
            child_route_labels: vec!["current".to_owned()],
        }
    }

    #[test]
    fn canonical_child_contract_echoes_every_consumed_case() {
        let request = canonical_request(vec![first_control_case()]);
        let response = measure_position(request, true, &mut Accounting::default());
        assert_eq!(response.effective_child_piece_routes, 1);
        assert_eq!(response.consumed_child_cases.len(), 1);
    }

    #[test]
    fn canonical_child_contract_rejects_foreign_and_duplicate_parents() {
        let valid = first_control_case();
        let mut foreign = first_control_case();
        foreign.parent_move.placement.location.x = 99;
        assert!(std::panic::catch_unwind(|| {
            measure_position(
                canonical_request(vec![foreign]),
                true,
                &mut Accounting::default(),
            )
        })
        .is_err());
        assert!(std::panic::catch_unwind(|| {
            measure_position(
                canonical_request(vec![valid.clone(), valid]),
                true,
                &mut Accounting::default(),
            )
        })
        .is_err());
    }
}
