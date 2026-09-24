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

/// Kick ids by (from, to) rotation index, as the kick tables key them.
const KICK_IDS: [[&str; 4]; 4] = [
    ["00", "01", "02", "03"],
    ["10", "11", "12", "13"],
    ["20", "21", "22", "23"],
    ["30", "31", "32", "33"],
];

/// A search state without strings. `kick` is `(kick_id, index, offset)` of the
/// rotation that produced it; `fin` caches `is_fin_or_tst` for the seen key.
#[derive(Clone, Copy)]
struct Node {
    rotation: usize,
    x: i32,
    y: i32,
    last_rotation: bool,
    kick: Option<(&'static str, i32, (i32, i32))>,
    fin: bool,
}

impl Node {
    fn plain(rotation: usize, x: i32, y: i32) -> Self {
        Node {
            rotation,
            x,
            y,
            last_rotation: false,
            kick: None,
            fin: false,
        }
    }

    fn rotated(rotation: usize, x: i32, y: i32, kick_id: &'static str, index: i32, offset: (i32, i32)) -> Self {
        Node {
            rotation,
            x,
            y,
            last_rotation: true,
            kick: Some((kick_id, index, offset)),
            fin: is_fin_or_tst(Some(kick_id), Some(offset)),
        }
    }

    fn placement(&self, piece: &str, used_hold: bool) -> ReachPlacement {
        ReachPlacement {
            placement: CanonicalPlacement {
                piece: piece.to_string(),
                rotation: ROTATION_NAMES[self.rotation].to_string(),
                x: self.x,
                y: self.y,
                used_hold,
            },
            last_rotation: self.last_rotation,
            kick_index: self.kick.map(|(_, index, _)| index),
            kick_id: self.kick.map(|(id, _, _)| id.to_string()),
            kick_offset: self.kick.map(|(_, _, offset)| offset),
        }
    }
}

/// The `state_id` identity of a node: position, rotation, last-rotation flag
/// and the fin/TST flag. Legal states keep every block on the board, so the
/// dense index covers them; `None` falls back to a hash set.
struct Seen {
    width: i32,
    height: i32,
    dense: Vec<bool>,
    sparse: HashSet<(i32, i32, usize, bool, bool)>,
}

const SEEN_MARGIN: i32 = 8;

impl Seen {
    fn new(width: i32, height: i32) -> Self {
        // A board without a positive size never admits a legal state; keep
        // such sizes on the hash set instead of sizing an array from them.
        let dense = width > 0 && height > 0 && width <= 64 && height <= 256;
        let (width, height) = if dense { (width, height) } else { (0, 0) };
        let cells = if dense {
            ((width + 2 * SEEN_MARGIN) * (height + 2 * SEEN_MARGIN)) as usize
        } else {
            0
        };
        Seen {
            width,
            height,
            dense: vec![false; cells * 16],
            sparse: HashSet::new(),
        }
    }

    fn insert(&mut self, node: &Node) -> bool {
        let (x, y) = (node.x + SEEN_MARGIN, node.y + SEEN_MARGIN);
        let (w, h) = (self.width + 2 * SEEN_MARGIN, self.height + 2 * SEEN_MARGIN);
        if self.dense.is_empty() || x < 0 || y < 0 || x >= w || y >= h {
            return self
                .sparse
                .insert((node.x, node.y, node.rotation, node.last_rotation, node.fin));
        }
        let index = (((y * w + x) as usize) * 4 + node.rotation) * 4
            + (node.last_rotation as usize) * 2
            + node.fin as usize;
        !std::mem::replace(&mut self.dense[index], true)
    }
}

/// Same exploration, yield order and results as the string-keyed search it
/// replaced (see `state_id`, `legal_at`, and the kick-table lookup below).
fn bfs(
    board_cells: &str,
    width: i32,
    height: i32,
    cells_table: &HashMap<(String, String), Vec<(i32, i32)>>,
    tables: &KickTables,
    piece: &str,
    used_hold: bool,
    allow_180: bool,
) -> Vec<ReachPlacement> {
    let empty = Vec::new();
    let blocks: [&[(i32, i32)]; 4] = std::array::from_fn(|rotation| {
        cells_table
            .get(&(piece.to_string(), ROTATION_NAMES[rotation].to_string()))
            .unwrap_or(&empty)
            .as_slice()
    });
    let legal = |rotation: usize, x: i32, y: i32| {
        !blocks[rotation]
            .iter()
            .any(|&(bx, by)| occupied(board_cells, width, height, bx + x, by + y))
    };
    let i_piece = piece.eq_ignore_ascii_case("i");
    let kick_tests: [[Option<&Vec<(i32, i32)>>; 4]; 4] = std::array::from_fn(|from| {
        std::array::from_fn(|to| {
            let kick_id = KICK_IDS[from][to];
            if i_piece {
                tables.i_kicks.get(kick_id).or_else(|| tables.kicks.get(kick_id))
            } else {
                tables.kicks.get(kick_id)
            }
        })
    });
    let rotate = |current: &Node, amount: i32| -> Option<Node> {
        let from = current.rotation;
        let to = ((from as i32 + amount) % 4 + 4) as usize % 4;
        if legal(to, current.x, current.y) {
            return Some(Node::rotated(to, current.x, current.y, "00", 0, (0, 0)));
        }
        let tests = kick_tests[from][to]?;
        tests.iter().enumerate().find_map(|(index, &(dx, dy))| {
            let (x, y) = (current.x + dx, current.y - dy);
            legal(to, x, y).then(|| Node::rotated(to, x, y, KICK_IDS[from][to], index as i32, (dx, -dy)))
        })
    };

    let mut queue: Vec<Node> = Vec::new();
    let mut seen = Seen::new(width, height);
    // Seeds every rotation in ROTATION_NAMES order, as both callers did.
    for rotation in 0..4 {
        let spans = blocks[rotation];
        if spans.is_empty() {
            continue;
        }
        let high = spans.iter().map(|(_, y)| *y).max().unwrap();
        let low = spans.iter().map(|(_, y)| *y).min().unwrap();
        let top_y = height - 1 - high;
        if top_y + low < 0 {
            continue;
        }
        for x in -4..width + 4 {
            if !legal(rotation, x, top_y) {
                continue;
            }
            let seed = Node::plain(rotation, x, top_y);
            if seen.insert(&seed) {
                queue.push(seed);
            }
        }
    }
    let amounts: &[i32] = if allow_180 { &[1, -1, 2] } else { &[1, -1] };
    let mut yielded = Vec::new();
    let mut cursor = 0;
    while cursor < queue.len() {
        let current = queue[cursor];
        cursor += 1;
        if !legal(current.rotation, current.x, current.y - 1) {
            yielded.push(current.placement(piece, used_hold));
        }
        for dx in [-1, 1] {
            let moved = Node::plain(current.rotation, current.x + dx, current.y);
            if legal(moved.rotation, moved.x, moved.y) && seen.insert(&moved) {
                queue.push(moved);
            }
        }
        let down = Node::plain(current.rotation, current.x, current.y - 1);
        if legal(down.rotation, down.x, down.y) && seen.insert(&down) {
            queue.push(down);
        }
        for amount in amounts {
            if let Some(rotated) = rotate(&current, *amount) {
                if seen.insert(&rotated) {
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
