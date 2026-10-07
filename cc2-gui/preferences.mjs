/* Persisted GUI preferences: the selected mode tab, the control values of both
   modes, and the per-side bot parameters.

   The stored document is untrusted input. A browser profile keeps whatever an
   older build wrote, so every field is validated on read and anything the
   current build does not recognise is dropped rather than applied. Dropping a
   field falls back to the markup default, never to a blank control.

   The bot parameter normalizer is injected because this module is served to the
   browser from the GUI root, where `src-js` is not reachable. */

export const PREFERENCES_STORAGE_KEY = "s2-analysis-engine.gui-preferences/1";
/* Revision of the bot parameter defaults the stored document was written
   against. A document from an older revision keeps the user's settings except
   the keys listed here, which are reset to the current default whatever their
   stored value: an older document cannot tell an explicit value from the
   default it was written with. Revision 2 (2026-10-08): the champion's
   SELECTION default became 2,048 on 2026-10-03, so documents written before
   mostly carry the former 512 as the champion limit. */
export const BOT_DEFAULTS_REVISION = 2;
const BOT_DEFAULTS_REVISION_RESETS = Object.freeze({ "cc2-s2-champion": Object.freeze(["selectionLimit"]) });
export const GUI_MODES = Object.freeze(["analysis", "match", "replay"]);
export const PREFERENCE_SIDES = Object.freeze(["left", "right"]);
/* Controls read back through `element.value`, so they are stored as strings. */
export const CONTROL_PREFERENCE_IDS = Object.freeze([
  "analysis-bot",
  "think-ms",
  "candidate-count",
  "left-bot",
  "right-bot",
  "match-seed",
  "match-max-turns",
  "match-count",
  "match-stall-lock-pps",
  "match-stall-lock-penalty",
  "match-turn-order",
  "replay-speed",
]);
export const TOGGLE_PREFERENCE_IDS = Object.freeze([
  "match-fair-comparison",
  "match-pre-lock-preview",
  "match-ttrm-compatible",
  "match-time-progression",
  "match-unlimited-turns",
  "match-random-seed",
  "match-stall-lock",
  "match-handicap-garbage",
  "match-turn-match",
]);

export function emptyPreferences() {
  return {
    mode: null,
    controls: {},
    toggles: {},
    botParameters: Object.fromEntries(PREFERENCE_SIDES.map((side) => [side, {}])),
    humanControls: null,
  };
}

/* `sanitizeControls` validates the 1P input settings. It is injected for the
   same reason as the bot parameter normalizer: this module is served from the
   GUI root and must not reach into the player control module's own defaults. */
export function sanitizePreferences(input, normalizeParameters, sanitizeControls = null) {
  const preferences = emptyPreferences();
  const stored = plainObject(input);
  if (GUI_MODES.includes(stored.mode)) preferences.mode = stored.mode;

  const controls = plainObject(stored.controls);
  for (const id of CONTROL_PREFERENCE_IDS) {
    if (typeof controls[id] === "string" && controls[id] !== "") preferences.controls[id] = controls[id];
  }

  const toggles = plainObject(stored.toggles);
  for (const id of TOGGLE_PREFERENCE_IDS) {
    if (typeof toggles[id] === "boolean") preferences.toggles[id] = toggles[id];
  }

  const botParameters = plainObject(stored.botParameters);
  const outdatedDefaults = stored.botDefaultsRevision !== BOT_DEFAULTS_REVISION;
  for (const side of PREFERENCE_SIDES) {
    for (const [botType, values] of Object.entries(plainObject(botParameters[side]))) {
      try {
        let kept = plainObject(values);
        if (outdatedDefaults && Object.hasOwn(BOT_DEFAULTS_REVISION_RESETS, botType)) {
          kept = { ...kept };
          for (const key of BOT_DEFAULTS_REVISION_RESETS[botType]) delete kept[key];
        }
        preferences.botParameters[side][botType] = { ...normalizeParameters(botType, kept) };
      } catch {
        // A bot or parameter this build no longer accepts keeps its default.
      }
    }
  }

  if (sanitizeControls !== null) preferences.humanControls = sanitizeControls(stored.humanControls);
  return preferences;
}

function plainObject(value) {
  return value === null || typeof value !== "object" || Array.isArray(value) ? {} : value;
}
