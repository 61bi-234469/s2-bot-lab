/**
 * `.ttrm` option resolution.
 *
 * Ported from `fumen-mobile-fork` (`src/lib/ttrm/options.ts`, MIT).  The
 * fallback values are the ones measured against real replay samples, and are
 * the lowest priority in the merge below.
 */

export const DEFAULT_TTRM_OPTIONS = Object.freeze({
  boardwidth: 10,
  boardheight: 20,
  kickset: "SRS+",
  bagtype: "7-bag",
  combotable: "multiplier",
  garbageblocking: "combo blocking",
  clutch: true,
  garbagetargetbonus: "none",
  spinbonuses: "all-mini+",
  stock: 0,
  garbageabsolutecap: 0,
  garbagecapincrease: 0,
  garbagecapmax: 40,
  garbagecap: 8,
  garbagecapmargin: 0,
  garbagespeed: 20,
  garbageholesize: 1,
  messiness_change: 1,
  messiness_nosame: false,
  messiness_timeout: 0,
  messiness_inner: 0,
  messiness_center: false,
  garbagemultiplier: 1,
  garbageincrease: 0.008,
  garbagemargin: 10800,
  usebombs: false,
  garbagespecialbonus: false,
  openerphase: 0,
  roundmode: "down",
  g: 0.02,
  gincrease: 0,
  gmargin: 0,
  b2bchaining: false,
  b2bcharging: false,
  b2bcharge_base: 3,
  allclear_b2b: 0,
  allclear_garbage: 0,
  allowharddrop: true,
  allow180: true,
  display_hold: true,
  infinite_hold: false,
  stride: false,
  lockresets: 15,
  gravitymay20g: true,
  passthrough: "zero",
});

/**
 * Key-wise merge, lowest priority first:
 *   DEFAULT_TTRM_OPTIONS < end.data.options < replay.options
 * A key present in both recorded sources with different values is reported as a
 * warning rather than silently resolved.
 */
export function resolveTtrmOptions(playerReplay) {
  const endEvent = playerReplay.events.find((event) => event.type === "end");
  const endOptions = endEvent?.data?.options ?? {};
  const replayOptions = playerReplay.options;

  const warnings = [];
  for (const key of Object.keys(replayOptions)) {
    if (key in endOptions && JSON.stringify(endOptions[key]) !== JSON.stringify(replayOptions[key])) {
      warnings.push(
        `option "${key}" differs: end=${JSON.stringify(endOptions[key])}` +
        ` replay=${JSON.stringify(replayOptions[key])}`,
      );
    }
  }

  return { warnings, options: { ...DEFAULT_TTRM_OPTIONS, ...endOptions, ...replayOptions } };
}
