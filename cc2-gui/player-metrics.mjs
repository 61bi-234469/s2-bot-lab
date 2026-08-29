export const DEFAULT_GLICKO_RD = 60.9;
export const DEFAULT_EST_TR_GAMES_WON = 18;

/**
 * Computes the live TETR.IO-style rate and TetraStats-derived parameters used
 * by the GUI. `attack` is generated attack before cancellation, while
 * `garbageCleared` is the number of cleared rows that contained garbage.
 */
export function calculatePlayerMetrics({
  pieces,
  attack,
  garbageCleared,
  elapsedFrames,
  framesPerSecond = 60,
  glickoRd = DEFAULT_GLICKO_RD,
  gamesWon = DEFAULT_EST_TR_GAMES_WON,
}) {
  for (const [label, value] of Object.entries({ pieces, attack, garbageCleared, elapsedFrames })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  }
  if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
    throw new Error("framesPerSecond must be positive");
  }

  const seconds = elapsedFrames / framesPerSecond;
  const pps = seconds > 0 ? pieces / seconds : 0;
  const apm = seconds > 0 ? attack * 60 / seconds : 0;
  const vs = seconds > 0 ? (attack + garbageCleared) * 100 / seconds : 0;
  const app = pieces > 0 ? attack / pieces : 0;
  const dsSecond = seconds > 0 ? garbageCleared / seconds : 0;
  const dsPiece = pieces > 0 ? garbageCleared / pieces : 0;
  const appDsPiece = app + dsPiece;
  const garbageEfficiency = pps > 0 ? ((app * dsSecond) / pps) * 2 : 0;
  const area = apm + pps * 45 + vs * 0.444 + app * 185
    + dsSecond * 175 + dsPiece * 450 + garbageEfficiency * 315;

  const vsApm = apm > 0 ? vs / apm : null;
  if (pps <= 0 || vsApm === null) {
    return withUnavailableDerived({
      seconds, apm, pps, vs, app, dsSecond, dsPiece, vsApm,
      garbageEfficiency, appDsPiece, area,
    });
  }

  const cheeseIndex = dsPiece * 150 + (vsApm - 2) * 50 + (0.6 - app) * 125;
  const weightedApp = app - 5 * Math.tan((((cheeseIndex / -30) + 1) * Math.PI) / 180);
  const srArea = 135 * pps + 290 * app + 700 * dsPiece;
  if (srArea === 0) {
    return withUnavailableDerived({
      seconds, apm, pps, vs, app, dsSecond, dsPiece, vsApm,
      garbageEfficiency, appDsPiece, cheeseIndex, weightedApp, area,
    });
  }

  let stRank = 11.2 * Math.atan((srArea - 93) / 130) + 1;
  if (stRank <= 0) stRank = 0.001;
  const nApm = (apm / srArea) / (0.069 * 1.0017 ** ((stRank ** 5) / 4700) + stRank / 360);
  const nPps = (pps / srArea)
    / (0.0084264 * 2.14 ** (-2 * (stRank / 2.7 + 1.03)) - stRank / 5750 + 0.0067);
  const nApp = app / (0.1368803292 * 1.0024 ** ((stRank ** 5) / 2800) + stRank / 54);
  const nDsPiece = dsPiece
    / (0.02136327583 * 14 ** ((stRank - 14.75) / 3.9) + stRank / 152 + 0.022);
  const nGarbageEfficiency = garbageEfficiency
    / (stRank / 350 + 0.005948424455 * 3.8 ** ((stRank - 6.1) / 4) + 0.006);
  const nDs = vsApm / (-(((stRank - 16) / 36) ** 2) + 2.133);

  const opener = ((nApm - 1) + (nPps - 1) * 0.75 + (nDs - 1) * -10
    + (nApp - 1) * 0.75 + (nDsPiece - 1) * -0.25) / 3.5 + 0.5;
  const stride = ((nApm - 1) * -0.25 + (nPps - 1) + (nApp - 1) * -2
    + (nDsPiece - 1) * -0.5) * 0.79 + 0.5;
  const plonk = ((nGarbageEfficiency - 1) + (nApp - 1) + (nDsPiece - 1) * 0.75
    + (nPps - 1) * -1) / 2.73 + 0.5;
  const infDs = ((nDsPiece - 1) + (nApp - 1) * -0.75 + (nApm - 1) * 0.5
    + (nDs - 1) * 1.5 + (nPps - 1) * 0.5) * 0.9 + 0.5;

  return {
    seconds,
    apm,
    pps,
    vs,
    app,
    dsSecond,
    dsPiece,
    vsApm,
    garbageEfficiency,
    cheeseIndex,
    weightedApp,
    appDsPiece,
    area,
    estTr: estimateTr(pps, app, dsPiece, vsApm, glickoRd, gamesWon),
    opener,
    plonk,
    stride,
    infDs,
  };
}

export function formatGameClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const totalMilliseconds = Math.round(seconds * 1000);
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const secondsWithinMinute = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(secondsWithinMinute).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

export function estimateTr(pps, app, dsPiece, vsApm, glickoRd = DEFAULT_GLICKO_RD, gamesWon = DEFAULT_EST_TR_GAMES_WON) {
  const ntemp = pps * (150 + (vsApm - 1.66) * 35) + app * 290 + dsPiece * 700;
  const oldGlicko = 0.000013 * ntemp ** 3 - 0.0196 * ntemp ** 2 + 12.645 * ntemp - 1005.4;
  const estimatedGlicko = oldGlicko * 0.9211 - 49.086;
  const gamesFactor = Math.min(1, 0.5 + 0.5 * (gamesWon / 18));
  const deviationFactor = 1 + (60 - glickoRd) / 1500;
  const first = 1 + Math.exp(-deviationFactor * 1.56 * ((estimatedGlicko - 1500) / 500));
  const second = 1 + Math.exp(-deviationFactor * 0.86 * ((estimatedGlicko - 2000) / 500));
  return 22000 / first ** (1 / (0.87646605 * gamesFactor))
    + 3000 / second ** (1 / (0.25 * gamesFactor ** 2));
}

function withUnavailableDerived(metrics) {
  return {
    ...metrics,
    cheeseIndex: metrics.cheeseIndex ?? null,
    weightedApp: metrics.weightedApp ?? null,
    estTr: null,
    opener: null,
    plonk: null,
    stride: null,
    infDs: null,
  };
}
