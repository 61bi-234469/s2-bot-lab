import { completedInputRoundRecording } from "../input-execution-round.mjs";
import { parseTtrm } from "./ttrm-parser.mjs";
import { simulatePlayerRound } from "./ttrm-simulator.mjs";

export class BotMatchTtrmError extends Error {
  constructor(stage, message, lockIndex = null) {
    super(message);
    this.name = "BotMatchTtrmError";
    this.stage = stage;
    this.lockIndex = lockIndex;
  }
}

/** Serializes consumed input from completed, referee-owned sessions.
 * The companion provenance must travel with the file: league is a verified
 * format discriminator, not a claim that this synthetic round was official.
 * This entry never searches for a placement witness.
 */
export function buildExecutedInputTtrm(round) {
  let owned;
  try { owned = completedInputRoundRecording(round); }
  catch (error) { throw new BotMatchTtrmError('provenance', error.message); }
  const { players: sessions, terminal } = owned;
  if (!Array.isArray(sessions) || sessions.length !== 2 || sessions.some(session =>
    session.profile !== 's2-input-execution/1')) {
    throw new BotMatchTtrmError('provenance', 'two finished input-profile sessions are required');
  }
  const losers = sessions.filter(session => session.toppedOut);
  if (losers.length < 1 || (losers.length === 1 && terminal.winnerId === null) ||
      (losers.length === 2 && terminal.winnerId !== null)) throw new BotMatchTtrmError('terminal', 'export requires an observed top-out result');
  const observations = sessions.map(session => session.observed);
  if (new Set(observations.map(player => player.id)).size !== 2) {
    throw new BotMatchTtrmError('provenance', 'input players must have distinct identities');
  }
  const players = sessions.map((session, index) => {
    const observed = observations[index];
    const events = session.events.map(event => event.type === 'start'
      ? { ...event, data: {} } : event);
    if (!events.some(event => event.type === 'start' && event.frame === 0)) {
      throw new BotMatchTtrmError('provenance', 'the consumed start event is missing');
    }
    const frames = session.frame;
    // End is metadata describing the observed exclusive boundary, not input.
    const reason = session.toppedOut ? 'topout' : 'winner';
    events.push({ frame: Math.max(0, frames - 1), type: 'end', data: { reason } });
    const username = observed.username ?? observed.id;
    // allowharddrop is the Triangle adapter's alias, not a native TETR.IO
    // option. Keep the native allow_harddrop value in the serialized file.
    const options = { ...observed.resolvedOptions, gameid: index + 1, username };
    delete options.allowharddrop;
    const seconds = frames / 60;
    const stats = {
      apm: observed.recordedStats.garbage.attack / (seconds / 60 || 1),
      pps: observed.recordedStats.piecesplaced / (seconds || 1),
      vsscore: (observed.recordedStats.garbage.attack + observed.recordedStats.garbage.cleared) / Math.max(1, seconds) * 100,
    };
    return { id: observed.id, username, active: true, naturalorder: index,
      alive: !session.toppedOut, lifetime: seconds * 1000, stats,
      replay: { frames, events, options,
        results: { stats: observed.recordedStats, aggregatestats: stats, gameoverreason: reason } } };
  });
  const provenance = {
    origin: 's2-bot-lab-generated', profile: sessions[0].profile,
    verification: 'pinned-engine-self-replay-and-lock-and-garbage-queue-canonical', releaseEvidence: false,
    note: 'Synthetic local input round; not an official TETR.IO league match. Transport/terminal canonical qualification is pending.',
  };
  const text = JSON.stringify({ version: 1, gamemode: 'league', meta: provenance,
    users: players.map(({ id, username }) => ({ id, username })), replay: {
      leaderboard: players.map(({ id, username, active, naturalorder, alive, stats }) =>
        ({ id, username, active, naturalorder, wins: alive ? 1 : 0, stats })),
      rounds: [players],
    } });
  const parsed = parseTtrm(text);
  for (const [index, player] of parsed.replay.rounds[0].entries()) {
    const replayed = simulatePlayerRound(player, { canonicalProfile: sessions[index].profile });
    const expected = observations[index];
    const fields = ['locks', 'garbageEvents', 'recordedStats'];
    const mismatch = fields.find(field => JSON.stringify(replayed[field]) !== JSON.stringify(expected[field]));
    const terminalFields = ['frame', 'fullField', 'hold', 'current', 'next', 'garbageGauge'];
    const terminalMismatch = terminalFields.find(field => JSON.stringify(replayed.terminal[field]) !== JSON.stringify(expected.terminal[field]));
    if (mismatch || terminalMismatch || !replayed.verification.matched) {
      throw new BotMatchTtrmError('verify', `executed input replay differs: ${mismatch ?? terminalMismatch ?? 'statistics'}`);
    }
  }
  return { text, provenance };
}
