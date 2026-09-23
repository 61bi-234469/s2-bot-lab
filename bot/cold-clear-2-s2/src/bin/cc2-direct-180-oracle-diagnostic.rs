use std::io::{Read, Write};

use serde::{Deserialize, Serialize};

use cold_clear_2_s2::data::{Board, Piece, Placement};
use cold_clear_2_s2::movegen::{
    find_direct_180_route_witness_complete, find_moves_complete, CompleteRootMoves,
    Direct180RouteSearch,
};

const REQUEST_SCHEMA: &str = "s2-analysis-engine/cc2-s2-f32-direct-180-oracle-native-request/1";
const DIAGNOSTIC_ID: &str = "cc2-direct-180-oracle-diagnostic/1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    schema: String,
    fixtures: Vec<FixtureRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureRequest {
    id: String,
    board: Board,
    piece: Piece,
    target: Placement,
    target_soft_drops: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawMove {
    placement: Placement,
    soft_drops: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Frontier {
    direct_180_enabled: bool,
    queue_exhausted: bool,
    raw_moves: Vec<RawMove>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetAccounting {
    placement: Placement,
    soft_drops: u32,
    control_occurrences: usize,
    candidate_occurrences: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureResponse {
    id: String,
    piece: Piece,
    control: Frontier,
    candidate: Frontier,
    target: TargetAccounting,
    route_search: Direct180RouteSearch,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    diagnostic: &'static str,
    request_schema: &'static str,
    direct_180_arms: [bool; 2],
    fixtures: Vec<FixtureResponse>,
    queue_exhausted: bool,
    truncated: bool,
    selection_applied: bool,
}

fn main() {
    if run().is_err() {
        std::process::exit(2);
    }
}

fn run() -> Result<(), ()> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|_| ())?;
    let request: Request = serde_json::from_str(&input).map_err(|_| ())?;
    if request.schema != REQUEST_SCHEMA || request.fixtures.is_empty() {
        return Err(());
    }

    let fixtures: Vec<_> = request.fixtures.into_iter().map(run_fixture).collect();
    let queue_exhausted = fixtures.iter().all(|fixture| {
        fixture.control.queue_exhausted
            && fixture.candidate.queue_exhausted
            && fixture.route_search.queue_exhausted
    });
    let mut stdout = std::io::stdout();
    serde_json::to_writer(
        &mut stdout,
        &Response {
            diagnostic: DIAGNOSTIC_ID,
            request_schema: REQUEST_SCHEMA,
            direct_180_arms: [false, true],
            fixtures,
            queue_exhausted,
            truncated: false,
            selection_applied: false,
        },
    )
    .map_err(|_| ())?;
    stdout.write_all(b"\n").map_err(|_| ())?;
    Ok(())
}

fn run_fixture(request: FixtureRequest) -> FixtureResponse {
    let control = find_moves_complete(&request.board, request.piece, false);
    let candidate = find_moves_complete(&request.board, request.piece, true);
    let control_occurrences =
        exact_occurrences(&control, request.target, request.target_soft_drops);
    let candidate_occurrences =
        exact_occurrences(&candidate, request.target, request.target_soft_drops);
    let route_search = find_direct_180_route_witness_complete(
        &request.board,
        request.piece,
        request.target,
        request.target_soft_drops,
    );
    FixtureResponse {
        id: request.id,
        piece: request.piece,
        control: frontier(false, control),
        candidate: frontier(true, candidate),
        target: TargetAccounting {
            placement: request.target,
            soft_drops: request.target_soft_drops,
            control_occurrences,
            candidate_occurrences,
        },
        route_search,
    }
}

fn frontier(direct_180_enabled: bool, complete: CompleteRootMoves) -> Frontier {
    Frontier {
        direct_180_enabled,
        queue_exhausted: complete.queue_exhausted,
        raw_moves: complete
            .moves
            .into_iter()
            .map(|(placement, soft_drops)| RawMove {
                placement,
                soft_drops,
            })
            .collect(),
    }
}

fn exact_occurrences(complete: &CompleteRootMoves, target: Placement, soft_drops: u32) -> usize {
    complete
        .moves
        .iter()
        .filter(|(placement, cost)| *placement == target && *cost == soft_drops)
        .count()
}

#[cfg(test)]
mod tests {
    use super::{exact_occurrences, REQUEST_SCHEMA};
    use cold_clear_2_s2::data::{Board, Piece, PieceLocation, Placement, Rotation, Spin};
    use cold_clear_2_s2::movegen::find_moves_complete;

    #[test]
    fn request_schema_is_frozen() {
        assert_eq!(
            REQUEST_SCHEMA,
            "s2-analysis-engine/cc2-s2-f32-direct-180-oracle-native-request/1"
        );
    }

    #[test]
    fn exact_target_accounting_includes_soft_drop_cost() {
        let board = Board::default();
        let moves = find_moves_complete(&board, Piece::J, false);
        let (placement, cost) = moves.moves[0];
        assert_eq!(exact_occurrences(&moves, placement, cost), 1);
        assert_eq!(exact_occurrences(&moves, placement, cost + 1), 0);
        assert_eq!(placement.location.piece, Piece::J);
        let absent = Placement {
            location: PieceLocation {
                piece: Piece::J,
                rotation: Rotation::North,
                x: 4,
                y: 19,
            },
            spin: Spin::Full,
        };
        assert_eq!(exact_occurrences(&moves, absent, 0), 0);
    }
}
