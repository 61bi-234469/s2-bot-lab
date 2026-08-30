/* Persisted GUI preferences: the selected mode tab, the control values of both
   modes, and the per-side bot parameters.

   The stored document is untrusted input. A browser profile keeps whatever an
   older build wrote, so every field is validated on read and anything the
   current build does not recognise is dropped rather than applied. Dropping a
   field falls back to the markup default, never to a blank control.

   The bot parameter normalizer is injected because this module is served to the
   browser from the GUI root, where `src-js` is not reachable. */

export const PREFERENCES_STORAGE_KEY = "s2-analysis-engine.gui-preferences/1";
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
  "replay-speed",
]);
export const TOGGLE_PREFERENCE_IDS = Object.freeze([
  "match-fair-comparison",
  "match-think-time-pace",
  "match-pre-lock-preview",
  "match-unlimited-turns",
  "match-random-seed",
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
  for (const side of PREFERENCE_SIDES) {
    for (const [botType, values] of Object.entries(plainObject(botParameters[side]))) {
      try {
        preferences.botParameters[side][botType] = { ...normalizeParameters(botType, values) };
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
