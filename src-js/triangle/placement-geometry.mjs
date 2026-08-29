import { kickData } from "@haelp/teto/engine";

import {
  ROTATIONS,
  canonicalBoardToTriangle,
  createPlacedTetromino,
} from "./placement-adapter.mjs";

export const GEOMETRY_PIECES = Object.freeze(["I", "O", "T", "L", "J", "S", "Z"]);
const ROTATION_NAMES = Object.freeze(Object.keys(ROTATIONS));

/**
 * The block layout and kick table a player-controlled front end needs in order
 * to move a piece cell for cell the way this server evaluates it.
 *
 * The table is derived from Triangle itself rather than restated as browser
 * constants: a hand-copied layout or kick order would drift from the placement
 * adapter silently, and the first symptom would be a human placement that the
 * S2 Simulator rejects or classifies as a different spin than the player saw.
 *
 * Block offsets are relative to the canonical placement origin, so a cell of a
 * placement is `[placement.x + dx, placement.y + dy]` on the bottom-origin
 * canonical board. Kick offsets are already converted to that same convention,
 * which makes each entry identical to the `kickOffset` the resulting rotation
 * evidence must carry.
 */
export function placementGeometry(rules) {
  const table = kickData[rules.kickTable];
  if (table === undefined) throw new Error(`unknown kick table ${rules.kickTable}`);
  if (Object.keys(table.additional_offsets ?? {}).length !== 0) {
    throw new Error(`kick table ${rules.kickTable} has unsupported additional offsets`);
  }

  const board = canonicalBoardToTriangle({
    width: 10,
    height: 40,
    cells: "_".repeat(400),
  });

  return {
    kickTable: rules.kickTable,
    allow180: rules.allow180 !== false,
    rotations: [...ROTATION_NAMES],
    spawnRotation: Object.fromEntries(GEOMETRY_PIECES.map((piece) => [
      piece,
      ROTATION_NAMES[table.spawn_rotation?.[piece.toLowerCase()] ?? 0],
    ])),
    blocks: Object.fromEntries(GEOMETRY_PIECES.map((piece) => [
      piece,
      Object.fromEntries(ROTATION_NAMES.map((rotation) => [
        rotation,
        createPlacedTetromino(board, { piece, rotation, x: 0, y: 0 }).absoluteBlocks
          .map(([x, y]) => [x, y]),
      ])),
    ])),
    // Triangle stores a kick test as a screen-space offset whose Y grows
    // downward. The placement adapter applies it as `y - dy` and records
    // `[dx, -dy]`, so the published table carries the recorded form directly.
    kicks: Object.fromEntries(GEOMETRY_PIECES.map((piece) => {
      const tests = table[`${piece.toLowerCase()}_kicks`] ?? table.kicks;
      return [
        piece,
        Object.fromEntries(Object.entries(tests).map(([kickId, offsets]) => [
          kickId,
          offsets.map(([dx, dy]) => [dx, -dy]),
        ])),
      ];
    })),
  };
}
