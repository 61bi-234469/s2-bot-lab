import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatInputExecutionTooltip, renderGarbageGauge } from "../cc2-gui/field-render.mjs";

const app = readFileSync(new URL("../cc2-gui/app.mjs", import.meta.url), "utf8");
const styles = readFileSync(new URL("../cc2-gui/styles.css", import.meta.url), "utf8");

test("garbage gauge preserves attack boundaries, row scale and overflow count", t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = { createElement: () => ({ className: "", style: {} }) };
  t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else delete globalThis.document; });
  const container = { dataset: {}, replaceChildren(...children) { this.children = children; }, setAttribute(_name, value) { this.label = value; } };
  renderGarbageGauge(container, [{ amount: 4 }, { amount: 2 }], "right");
  assert.match(container.label, /6 rows in 2 attacks/);
  assert.equal(container.dataset.tankable, "6");
  assert.deepEqual(container.children.map(child => child.style.gridRow), ['17 / span 4', '15 / span 2']);
  renderGarbageGauge(container, [3, 3, 4].map(amount => ({ amount })), 'right');
  assert.deepEqual(container.children.map(child => child.style.gridRow), ['18 / span 3', '15 / span 3', '11 / span 4']);
  renderGarbageGauge(container, [18, 4, 2].map(amount => ({ amount })), 'right');
  assert.deepEqual(container.children.map(child => child.style.gridRow), ['3 / span 18', '1 / span 2']);
  assert.equal(container.dataset.pending, '24');
  renderGarbageGauge(container, [], 'right');
  assert.equal(container.children.length, 0);
});

test("garbage gauge renders immature packets transparent and keeps amount-only packets solid", t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = { createElement: () => ({ className: "", style: {} }) };
  t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else delete globalThis.document; });
  const container = { dataset: {}, replaceChildren(...children) { this.children = children; }, setAttribute(_name, value) { this.label = value; } };

  renderGarbageGauge(container, [{ amount: 4, ready: true }, { amount: 2, ready: false }], "right");
  assert.deepEqual(container.children.map(child => child.className), ["gauge-segment", "gauge-segment not-ready"]);
  assert.equal(container.dataset.pending, "6");
  assert.equal(container.dataset.tankable, "4");
  assert.match(container.label, /4 active now/);
  assert.match(styles, /\.gauge-segment\.not-ready\s*\{[^}]*background:\s*transparent/);
});

test("input execution tooltip shows counters and the last fallback evidence", () => {
  const tooltip = formatInputExecutionTooltip({
    plannedLocks: 12,
    fallbackLocks: 2,
    naturalLocks: 1,
    publicStateMismatches: 3,
    lateResponses: 4,
    replans: 5,
    resolutionOutcomes: { preferred: 14, fallback: 3, notFound: 1, stale: 2 },
    pacedLocks: 13, deadlineExceededLocks: 2,
    lastFallback: {
      reason: "preferred-path-not-found",
      pieceIndex: 17,
      frame: 1024,
      preferredCandidate: {
        piece: "T",
        rotation: "reverse",
        spin: "normal",
        lines: 2,
        rotationWitness: { class: "kicked", kickId: "12", kickOffset: [1, -1] },
      },
    },
  });

  assert.match(tooltip, /計画 12手 \/ 代替 2手 \/ 自然接地 1手/);
  assert.match(tooltip, /公開状態の不一致 3回 \/ 遅延応答 4回 \/ 再計画 5回/);
  assert.match(tooltip, /直近の代替理由: preferred-path-not-found/);
  assert.match(tooltip, /優先候補: T \/ 回転 reverse \/ スピン normal \/ 2ライン/);
  assert.match(tooltip, /回転証拠: 種類 kicked \/ キック 12 \/ 移動量 \[1, -1\]/);
  assert.match(tooltip, /代替接地: 18手目 \/ 1024フレーム/);
  assert.match(tooltip, /第1候補実行 \/ 経路判定: 10\/20 \(50.0%\)/);
  assert.match(tooltip, /次候補選択 \/ 経路判定: 3\/20 \(15.0%\)/);
  assert.match(tooltip, /PPS期限超過 \/ PPS有効接地: 2\/13 \(15.4%\)/);
});

test("input execution tooltip remains useful before fallback evidence exists", () => {
  const tooltip = formatInputExecutionTooltip({ plannedLocks: 1, fallbackLocks: 0, naturalLocks: 0, lastFallback: null });
  assert.match(tooltip, /公開状態の不一致 0回 \/ 遅延応答 0回 \/ 再計画 0回/);
  assert.doesNotMatch(tooltip, /直近の代替理由/);
});

test("renderMatch uses the input execution formatter for the ATK readout tooltip", () => {
  assert.match(app, /formatInputExecutionTooltip\(bot\.inputExecution\)/);
});
