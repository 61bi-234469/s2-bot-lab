import S2_MANIFEST from "../../rulesets/tetrio-s2-v19-beta-1-5-0-observed.json" with { type: "json" };

// `/1` (until 2026-09-25) kept the Engine queue at 15 pieces and exposed exactly
// 14 NEXT. `/2` exposes the queue the Triangle Engine model holds: its 14-piece
// minimum is replenished one 7-bag at a time before a spawn takes a piece, so
// after a spawn 13-19 NEXT are public (current + 13 is always available).
export const INPUT_EXECUTION_PROFILE_ID = "s2-input-execution/2";
export const INPUT_EXECUTION_HANDLING = Object.freeze({
  arr: 0, das: 0, dcd: 0, sdf: 41, safelock: false,
  cancel: true, may20g: true, irs: "off", ihs: "off",
});

export const INPUT_EXECUTION_PROFILE = Object.freeze({
  id: INPUT_EXECUTION_PROFILE_ID,
  rulesetId: S2_MANIFEST.id,
  queueMinimum: 14,
  publicNextMinimum: 13,
  publicNextMaximum: 19,
  handling: INPUT_EXECUTION_HANDLING,
});

// Triangle exposes no independent switches for these TETR.IO rules.  Keeping
// the observed values as the only accepted replay values prevents a custom
// replay from being simulated with a different rule while its option is merely
// ignored.  Unknown replay metadata remains outside this list by design.
const REPLAY_UNSUPPORTED_NONDEFAULTS = Object.freeze({
  allclears: S2_MANIFEST.normalizedOptions.allclears,
  allclear_b2b_sends: S2_MANIFEST.normalizedOptions.allclear_b2b_sends,
  allclear_b2b_dupes: S2_MANIFEST.normalizedOptions.allclear_b2b_dupes,
  allclear_charges: S2_MANIFEST.normalizedOptions.allclear_charges,
  b2bextras: S2_MANIFEST.normalizedOptions.b2bextras,
  are: S2_MANIFEST.normalizedOptions.are,
  lineclear_are: S2_MANIFEST.normalizedOptions.lineclear_are,
});

/**
 * Report replay options whose non-default value cannot be represented by the
 * pinned Triangle engine.  The caller decides how to classify the issues so
 * this helper can also be used by the replay importer without rejecting
 * ordinary TTRM metadata.
 */
export function validateReplayOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return [{ key: null, expected: "object", actual: options }];
  }
  return Object.entries(REPLAY_UNSUPPORTED_NONDEFAULTS)
    .filter(([key, expected]) => Object.hasOwn(options, key) && !Object.is(options[key], expected))
    .map(([key, expected]) => ({ key, expected, actual: options[key] }));
}

/* The observed S2 ruleset escalates two rule values as a game goes on: gravity
   past `gmargin`, and the garbage (damage) multiplier past `garbagemargin`. The
   cap, messiness timeout and every other option are already static, and the
   opener phase counts pieces rather than elapsed time, so those two keys are
   the whole of this ruleset's time progression. A local round may switch it
   off; `g`, `gmargin`, `garbagemultiplier` and `garbagemargin` keep their
   observed values, so the two admissible rounds differ in exactly these keys
   and an arbitrary custom rule still cannot enter the canonical profile. */
const TIME_PROGRESSION_KEYS = Object.freeze(['gincrease', 'garbageincrease']);

/* Natural gravity is the second thing a local round may switch off, and the
   only rule a turn match needs removed: with `g` at zero the pinned Engine
   never lowers a piece and never starts a landed piece's lock timer, so the
   piece waits where the player leaves it and only a hard drop locks it. That is
   the same movement contract the legacy final-placement route already has.
   `gmargin`, `locktime` and `lockresets` keep their observed values, so a
   gravity-off round differs from the canonical profile in exactly these keys.
   `gincrease` is shared with time progression: a rise from zero is still zero,
   so switching gravity off also fixes that key, and `garbageincrease` alone
   then reports whether time progression is on. */
const NATURAL_GRAVITY_KEYS = Object.freeze(['g', 'gincrease']);

/* The ruleset identity a round is refereed under lives in `ruleset-profiles`
   (`timeProgressionRulesetId`). It stays out of this module because the public
   bot decision path depends on it and must not pull in the profile registry. */

export function inputExecutionTimeProgression(options) {
  return TIME_PROGRESSION_KEYS.some(key => (options?.[key] ?? 0) !== 0);
}

export function inputExecutionNaturalGravity(options) {
  return (options?.g ?? 0) !== 0;
}

/** Fixed opt-in initialization contract; it does not qualify a match for export. */
export function inputExecutionOptions({ seed, profileId = INPUT_EXECUTION_PROFILE.id, handling = INPUT_EXECUTION_HANDLING,
  timeProgression = true, naturalGravity = true } = {}) {
  if (profileId !== INPUT_EXECUTION_PROFILE.id) throw new Error(`unsupported input execution profile ${profileId}`);
  if (typeof timeProgression !== 'boolean') throw new Error('input execution time progression must be boolean');
  if (typeof naturalGravity !== 'boolean') throw new Error('input execution natural gravity must be boolean');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("input execution seed must be an unsigned 32-bit integer");
  }
  const resolvedHandling = { ...INPUT_EXECUTION_HANDLING, ...handling };
  for (const [key, value] of Object.entries(resolvedHandling)) {
    const valid = ['arr', 'das', 'dcd', 'sdf'].includes(key)
      ? Number.isFinite(value) && value >= 0 && value <= 60 && (key !== 'arr' || value === 0 || value >= 0.01)
      : ['safelock', 'cancel', 'may20g'].includes(key) ? typeof value === 'boolean'
      : ['irs', 'ihs'].includes(key) && value === 'off';
    if (!valid) throw new Error(`unsupported input handling ${key}`);
  }
  return {
    ...S2_MANIFEST.normalizedOptions,
    ...(timeProgression ? {} : Object.fromEntries(TIME_PROGRESSION_KEYS.map(key => [key, 0]))),
    ...(naturalGravity ? {} : Object.fromEntries(NATURAL_GRAVITY_KEYS.map(key => [key, 0]))),
    seed,
    allowharddrop: S2_MANIFEST.normalizedOptions.allow_harddrop,
    handling: resolvedHandling,
  };
}

/**
 * Resolved `.ttrm` options to Triangle `EngineInitializeParams`.
 *
 * Ported from `fumen-mobile-fork` (`src/lib/ttrm/engine_config.ts`, MIT).
 * `@haelp/teto` 4.2.7 requires `options.stock`, `misc.stride` and both
 * `misc.allowed.undo` / `misc.allowed.retry`; leaving any of them out makes the
 * engine reject the configuration.
 */

export function buildEngineConfig(o, opponents) {
  return {
    board: { width: o.boardwidth ?? 10, height: o.boardheight ?? 20, buffer: 20 },
    kickTable: o.kickset ?? "SRS+",
    options: {
      comboTable: o.combotable ?? "multiplier",
      garbageBlocking: o.garbageblocking ?? "combo blocking",
      clutch: o.clutch ?? true,
      garbageTargetBonus: o.garbagetargetbonus ?? "none",
      spinBonuses: o.spinbonuses ?? "all-mini+",
      stock: o.stock ?? 0,
    },
    queue: { minLength: 10, seed: o.seed, type: o.bagtype ?? "7-bag" },
    garbage: {
      cap: {
        absolute: o.garbageabsolutecap ?? 0,
        increase: o.garbagecapincrease ?? 0,
        max: o.garbagecapmax ?? 40,
        value: o.garbagecap ?? 8,
        marginTime: o.garbagecapmargin ?? 0,
      },
      boardWidth: o.boardwidth ?? 10,
      garbage: { speed: o.garbagespeed ?? 20, holeSize: o.garbageholesize ?? 1 },
      messiness: {
        change: o.messiness_change ?? 1,
        nosame: o.messiness_nosame ?? false,
        timeout: o.messiness_timeout ?? 0,
        within: o.messiness_inner ?? 0,
        center: o.messiness_center ?? false,
      },
      multiplier: {
        value: o.garbagemultiplier ?? 1,
        increase: o.garbageincrease ?? 0.008,
        marginTime: o.garbagemargin ?? 10800,
      },
      bombs: o.usebombs ?? false,
      specialBonus: o.garbagespecialbonus ?? false,
      openerPhase: o.openerphase ?? 0,
      seed: o.seed,
      rounding: o.roundmode ?? "down",
    },
    gravity: { value: o.g ?? 0.02, increase: o.gincrease ?? 0, marginTime: o.gmargin ?? 0 },
    handling: {
      arr: o.handling?.arr ?? 0,
      das: o.handling?.das ?? 6,
      dcd: o.handling?.dcd ?? 0,
      sdf: o.handling?.sdf ?? 41,
      safelock: o.handling?.safelock ?? false,
      cancel: o.handling?.cancel ?? false,
      may20g: o.handling?.may20g ?? true,
      irs: o.handling?.irs ?? "tap",
      ihs: o.handling?.ihs ?? "tap",
    },
    b2b: {
      chaining: !!o.b2bchaining,
      charging: o.b2bcharging
        ? { at: o.b2bcharge_at ?? 4, base: o.b2bcharge_base ?? 3 }
        : false,
    },
    pc: { b2b: o.allclear_b2b ?? 0, garbage: o.allclear_garbage ?? 0 },
    misc: {
      allowed: {
        hardDrop: o.allowharddrop ?? true,
        spin180: o.allow180 ?? true,
        hold: o.display_hold ?? true,
        undo: false,
        retry: false,
      },
      infiniteHold: o.infinite_hold ?? false,
      stride: o.stride ?? false,
      movement: {
        infinite: false,
        lockResets: o.lockresets ?? 15,
        lockTime: o.locktime ?? 30,
        may20G: o.gravitymay20 ?? o.gravitymay20g ?? true,
      },
      username: o.username,
    },
    multiplayer: { opponents, passthrough: o.passthrough ?? "zero" },
  };
}
