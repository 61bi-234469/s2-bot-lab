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

// The F14 core runs at most 1,000,000 selections and needs a NEXT piece.
const GATED_CORE_PARAMETERS = Object.freeze(CC2_PARAMETERS.map((parameter) =>
  parameter.key === "selectionLimit" ? Object.freeze({ ...parameter, maximum: 1_000_000 })
    : parameter.key === "queueDepth" ? Object.freeze({ ...parameter, minimum: 2 }) : parameter));

/* Each GUI bot's display name and settings introduction, shared by both hosts.
   The project bots run oldest to newest; names describe the design, and only
   the parenthesis marks which one is the current champion. Descriptions give
   where the bot comes from, what was tuned and why, and how it plays. */
export const BOT_PARAMETER_DEFINITIONS = Object.freeze({
  "cc2-raw": Object.freeze({
    label: "Raw CC2 — MinusKelvin upstream (deterministic port)",
    description: [
      "由来：MinusKelvin 氏の Cold Clear 2（upstream ed8b193）を、同じ局面・同じ設定なら同じ手を返すように移植したものです。",
      "調整・意図：S2 向けの変更は加えていません。ほかの Bot と比べるときの出発点です。",
      "特徴：通常のテトリス向けの評価で探索し、S2 固有の火力・B2B チャージ・せり上がりの規則は考慮しません。",
    ].join("\n"),
    parameters: CC2_PARAMETERS,
  }),
  "cc2-chouhy": Object.freeze({
    label: "CC2 — chouhy fork b20a92b (deterministic port)",
    description: [
      "由来：chouhy 氏による Cold Clear 2 のフォーク（b20a92b）を、同じ局面・同じ設定なら同じ手を返すように移植したものです。",
      "調整・意図：作者が S2 向けに調整した外部の Bot です。このプロジェクトでは強さの目安にする対戦相手として使っています。",
      "特徴：このプロジェクトの S2 実装や開発 Bot とは独立に動きます。",
    ].join("\n"),
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-f14": Object.freeze({
    label: "CC2 S2 — F14 post-tank rescue",
    description: [
      "由来：このプロジェクトの初期の開発 Bot です（2026年8月）。S2 のルールに合わせた Cold Clear 2（CC2 S2）が候補手を出し、F14 選別が最終手を選びます。",
      "調整・意図：CC2 S2 の上位 16 手を、S2 の火力（相殺後）・B2B・せり上がり・高さ・穴を数えた評価で CC2 の順位を補正して並べ替えます。その先頭が、届くせり上がりを受けたあと持ちこたえられない（余力がない）ときは、余力の残る最上位の候補に切り替えます。相手のせり上がりは段数だけを参照します。",
      "特徴：CC2 の順位を重く見ながら、S2 の実際の火力と守りで最終手を決める構成です。180° 回転とスポーン位置より上からの差し込みは使いません。",
    ].join("\n"),
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-champion-legacy": Object.freeze({
    label: "CC2 S2 — F14 rescue + 180° rotation (former champion)",
    description: [
      "由来：2026年9月3日にチャンピオンになった構成です。9月23日に F14 コアへ切り替わるまで、TTRM INPUT の判断もこの経路でした。",
      "調整・意図：F14 post-tank rescue と同じ並べ替えと余力による救済選別に、180° 回転とスポーン位置より上からの差し込みを使える候補生成を組み合わせました。",
      "特徴：現在の CC2 S2 実行ファイルで当時の経路を再現した比較用で、当時のバイナリそのものではありません。",
    ].join("\n"),
    parameters: CC2_PARAMETERS,
  }),
  "cc2-s2-champion-previous": Object.freeze({
    label: "CC2 S2 — gated leaf-conversion κ0.25 (former champion)",
    description: [
      "由来：2026年9月25日〜26日のチャンピオンです。救済選別を CC2 S2 の探索の中（F14 コア）に移した構成です。",
      "調整・意図：探索の先の盤面に「スピンや B2B で火力に変えやすい形」の評価を加えました（leaf conversion、係数 κ=0.25）。高く積んだ局面で守りを崩さないよう、盤面の高さが 8 段以下のときだけ加えます（gated、H=8）。",
      "特徴：最終手は CC2 の順位どおりで、最上位手が余力を失うときだけ、余力の残る最上位の候補に切り替えます（root rescue）。評価の重みは CC2 S2 の既定値です。",
    ].join("\n"),
    parameters: GATED_CORE_PARAMETERS,
  }),
  "cc2-s2-champion": Object.freeze({
    label: "CC2 S2 — SPSA-tuned gated leaf-conversion (current champion)",
    description: [
      "由来：2026年9月26日からの現チャンピオンです。gated leaf-conversion κ0.25 を土台にしています。",
      "調整・意図：κ と、高さ・穴・B2B・スピン・コンボなどの評価の重み 8 個を、自己対戦による自動調整（SPSA）で決め直しました（kappa=0.1164, H=8）。",
      "特徴：判断の仕組み（F14 コア、CC2 の順位どおり、root rescue）は κ0.25 版と同じで、κ と評価の重みだけが違います。開発版で、正式な評価（release-qualified）は受けていません。",
    ].join("\n"),
    parameters: GATED_CORE_PARAMETERS,
  }),
  "s2-simple": Object.freeze({
    label: "S2 placement bot",
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
    label: "You (1P)",
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
    definition.parameters.filter((parameter) => parameter.omitDefault !== true)
      .map((parameter) => [parameter.key, parameter.defaultValue]),
  ));
}

export function normalizeBotParameters(botType, input = {}) {
  const definition = definitionFor(botType);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${botType} parameters must be an object`);
  }
  // Older saved champion settings carried an ENGINE selector. Its value no
  // longer changes the route, so silently discard that key during migration.
  if (botType === "cc2-s2-champion" && Object.hasOwn(input, "engineProfile")) {
    input = { ...input };
    delete input.engineProfile;
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
    if (parameter.type === "enum") {
      const allowed = parameter.options?.map(({ value: option }) => option) ?? [];
      if (typeof value !== "string" || !allowed.includes(value)) {
        throw new Error(`${parameter.key} must be one of ${allowed.join(", ")}`);
      }
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
  for (const parameter of definition.parameters) {
    if (parameter.omitDefault === true && normalized[parameter.key] === parameter.defaultValue) {
      delete normalized[parameter.key];
    }
  }
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
