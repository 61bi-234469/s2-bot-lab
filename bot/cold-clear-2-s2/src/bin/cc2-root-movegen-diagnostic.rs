#[cfg(not(target_arch = "wasm32"))]
mod native {
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use structopt::StructOpt;

use cold_clear_2_s2::data::{Board, Piece, Placement};
use cold_clear_2_s2::movegen::find_moves_complete;
use cold_clear_2_s2::BotConfig;

const DIAGNOSTIC_ID: &str = "cc2-complete-root-movegen-diagnostic/1";

#[derive(StructOpt)]
struct CliOptions {
    /// Path to the process-lifetime native configuration.
    #[structopt(short, long)]
    config: Option<PathBuf>,
    /// Explicit offline S2 root-priority search; legacy movegen mode is unchanged.
    #[structopt(long)]
    s2_root_priority: bool,
    /// Opt-in S2 state, H/R and risk in the shared CC2 DAG (unqualified diagnostic).
    #[structopt(long)]
    s2_integrated_search: bool,
}

#[derive(Deserialize)]
struct Request {
    board: Board,
    piece: Piece,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawMove {
    placement: Placement,
    soft_drops: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExactMoveCount {
    placement: Placement,
    soft_drops: u32,
    occurrences: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PoseSpinMinimum {
    placement: Placement,
    minimum_soft_drops: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    diagnostic: &'static str,
    direct_180_enabled: bool,
    queue_exhausted: bool,
    truncated: bool,
    selection_applied: bool,
    raw_moves: Vec<RawMove>,
    exact_multiset: Vec<ExactMoveCount>,
    duplicate_exact_tuples: Vec<ExactMoveCount>,
    minimum_soft_drop_by_pose_spin: Vec<PoseSpinMinimum>,
}

pub fn run() {
    let options = CliOptions::from_args();
    if options.s2_root_priority || options.s2_integrated_search {
        if options.config.is_some() || (options.s2_root_priority && options.s2_integrated_search) { eprintln!("diagnostic mode/configuration conflict"); std::process::exit(2); }
        let mut input = String::new();
        std::io::stdin().take(64 * 1024 + 1).read_to_string(&mut input).unwrap();
        let parsed = if input.len() > 64 * 1024 { Err("diagnostic input too large".to_string()) }
            else { serde_json::from_str::<serde_json::Value>(&input).map_err(|e| e.to_string()) };
        let schema = parsed.as_ref().ok()
            .and_then(|value| value.get("schema"))
            .and_then(|schema| schema.as_str())
            .map(str::to_string);
        let result = parsed.and_then(|value| {
            if options.s2_integrated_search { return cold_clear_2_s2::s2_search::diagnose(value); }
            match schema.as_deref() {
                Some("s2-conversion-core-shadow/1") => cold_clear_2_s2::diagnose_s2_conversion_shadow(value),
                Some("s2-f14-root-allocation-diagnostic/1") => cold_clear_2_s2::diagnose_s2_root_allocation(value),
                _ => cold_clear_2_s2::diagnose_s2_root_priority(value),
            }
        });
        match result {
            Ok(response) => println!("{}", response),
            Err(error) => {
                let diagnostic = if options.s2_integrated_search { cold_clear_2_s2::s2_search::DIAGNOSTIC_ID }
                    else { schema.as_deref().unwrap_or("s2-root-priority-diagnostic/1") };
                println!("{}", serde_json::json!({"diagnostic":diagnostic, "status":"error", "reason":error}));
                std::process::exit(2);
            }
        }
        return;
    }
    let config = load_config(options.config);
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let request: Request = serde_json::from_str(&input).unwrap();

    // This intentionally bypasses Bot, Freestyle, DAG search, TBP, MoveInfo,
    // suggestion limits, and selectors. `find_moves_complete` only returns
    // after its root movement queue has been exhausted.
    let complete = find_moves_complete(&request.board, request.piece, config.enable_direct_180);
    let queue_exhausted = complete.queue_exhausted;
    let raw_moves: Vec<_> = complete
        .moves
        .into_iter()
        .map(|(placement, soft_drops)| RawMove {
            placement,
            soft_drops,
        })
        .collect();
    let exact_multiset = exact_multiset(&raw_moves);
    let duplicate_exact_tuples = exact_multiset
        .iter()
        .filter(|entry| entry.occurrences > 1)
        .cloned()
        .collect();

    serde_json::to_writer(
        std::io::stdout(),
        &Response {
            diagnostic: DIAGNOSTIC_ID,
            direct_180_enabled: config.enable_direct_180,
            queue_exhausted,
            truncated: false,
            selection_applied: false,
            minimum_soft_drop_by_pose_spin: pose_spin_minimum(&raw_moves),
            raw_moves,
            exact_multiset,
            duplicate_exact_tuples,
        },
    )
    .unwrap();
    println!();
}

fn load_config(path: Option<PathBuf>) -> BotConfig {
    path.map_or_else(BotConfig::default, |path| {
        serde_json::from_reader(BufReader::new(File::open(path).unwrap())).unwrap()
    })
}

fn exact_multiset(raw_moves: &[RawMove]) -> Vec<ExactMoveCount> {
    let mut sorted = raw_moves.to_vec();
    sorted.sort_unstable_by_key(exact_key);
    let mut counts: Vec<ExactMoveCount> = Vec::new();
    for entry in sorted {
        if let Some(previous) = counts.last_mut() {
            if exact_key_from_count(previous) == exact_key(&entry) {
                previous.occurrences += 1;
                continue;
            }
        }
        counts.push(ExactMoveCount {
            placement: entry.placement,
            soft_drops: entry.soft_drops,
            occurrences: 1,
        });
    }
    counts
}

fn pose_spin_minimum(raw_moves: &[RawMove]) -> Vec<PoseSpinMinimum> {
    let mut sorted = raw_moves.to_vec();
    sorted.sort_unstable_by_key(|entry| pose_spin_key(entry));
    let mut minimums: Vec<PoseSpinMinimum> = Vec::new();
    for entry in sorted {
        if let Some(previous) = minimums.last_mut() {
            if pose_spin_key_from_minimum(previous) == pose_spin_key(&entry) {
                previous.minimum_soft_drops = previous.minimum_soft_drops.min(entry.soft_drops);
                continue;
            }
        }
        minimums.push(PoseSpinMinimum {
            placement: entry.placement,
            minimum_soft_drops: entry.soft_drops,
        });
    }
    minimums
}

fn exact_key(entry: &RawMove) -> (u8, u8, i8, i8, u8, u32) {
    let location = entry.placement.location;
    (
        location.piece as u8,
        location.rotation as u8,
        location.x,
        location.y,
        entry.placement.spin as u8,
        entry.soft_drops,
    )
}

fn exact_key_from_count(entry: &ExactMoveCount) -> (u8, u8, i8, i8, u8, u32) {
    exact_key(&RawMove {
        placement: entry.placement,
        soft_drops: entry.soft_drops,
    })
}

fn pose_spin_key(entry: &RawMove) -> (u8, u8, i8, i8, u8) {
    let location = entry.placement.location;
    (
        location.piece as u8,
        location.rotation as u8,
        location.x,
        location.y,
        entry.placement.spin as u8,
    )
}

fn pose_spin_key_from_minimum(entry: &PoseSpinMinimum) -> (u8, u8, i8, i8, u8) {
    pose_spin_key(&RawMove {
        placement: entry.placement,
        soft_drops: entry.minimum_soft_drops,
    })
}

#[cfg(test)]
mod tests {
    use super::{exact_multiset, pose_spin_minimum, RawMove};
    use cold_clear_2_s2::data::{Piece, Placement};
    use cold_clear_2_s2::data::{PieceLocation, Rotation, Spin};

    fn move_at(soft_drops: u32) -> RawMove {
        RawMove {
            placement: Placement {
                location: PieceLocation {
                    piece: Piece::T,
                    rotation: Rotation::North,
                    x: 4,
                    y: 0,
                },
                spin: Spin::Mini,
            },
            soft_drops,
        }
    }

    #[test]
    fn reports_exact_duplicates_but_minimizes_cost_by_pose_and_spin() {
        let raw = vec![move_at(3), move_at(3), move_at(1)];
        let exact = exact_multiset(&raw);
        assert_eq!(exact.len(), 2);
        assert_eq!(exact[1].occurrences, 2);
        let minimum = pose_spin_minimum(&raw);
        assert_eq!(minimum.len(), 1);
        assert_eq!(minimum[0].minimum_soft_drops, 1);
    }
}

}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    native::run();
}

#[cfg(target_arch = "wasm32")]
fn main() {}
