import assert from "node:assert/strict";
import test from "node:test";
import { preparePagesIndex } from "../src-js/pages-index.mjs";

test("Pages HTML loads the generated browser bundle instead of the development entry", () => {
  const output = preparePagesIndex('<main></main><script type="module" src="app.mjs"></script>');
  assert.match(output, /src="app\.bundle\.js"/);
  assert.doesNotMatch(output, /src="app\.mjs"/);
});

test("Pages HTML build fails closed when the development entry changes", () => {
  assert.throws(() => preparePagesIndex("<main></main>"), /replacement target is missing/);
});

test("Pages HTML build preserves an already transformed public entry", () => {
  const index = '<main></main><script type="module" src="app.bundle.js"></script>';
  assert.equal(preparePagesIndex(index), index);
});

test("Pages HTML cache-busts the generated browser bundle with its content digest", () => {
  const index = '<main></main><script type="module" src="app.bundle.js"></script>';
  assert.match(preparePagesIndex(index, "0123456789ab"), /src="app\.bundle\.js\?v=0123456789ab"/);
  assert.throws(() => preparePagesIndex(index, "not-a-digest"), /12-character hex digest/);
});
