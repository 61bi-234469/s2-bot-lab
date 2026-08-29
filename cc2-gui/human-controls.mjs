/* Player input settings for the 1P side of a match.
 *
 * The item list, the units, and the default values follow the `input` and `keys`
 * tabs of `fumen-mobile-fork`, so a player who has tuned their handling there
 * can reproduce it here. Everything in this file only ever affects how this
 * browser turns key presses into piece movement: the match itself is decided by
 * the final placement the player locks, so none of it is sent to the server or
 * validated as a match parameter.
 *
 * A stored document is untrusted input. Anything this build does not recognise
 * falls back to the default rather than being applied. */

export const HUMAN_CONTROLS_STORAGE_KEY = "humanControls";

export const HUMAN_ACTIONS = Object.freeze([
  Object.freeze({ key: "MoveLeft", label: "左へ移動", defaultCode: "ArrowLeft" }),
  Object.freeze({ key: "MoveRight", label: "右へ移動", defaultCode: "ArrowRight" }),
  Object.freeze({ key: "SoftDrop", label: "ソフトドロップ", defaultCode: "ArrowDown" }),
  Object.freeze({ key: "HardDrop", label: "ハードドロップ", defaultCode: "Space" }),
  Object.freeze({ key: "RotateLeft", label: "左回転", defaultCode: "KeyZ" }),
  Object.freeze({ key: "RotateRight", label: "右回転", defaultCode: "KeyX" }),
  Object.freeze({ key: "Rotate180", label: "180度回転", defaultCode: "KeyA" }),
  Object.freeze({ key: "Hold", label: "HOLD", defaultCode: "KeyC" }),
  Object.freeze({ key: "Reset", label: "マッチをリセット", defaultCode: "Escape" }),
]);

// TETR.IO's soft drop factor range, as the reference fork exposes it.
export const SDF_MIN = 5;
export const SDF_MAX = 40;
export const SDF_INFINITE = "infinity";

export const HUMAN_HANDLING_FIELDS = Object.freeze([
  Object.freeze({
    key: "dasFrames", label: "DAS", type: "number", minimum: 1, maximum: 60, step: 0.1,
    defaultValue: 10, suffix: "F", description: "横移動を押し続けてから自動連射が始まるまでのフレーム数。",
  }),
  Object.freeze({
    key: "arrFrames", label: "ARR", type: "number", minimum: 0, maximum: 60, step: 0.1,
    defaultValue: 1, suffix: "F", description: "自動連射の間隔。0にすると端まで一気に移動します。",
  }),
  Object.freeze({
    key: "dcdFrames", label: "DCD", type: "number", minimum: 0, maximum: 60, step: 0.1,
    defaultValue: 0, suffix: "F", description: "回転やHOLDのあとに自動連射を止める長さ（DAS Cut Delay）。",
  }),
  Object.freeze({
    key: "sdf", label: "SDF", type: "sdf", defaultValue: SDF_INFINITE,
    description: "ソフトドロップの速度倍率。∞は接地まで一気に落とします。",
  }),
  Object.freeze({
    key: "softDropPriority", label: "ソフトドロップ優先", type: "boolean", defaultValue: false,
    description: "横移動とソフトドロップが同時に連射されるとき、先にソフトドロップを適用します。",
  }),
  Object.freeze({
    key: "ghost", label: "ゴースト表示", type: "boolean", defaultValue: true,
    description: "落下位置をフィールド上に表示します。",
  }),
]);

export function defaultHumanControls() {
  return {
    handling: Object.fromEntries(HUMAN_HANDLING_FIELDS.map((field) => [field.key, field.defaultValue])),
    keys: Object.fromEntries(HUMAN_ACTIONS.map((action) => [action.key, action.defaultCode])),
  };
}

export function sanitizeHumanControls(input) {
  const controls = defaultHumanControls();
  const stored = plainObject(input);
  const handling = plainObject(stored.handling);
  for (const field of HUMAN_HANDLING_FIELDS) {
    const value = handling[field.key];
    if (field.type === "boolean") {
      if (typeof value === "boolean") controls.handling[field.key] = value;
      continue;
    }
    if (field.type === "sdf") {
      if (isValidSdf(value)) controls.handling[field.key] = value;
      continue;
    }
    if (Number.isFinite(value) && value >= field.minimum && value <= field.maximum) {
      controls.handling[field.key] = value;
    }
  }
  const keys = plainObject(stored.keys);
  for (const action of HUMAN_ACTIONS) {
    const code = keys[action.key];
    if (typeof code === "string" && code !== "" && code.length <= 40) controls.keys[action.key] = code;
  }
  return controls;
}

export function isValidSdf(value) {
  return value === SDF_INFINITE ||
    (Number.isSafeInteger(value) && value >= SDF_MIN && value <= SDF_MAX);
}

/** The handling values in the form the repeat engine consumes. */
export function humanHandling(controls) {
  const handling = sanitizeHumanControls(controls).handling;
  return Object.freeze({
    dasFrames: handling.dasFrames,
    arrFrames: handling.arrFrames,
    dcdFrames: handling.dcdFrames,
    sdf: handling.sdf === SDF_INFINITE ? Infinity : handling.sdf,
    softDropPriority: handling.softDropPriority,
    ghost: handling.ghost,
  });
}

/**
 * Maps a pressed key to the action it is bound to.
 *
 * `null` for an unbound key, so the caller can leave every other shortcut and
 * the browser's own handling of that key alone.
 */
export function actionForCode(controls, code) {
  const keys = sanitizeHumanControls(controls).keys;
  return HUMAN_ACTIONS.find((action) => keys[action.key] === code)?.key ?? null;
}

export function describeHumanControls(controls) {
  const { handling, keys } = sanitizeHumanControls(controls);
  return [
    `DAS ${handling.dasFrames}F`,
    `ARR ${handling.arrFrames}F`,
    `DCD ${handling.dcdFrames}F`,
    `SDF ${handling.sdf === SDF_INFINITE ? "∞" : handling.sdf}`,
    `HARD DROP ${formatKeyCode(keys.HardDrop)}`,
  ].join(" · ");
}

/** A short readable name for a `KeyboardEvent.code`, as printed on the key. */
export function formatKeyCode(code) {
  if (typeof code !== "string" || code === "") return "—";
  const named = {
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
    Space: "Space", Escape: "Esc", Enter: "Enter", Tab: "Tab", Backspace: "BS",
    ShiftLeft: "L Shift", ShiftRight: "R Shift", ControlLeft: "L Ctrl", ControlRight: "R Ctrl",
    AltLeft: "L Alt", AltRight: "R Alt", Comma: ",", Period: ".", Slash: "/", Semicolon: ";",
    Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=",
    Backquote: "`",
  }[code];
  if (named !== undefined) return named;
  const simple = /^(?:Key|Digit|Numpad)(.+)$/.exec(code);
  if (simple !== null) return code.startsWith("Numpad") ? `Num ${simple[1]}` : simple[1];
  return code;
}

function plainObject(value) {
  return value === null || typeof value !== "object" || Array.isArray(value) ? {} : value;
}
