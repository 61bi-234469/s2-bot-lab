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

/* `group` and `shortLabel` carry no validation meaning: they only tell the GUI
   which heading a parameter belongs under, and what to call a limit once its own
   toggle already names it. A limit keeps its full `label` for the collapsed
   summary, which has no card around it to supply that context. */
const CC2_PARAMETERS = Object.freeze([
  Object.freeze({ ...PPS_PARAMETER, group: "pace" }),
  Object.freeze({ key: "selectionEnabled", label: "SELECTION", group: "budget", type: "boolean", defaultValue: true, description: "指定した探索選択数で打ち切ります。固定値では同じ局面の探索量を揃えられます。" }),
  Object.freeze({ key: "selectionLimit", label: "SELECTION LIMIT", shortLabel: "LIMIT", group: "budget", type: "integer", minimum: 1, maximum: 10_000_000, step: 1, defaultValue: 512, suffix: "selections", controlledBy: "selectionEnabled" }),
  Object.freeze({ key: "thinkTimeEnabled", label: "THINK TIME", group: "budget", type: "boolean", defaultValue: false, description: "有効にすると実時間で探索を打ち切るため、端末性能・ブラウザ・実行時負荷により探索量と選択手が変わります。" }),
  Object.freeze({ key: "thinkMs", label: "THINK TIME LIMIT", shortLabel: "LIMIT", group: "budget", type: "integer", minimum: 10, maximum: 10_000, step: 10, defaultValue: 250, suffix: "ms", controlledBy: "thinkTimeEnabled" }),
  Object.freeze({ key: "queueDepth", label: "QUEUE DEPTH", group: "input", type: "integer", minimum: 1, maximum: 28, step: 1, defaultValue: 14, suffix: "pieces" }),
]);

export const BOT_PARAMETER_DEFINITIONS = Object.freeze({
  "cc2-raw": Object.freeze({
    description: "MinusKelvin/cold-clear-2（raw upstream）の探索条件と参照する NEXT queue を設定します。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-chouhy": Object.freeze({
    description: "chouhy/cold-clear-2 fork の探索条件と参照する NEXT queue を設定します。raw upstream とは別のBotとして実行します。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2": Object.freeze({
    description: "CC2の深い探索候補をcanonical S2 Simulatorで再採点するS2特化ハイブリッドです。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-gen017": Object.freeze({
    description: "Gen 017のmini-spin価値整合configを使うS2特化ハイブリッドです（開発用）。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-f11": Object.freeze({
    description: "Gen 017 alignedを土台に、相互排他的なREN品質評価器を加えたF11開発botです。release候補ではありません。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-f12": Object.freeze({
    description: "Gen 017 alignedを土台に、B2B継続RENと高Surge放出だけを優先するF12開発botです。release候補ではありません。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-f14": Object.freeze({
    description: "F12を土台に、post-tank後の盤面余力から残留garbage debtを差し引くF14開発botです。release候補ではありません。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-f25": Object.freeze({
    description: "F14を土台に、B2B閾値直前で継続を守るF25開発botです。release候補ではありません。",
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-champion": Object.freeze({
    description: "現在の開発champion（F14 selector + substrate v2 + search-state）です。release-qualifiedではありません。",
    parameters: CC2_PARAMETERS,
  }),
  "s2-simple": Object.freeze({
    description: "S2最終配置botがHOLD候補を探索するかを設定します。",
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
    description: "自分でプレイします。操作設定（DAS/ARR/DCD/SDF・キー割り当て）はこのブラウザだけで完結し、対戦の進行はハードドロップした実時間で決まります。",
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

function definitionFor(botType) {
  // Read old saved documents and callers without exposing the historical
  // ambiguous `cc2` id as a selectable bot in the current GUI.
  const normalizedType = botType === "cc2" ? "cc2-raw" : botType;
  const definition = BOT_PARAMETER_DEFINITIONS[normalizedType];
  if (definition === undefined) throw new Error(`unsupported bot type ${botType}`);
  return definition;
}
