const PPS_PARAMETER = Object.freeze({
  key: "pps",
  label: "PPS",
  type: "number",
  minimum: 0.1,
  maximum: 20,
  step: 0.1,
  defaultValue: 1,
  suffix: "pieces/s",
});

const CC2_PPS_ENABLED_PARAMETER = Object.freeze({
  key: "ppsEnabled",
  label: "PPS",
  group: "pace",
  type: "boolean",
  defaultValue: true,
  description: "ONにすると指定したPPSの間隔で置きます。OFFのときは探索が終わり次第すぐ置きます。",
});

/* `group` and `shortLabel` carry no validation meaning: they only tell the GUI
   which heading a parameter belongs under, and what to call a limit once its own
   toggle already names it. A limit keeps its full `label` for the collapsed
   summary, which has no card around it to supply that context. */
const CC2_PARAMETERS = Object.freeze([
  CC2_PPS_ENABLED_PARAMETER,
  Object.freeze({ ...PPS_PARAMETER, label: "PPS LIMIT", shortLabel: "LIMIT", group: "pace", controlledBy: "ppsEnabled" }),
  Object.freeze({ key: "selectionEnabled", label: "SELECTION", group: "budget", type: "boolean", defaultValue: true, description: "指定した探索数で打ち切ります。固定しておくと、同じ局面での探索量を揃えられます。" }),
  Object.freeze({ key: "selectionLimit", label: "SELECTION LIMIT", shortLabel: "LIMIT", group: "budget", type: "integer", minimum: 1, maximum: 10_000_000, step: 1, defaultValue: 512, suffix: "selections", controlledBy: "selectionEnabled" }),
  Object.freeze({ key: "thinkTimeEnabled", label: "THINK TIME", group: "budget", type: "boolean", defaultValue: false, description: "指定した時間で探索を打ち切ります。端末やブラウザの状態によって、探索量と選ぶ手が変わります。" }),
  Object.freeze({ key: "thinkMs", label: "THINK TIME LIMIT", shortLabel: "LIMIT", group: "budget", type: "integer", minimum: 10, maximum: 10_000, step: 10, defaultValue: 250, suffix: "ms", controlledBy: "thinkTimeEnabled" }),
  Object.freeze({ key: "queueDepth", label: "QUEUE DEPTH", group: "input", type: "integer", minimum: 1, maximum: 28, step: 1, defaultValue: 14, suffix: "pieces" }),
]);

export const BOT_PARAMETER_DEFINITIONS = Object.freeze({
  "cc2-raw": Object.freeze({
    description: "純テトリス向けの MinusKelvin版 Cold Clear 2 です。探索の打ち切り条件と、参照するNEXTの数を設定します。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-chouhy": Object.freeze({
    description: "S2向けの chouhy版 Cold Clear 2 です。MinusKelvin版とは別のBotとして動きます。探索の打ち切り条件と、参照するNEXTの数を設定します。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2": Object.freeze({
    description: "Cold Clear 2 が挙げた候補を、S2のルールで評価し直して選ぶS2向けのBotです。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-gen017": Object.freeze({
    description: "Gen 017：ミニスピンの価値をS2に合わせた調整版です（開発中）。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-f11": Object.freeze({
    description: "F11：Gen 017 をもとに、RENの質を評価する仕組みを加えた開発中のBotです。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-f12": Object.freeze({
    description: "F12：B2Bを保ったままのRENと、大きな攻撃の放出を優先する開発中のBotです。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-f14": Object.freeze({
    description: "F14：せり上がりを受けたあとの盤面の余力を見て、立て直しを優先する開発中のBotです。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-f25": Object.freeze({
    description: "F25：B2Bのボーナスが上がる直前で、B2Bの継続を優先する開発中のBotです。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-champion": Object.freeze({
    description: "いま開発中でいちばん強いBot（champion）です。調整途中の版で、公式に検証済み（release-qualified）ではありません。",
    parameters: CC2_PARAMETERS,
  }),
  "s2-simple": Object.freeze({
    description: "S2のルールだけで置き場所を決める、比較の基準になるBotです。HOLDを候補に入れるかを設定します。",
    parameters: Object.freeze([
      PPS_PARAMETER,
      Object.freeze({ key: "allowHold", label: "ALLOW HOLD", type: "boolean", defaultValue: true }),
    ]),
  }),
  // A human player has no server-side search to configure, and their placement
  // rate is whatever they actually play at rather than a configured PPS. DAS,
  // ARR, DCD, SDF and the key bindings only ever affect the browser's own input
  // handling, so they stay entirely on the front end instead of being validated
  // here as if the match depended on them.
  human: Object.freeze({
    description: "自分でプレイします。操作設定（DAS・ARR・DCD・SDF とキー割り当て）はこのブラウザにだけ保存され、手番はハードドロップした時点で進みます。",
    parameters: Object.freeze([]),
  }),
});

export function botParameterCapability(botType) {
  return structuredClone(definitionFor(botType));
}

export function defaultBotParameters(botType) {
  const definition = definitionFor(botType);
  return Object.freeze(Object.fromEntries(
    definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue]),
  ));
}

export function normalizeBotParameters(botType, input = {}) {
  const definition = definitionFor(botType);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${botType} parameters must be an object`);
  }
  const known = new Set(definition.parameters.map((parameter) => parameter.key));
  const unknown = Object.keys(input).find((key) => !known.has(key));
  if (unknown !== undefined) throw new Error(`unsupported ${botType} parameter ${unknown}`);

  const normalized = Object.fromEntries(definition.parameters.map((parameter) => {
    const value = input[parameter.key] ?? parameter.defaultValue;
    if (parameter.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${parameter.key} must be a boolean`);
      return [parameter.key, value];
    }
    if (parameter.type === "number") {
      if (!Number.isFinite(value) || value < parameter.minimum || value > parameter.maximum) {
        throw new Error(`${parameter.key} must be a number from ${parameter.minimum} to ${parameter.maximum}`);
      }
      return [parameter.key, value];
    }
    if (!Number.isSafeInteger(value) || value < parameter.minimum || value > parameter.maximum) {
      throw new Error(`${parameter.key} must be an integer from ${parameter.minimum} to ${parameter.maximum}`);
    }
    return [parameter.key, value];
  }));
  if ("selectionEnabled" in normalized && !normalized.selectionEnabled && !normalized.thinkTimeEnabled) {
    throw new Error("SELECTION and THINK TIME cannot both be disabled");
  }
  return Object.freeze(normalized);
}

/** Applies the reproducible CC2 comparison preset without mutating the saved
 * per-bot settings. FAIR owns the 1 PPS scheduler separately, so the bot's PPS
 * limiter is represented as OFF here. */
export function fairComparisonBotParameters(botType, input = {}) {
  const normalizedType = botType === "cc2" ? "cc2-raw" : botType;
  if (!normalizedType.startsWith("cc2-")) return normalizeBotParameters(botType, input);
  return normalizeBotParameters(botType, {
    ...input,
    ppsEnabled: false,
    selectionEnabled: true,
    selectionLimit: 512,
    thinkTimeEnabled: false,
  });
}

function definitionFor(botType) {
  // Read old saved documents and callers without exposing the historical
  // ambiguous `cc2` id as a selectable bot in the current GUI.
  const normalizedType = botType === "cc2" ? "cc2-raw" : botType;
  const definition = BOT_PARAMETER_DEFINITIONS[normalizedType];
  if (definition === undefined) throw new Error(`unsupported bot type ${botType}`);
  return definition;
}
