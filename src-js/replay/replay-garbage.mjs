/**
 * Garbage parcels and the gauge identity, derived from ReplayIR alone.
 *
 * Ported from `fumen-mobile-fork` (`src/lib/ttrm/garbage.ts`, MIT).  One attack
 * (`iid`) is one parcel, and its life (received, then cancelled or tanked) is
 * reconstructed from the recorded event series only: no engine re-run and no
 * per-lock snapshot is needed.
 *
 * Pure functions only. This module is also served to the browser, so it must
 * not import anything that is not itself pure.
 */

/** Default `garbagecap`: the gauge's full mark and the over-cap boundary. */
export const DEFAULT_GARBAGE_CAP = 8;

export function garbageCapOf(player) {
  const cap = player.resolvedOptions?.garbagecap;
  return typeof cap === "number" && cap > 0 ? cap : DEFAULT_GARBAGE_CAP;
}

// One derived representation per player round, released with the IR itself.
const timelineCache = new WeakMap();

function buildTimeline(player) {
  const events = [];
  const gaugePoints = [];
  const tanks = [];
  const parcels = [];
  const byIid = new Map();
  // Lets the killing tank be traced back to the parcel that carried it.
  const tankIids = [];

  let gauge = 0;
  let maxGauge = 0;

  for (const event of player.garbageEvents ?? []) {
    if (event.kind === "confirm") {
      const parcel = byIid.get(event.iid);
      if (parcel !== undefined) {
        parcel.gameid = event.gameid;
        parcel.senderFrame = event.senderFrame;
      } else {
        // A confirm arriving before its receive must not be dropped.
        const created = {
          iid: event.iid,
          receivedFrame: event.frame,
          amount: 0,
          gameid: event.gameid,
          senderFrame: event.senderFrame,
          resolutions: [],
        };
        byIid.set(event.iid, created);
        parcels.push(created);
      }
      continue;
    }

    events.push(event);

    if (event.kind === "receive") {
      gauge += event.amount;
      const parcel = byIid.get(event.iid);
      if (parcel === undefined) {
        const created = { iid: event.iid, receivedFrame: event.frame, amount: event.amount, resolutions: [] };
        byIid.set(event.iid, created);
        parcels.push(created);
      } else {
        parcel.receivedFrame = parcel.amount === 0 ? event.frame : parcel.receivedFrame;
        parcel.amount += event.amount;
      }
    } else {
      gauge -= event.amount;
      const resolution = {
        frame: event.frame,
        kind: event.kind,
        amount: event.amount,
        column: event.column,
        size: event.size,
      };
      byIid.get(event.iid)?.resolutions.push(resolution);
      if (event.kind === "tank") {
        tanks.push(resolution);
        tankIids.push(event.iid);
      }
    }

    gaugePoints.push({ gauge, frame: event.frame });
    if (maxGauge < gauge) maxGauge = gauge;
  }

  // A parcel created by its confirm gets its received frame later, so the
  // series is ordered once at the end.
  parcels.sort((a, b) => a.receivedFrame - b.receivedFrame);

  const timeline = { parcels, gaugePoints, tanks, events, maxGauge };
  timeline.killer = findKiller(player, tanks, tankIids, byIid);
  return timeline;
}

// The last tank is the cause of death only when it landed after the last
// placement. A player who topped out placing a piece was not killed by garbage.
function findKiller(player, tanks, tankIids, byIid) {
  if (player.terminal?.reason === "winner") return undefined;
  const last = tanks[tanks.length - 1];
  if (last === undefined || last.column === undefined) return undefined;
  const lastLock = player.locks[player.locks.length - 1];
  if (lastLock !== undefined && last.frame < lastLock.frame) return undefined;
  const parcel = byIid.get(tankIids[tankIids.length - 1]);
  return {
    frame: last.frame,
    amount: last.amount,
    column: last.column,
    senderFrame: parcel?.senderFrame,
    gameid: parcel?.gameid,
  };
}

export function getGarbageTimeline(player) {
  const cached = timelineCache.get(player);
  if (cached !== undefined) return cached;
  const built = buildTimeline(player);
  timelineCache.set(player, built);
  return built;
}

// Position of the last entry with frame <= f, or -1.
function lastIndexAtFrame(frames, frame) {
  if (frames.length === 0 || frame < frames[0].frame) return -1;
  let low = 0;
  let high = frames.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle].frame <= frame) low = middle;
    else high = middle;
  }
  return low;
}

/** Rows received but not yet resolved at an arbitrary frame. */
export function gaugeAtFrame(timeline, frame) {
  const index = lastIndexAtFrame(timeline.gaugePoints, frame);
  return index < 0 ? 0 : timeline.gaugePoints[index].gauge;
}

/** Cumulative rows that have risen into the board by this frame. */
export function tankedAtFrame(timeline, frame) {
  let total = 0;
  for (const tank of timeline.tanks) {
    if (frame < tank.frame) break;
    total += tank.amount;
  }
  return total;
}

/** Received, still unresolved parcels in arrival order. */
export function pendingParcelsAt(timeline, frame) {
  const pending = [];
  for (const parcel of timeline.parcels) {
    if (frame < parcel.receivedFrame) continue;
    const resolved = parcel.resolutions
      .filter((resolution) => resolution.frame <= frame)
      .reduce((sum, resolution) => sum + resolution.amount, 0);
    const remaining = parcel.amount - resolved;
    if (remaining > 0) pending.push({ remaining, iid: parcel.iid, receivedFrame: parcel.receivedFrame });
  }
  return pending;
}

/**
 * The rows that actually rose after this frame, in application order.
 *
 * This is hindsight, not a prediction the player had: it reads recorded tanks
 * rather than guessing from the pending parcels, so the viewer must present it
 * as such.
 */
export function riseForecastAt(timeline, frame, maxRows) {
  const rows = [];
  let counted = 0;
  for (const tank of timeline.tanks) {
    if (tank.frame <= frame) continue;
    if (maxRows <= counted) break;
    rows.push({
      frame: tank.frame,
      column: tank.column ?? 0,
      size: tank.size !== undefined && tank.size > 0 ? tank.size : 1,
      rows: tank.amount,
    });
    counted += tank.amount;
  }
  return rows;
}

/** The latest receive, cancel or tank. Confirms are not display events. */
export function recentEventAt(timeline, frame) {
  const index = lastIndexAtFrame(timeline.events, frame);
  return index < 0 ? undefined : timeline.events[index];
}

/** Undefined for the winner and for a round that ended on a placement. */
export function killerGarbageOf(player) {
  return getGarbageTimeline(player).killer;
}

/** Everything one player's gauge needs at one frame, read in a single pass. */
export function garbageViewAt(player, frame) {
  const timeline = getGarbageTimeline(player);
  const gauge = gaugeAtFrame(timeline, frame);
  const rises = gauge > 0 ? riseForecastAt(timeline, frame, gauge) : [];
  return {
    gauge,
    rises,
    rise: rises[0],
    cap: garbageCapOf(player),
    maxGauge: timeline.maxGauge,
    moreRows: Math.max(0, gauge - 1),
    recent: recentEventAt(timeline, frame),
    pending: pendingParcelsAt(timeline, frame),
  };
}
