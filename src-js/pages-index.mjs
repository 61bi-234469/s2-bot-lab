const DEVELOPMENT_ENTRY = '<script type="module" src="app.mjs"></script>';
const PAGES_ENTRY = '<script type="module" src="app.bundle.js"></script>';

/** Convert the local-development HTML entry to the self-contained Pages bundle. */
export function preparePagesIndex(index) {
  if (typeof index !== "string") {
    throw new Error("Pages entry replacement target is missing");
  }
  if (index.includes(PAGES_ENTRY) && !index.includes(DEVELOPMENT_ENTRY)) return index;
  if (!index.includes(DEVELOPMENT_ENTRY)) throw new Error("Pages entry replacement target is missing");
  return index.replace(DEVELOPMENT_ENTRY, PAGES_ENTRY);
}
