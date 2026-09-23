use super::prefix::CanonicalPlacement;
use super::CompatError;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const ROTATION_NAMES: [&str; 4] = ["spawn", "right", "reverse", "left"];
const ROTATION_INDEX: [(&str, i32); 4] = [
    ("spawn", 0),
    ("right", 1),
    ("reverse", 2),
    ("left", 3),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KickTables {
    pub kicks: HashMap<String, Vec<(i32, i32)>>,
    pub i_kicks: HashMap<String, Vec<(i32, i32)>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReachPieceState {
    pub current: Option<String>,
    pub hold: Option<String>,
    pub known: Vec<String>,
    pub hold_available: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReachPlacement {
    pub placement: CanonicalPlacement,
    pub last_rotation: bool,
    pub kick_index: Option<i32>,
    pub kick_id: Option<String>,
    pub kick_offset: Option<(i32, i32)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockOutcome {
    pub spin: &'static str,
    pub lines: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TsdResult {
    pub t_available: bool,
    pub scanned: u32,
    pub witnessed: bool,
}

pub fn t_available(pieces: &ReachPieceState) -> bool {
    pieces.current.as_deref() == Some("T")
        || (pieces.hold_available && pieces.hold.as_deref() == Some("T"))
}

pub fn witness_a_next_tsd(available: bool, locks: &[LockOutcome]) -> TsdResult {
    if !available {
        return TsdResult {
            t_available: false,
            scanned: 0,
            witnessed: false,
        };
    }
    let mut scanned = 0u32;
    for outcome in locks.iter().take(64) {
        scanned += 1;
        if outcome.spin == "normal" && outcome.lines == 2 {
            return TsdResult {
                t_available: true,
                scanned,
                witnessed: true,
            };
        }
    }
    TsdResult {
        t_available: true,
        scanned,
        witnessed: false,
    }
}

pub fn witness_b_next_tsd(available: bool, pieces_and_locks: &[(&str, LockOutcome)]) -> bool {
    if !available {
        return false;
    }
    let mut scanned = 0u32;
    for (piece, outcome) in pieces_and_locks {
        if *piece != "T" || {
            scanned += 1;
            scanned > 64
        } {
            continue;
        }
        if outcome.spin == "normal" && outcome.lines == 2 {
            return true;
        }
    }
    false
}

pub fn kick_tables_from_json(value: &Value) -> KickTables {
    KickTables {
        kicks: kick_map(&value["kicks"]),
        i_kicks: kick_map(&value["i_kicks"]),
    }
}

fn kick_map(value: &Value) -> HashMap<String, Vec<(i32, i32)>> {
    let mut out = HashMap::new();
    if let Some(object) = value.as_object() {
        for (key, tests) in object {
            let offsets = tests
                .as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .filter_map(|pair| {
                    let items = pair.as_array()?;
                    Some((items[0].as_i64()? as i32, items[1].as_i64()? as i32))
                })
                .collect();
            out.insert(key.clone(), offsets);
        }
    }
    out
}

pub fn tetromino_cells_from_json(value: &Value) -> HashMap<(String, String), Vec<(i32, i32)>> {
    let mut out = HashMap::new();
    if let Some(pieces) = value.as_object() {
        for (piece, rotations) in pieces {
            if let Some(rotations) = rotations.as_object() {
                for (rotation, cells) in rotations {
                    let blocks = cells
                        .as_array()
                        .unwrap_or(&Vec::new())
                        .iter()
                        .filter_map(|pair| {
                            let items = pair.as_array()?;
                            Some((items[0].as_i64()? as i32, items[1].as_i64()? as i32))
                        })
                        .collect();
                    out.insert((piece.clone(), rotation.clone()), blocks);
                }
            }
        }
    }
    out
}

fn rotation_index(rotation: &str) -> i32 {
    ROTATION_INDEX
        .iter()
        .find(|(name, _)| *name == rotation)
        .map(|(_, index)| *index)
        .unwrap_or(-1)
}

pub fn is_fin_or_tst(kick_id: Option<&str>, offset: Option<(i32, i32)>) -> bool {
    let Some((x, y)) = offset else {
        return false;
    };
    matches!(kick_id, Some("23" | "03") if x == 1 && y == -2)
        || matches!(kick_id, Some("21" | "01") if x == -1 && y == -2)
}

fn occupied(cells: &str, width: i32, height: i32, x: i32, y: i32) -> bool {
    if x < 0 || y < 0 || x >= width || y >= height {
        return true;
    }
    cells.as_bytes()[(y * width + x) as usize] != b'_'
}

fn blocks_at(
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    piece: &str,
    rotation: &str,
    x: i32,
    y: i32,
) -> Vec<(i32, i32)> {
    cells_table
        .get(&(piece.to_string(), rotation.to_string()))
        .map(|blocks| blocks.iter().map(|(bx, by)| (bx + x, by + y)).collect())
        .unwrap_or_default()
}

fn legal_at(
    board_cells: &str,
    width: i32,
    height: i32,
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    piece: &str,
    rotation: &str,
    x: i32,
    y: i32,
) -> bool {
    let blocks = blocks_at(cells_table, piece, rotation, x, y);
    !blocks
        .iter()
        .any(|&(bx, by)| occupied(board_cells, width, height, bx, by))
}

fn highest_in_bounds_y(
    _width: i32,
    height: i32,
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    piece: &str,
    rotation: &str,
    x: i32,
) -> Option<i32> {
    let spans = blocks_at(cells_table, piece, rotation, x, 0);
    if spans.is_empty() {
        return None;
    }
    let high = spans.iter().map(|(_, y)| *y).max().unwrap();
    let low = spans.iter().map(|(_, y)| *y).min().unwrap();
    let top_y = height - 1 - high;
    if top_y + low < 0 {
        None
    } else {
        Some(top_y)
    }
}

fn kick_tests<'a>(tables: &'a KickTables, piece: &str, kick_id: &str) -> Option<&'a Vec<(i32, i32)>> {
    let custom = format!("{}_kicks", piece.to_ascii_lowercase());
    if custom == "i_kicks" {
        tables.i_kicks.get(kick_id).or_else(|| tables.kicks.get(kick_id))
    } else {
        tables.kicks.get(kick_id)
    }
}

fn rotate_with_kicks(
    board_cells: &str,
    width: i32,
    height: i32,
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    tables: &KickTables,
    current: &ReachPlacement,
    amount: i32,
) -> Option<ReachPlacement> {
    let from = rotation_index(&current.placement.rotation);
    let to = ((from + amount) % 4 + 4) % 4;
    let rotation = ROTATION_NAMES[to as usize].to_string();
    let direct = ReachPlacement {
        placement: CanonicalPlacement {
            rotation: rotation.clone(),
            ..current.placement.clone()
        },
        last_rotation: true,
        kick_index: Some(0),
        kick_id: Some("00".into()),
        kick_offset: Some((0, 0)),
    };
    if legal_at(
        board_cells,
        width,
        height,
        cells_table,
        &direct.placement.piece,
        &direct.placement.rotation,
        direct.placement.x,
        direct.placement.y,
    ) {
        return Some(direct);
    }
    let kick_id = format!("{from}{to}");
    let tests = kick_tests(tables, &current.placement.piece, &kick_id)?;
    for (index, (dx, dy)) in tests.iter().enumerate() {
        let kicked = ReachPlacement {
            placement: CanonicalPlacement {
                rotation: rotation.clone(),
                x: current.placement.x + dx,
                y: current.placement.y - dy,
                ..current.placement.clone()
            },
            last_rotation: true,
            kick_index: Some(index as i32),
            kick_id: Some(kick_id.clone()),
            kick_offset: Some((*dx, -dy)),
        };
        if legal_at(
            board_cells,
            width,
            height,
            cells_table,
            &kicked.placement.piece,
            &kicked.placement.rotation,
            kicked.placement.x,
            kicked.placement.y,
        ) {
            return Some(kicked);
        }
    }
    None
}

fn state_id(placement: &ReachPlacement) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        placement.placement.x,
        placement.placement.y,
        placement.placement.rotation,
        if placement.last_rotation { 1 } else { 0 },
        if is_fin_or_tst(placement.kick_id.as_deref(), placement.kick_offset) {
            1
        } else {
            0
        }
    )
}

fn hard_drop_placement(piece: &str, rotation: &str, x: i32, y: i32, used_hold: bool) -> ReachPlacement {
    ReachPlacement {
        placement: CanonicalPlacement {
            piece: piece.to_string(),
            rotation: rotation.to_string(),
            x,
            y,
            used_hold,
        },
        last_rotation: false,
        kick_index: None,
        kick_id: None,
        kick_offset: None,
    }
}

fn sources(pieces: &ReachPieceState) -> Vec<(bool, String)> {
    let mut out = Vec::new();
    if let Some(current) = &pieces.current {
        out.push((false, current.clone()));
    }
    if pieces.hold_available {
        if let Some(held) = pieces.hold.clone().or_else(|| pieces.known.first().cloned()) {
            out.push((true, held));
        }
    }
    out
}

fn bfs(
    board_cells: &str,
    width: i32,
    height: i32,
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    tables: &KickTables,
    piece: &str,
    used_hold: bool,
    seed_rotations: &[&str],
    allow_180: bool,
) -> Vec<ReachPlacement> {
    let mut queue = Vec::new();
    let mut seen = HashSet::new();
    for rotation in seed_rotations {
        for x in -4..width + 4 {
            let Some(top_y) = highest_in_bounds_y(width, height, cells_table, piece, rotation, x) else {
                continue;
            };
            if !legal_at(board_cells, width, height, cells_table, piece, rotation, x, top_y) {
                continue;
            }
            let seed = hard_drop_placement(piece, rotation, x, top_y, used_hold);
            let id = state_id(&seed);
            if seen.insert(id) {
                queue.push(seed);
            }
        }
    }
    let amounts: &[i32] = if allow_180 { &[1, -1, 2] } else { &[1, -1] };
    let mut yielded = Vec::new();
    let mut cursor = 0;
    while cursor < queue.len() {
        let current = queue[cursor].clone();
        cursor += 1;
        if !legal_at(
            board_cells,
            width,
            height,
            cells_table,
            &current.placement.piece,
            &current.placement.rotation,
            current.placement.x,
            current.placement.y - 1,
        ) {
            yielded.push(current.clone());
        }
        for dx in [-1, 1] {
            let moved = hard_drop_placement(
                &current.placement.piece,
                &current.placement.rotation,
                current.placement.x + dx,
                current.placement.y,
                current.placement.used_hold,
            );
            if legal_at(
                board_cells,
                width,
                height,
                cells_table,
                &moved.placement.piece,
                &moved.placement.rotation,
                moved.placement.x,
                moved.placement.y,
            ) {
                let id = state_id(&moved);
                if seen.insert(id) {
                    queue.push(moved);
                }
            }
        }
        let down = hard_drop_placement(
            &current.placement.piece,
            &current.placement.rotation,
            current.placement.x,
            current.placement.y - 1,
            current.placement.used_hold,
        );
        if legal_at(
            board_cells,
            width,
            height,
            cells_table,
            &down.placement.piece,
            &down.placement.rotation,
            down.placement.x,
            down.placement.y,
        ) {
            let id = state_id(&down);
            if seen.insert(id) {
                queue.push(down);
            }
        }
        for amount in amounts {
            if let Some(rotated) = rotate_with_kicks(
                board_cells,
                width,
                height,
                cells_table,
                tables,
                &current,
                *amount,
            ) {
                let id = state_id(&rotated);
                if seen.insert(id) {
                    queue.push(rotated);
                }
            }
        }
    }
    yielded
}

fn compare_a(left: &ReachPlacement, right: &ReachPlacement) -> std::cmp::Ordering {
    (left.placement.used_hold as i32)
        .cmp(&(right.placement.used_hold as i32))
        .then(left.placement.piece.cmp(&right.placement.piece))
        .then(rotation_index(&left.placement.rotation).cmp(&rotation_index(&right.placement.rotation)))
        .then(left.placement.x.cmp(&right.placement.x))
        .then(left.placement.y.cmp(&right.placement.y))
        .then(state_id(left).cmp(&state_id(right)))
}

pub fn generate_reachable_a(
    board_cells: &str,
    width: i32,
    height: i32,
    pieces: &ReachPieceState,
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    tables: &KickTables,
) -> Result<Vec<ReachPlacement>, CompatError> {
    if board_cells.len() != (width * height) as usize {
        return Err(CompatError::InvalidLockBoard);
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (used_hold, piece) in sources(pieces) {
        for placement in bfs(
            board_cells,
            width,
            height,
            cells_table,
            tables,
            &piece,
            used_hold,
            &ROTATION_NAMES,
            true,
        ) {
            if seen.insert(cell_placement_identity(cells_table, &placement)) {
                out.push(placement);
            }
        }
    }
    out.sort_by(compare_a);
    Ok(out)
}

pub fn generate_public_reachable(
    board_cells: &str,
    width: i32,
    height: i32,
    pieces: &ReachPieceState,
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    tables: &KickTables,
) -> Result<Vec<ReachPlacement>, CompatError> {
    if board_cells.len() != (width * height) as usize {
        return Err(CompatError::InvalidLockBoard);
    }
    let mut out = Vec::new();
    for (used_hold, piece) in sources(pieces) {
        let mut yielded = bfs(
            board_cells,
            width,
            height,
            cells_table,
            tables,
            &piece,
            used_hold,
            &ROTATION_NAMES,
            true,
        );
        out.append(&mut yielded);
    }
    Ok(out)
}

fn cell_placement_identity(
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    placement: &ReachPlacement,
) -> String {
    let mut cells: Vec<String> = blocks_at(
        cells_table,
        &placement.placement.piece,
        &placement.placement.rotation,
        placement.placement.x,
        placement.placement.y,
    )
    .into_iter()
    .map(|(x, y)| format!("{x},{y}"))
    .collect();
    cells.sort();
    format!(
        "{}:{}:{}:{}:{}",
        placement.placement.used_hold as i32,
        cells.join("|"),
        placement.placement.rotation,
        if placement.last_rotation { 1 } else { 0 },
        if is_fin_or_tst(placement.kick_id.as_deref(), placement.kick_offset) {
            1
        } else {
            0
        }
    )
}

pub fn placement_is_legal(
    board_cells: &str,
    width: i32,
    height: i32,
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    placement: &CanonicalPlacement,
) -> bool {
    legal_at(
        board_cells,
        width,
        height,
        cells_table,
        &placement.piece,
        &placement.rotation,
        placement.x,
        placement.y,
    )
}

pub fn compact_json(placement: &ReachPlacement) -> Value {
    serde_json::json!({
        "piece": placement.placement.piece,
        "rotation": placement.placement.rotation,
        "x": placement.placement.x,
        "y": placement.placement.y,
        "usedHold": placement.placement.used_hold,
        "rotationEvidence": {
            "lastInputWasRotation": placement.last_rotation,
            "kickIndex": placement.kick_index,
            "kickId": placement.kick_id,
            "kickOffset": placement.kick_offset.map(|(x, y)| vec![x, y]),
        }
    })
}
