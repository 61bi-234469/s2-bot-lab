const DEVELOPMENT_ENTRY = '<script type="module" src="app.mjs"></script>';
const PAGES_ENTRY = '<script type="module" src="app.bundle.js"></script>';

/** Convert the local-development HTML entry to the self-contained Pages bundle. */
export function preparePagesIndex(index, appVersion = null) {
  if (typeof index !== "string") {
    throw new Error("Pages entry replacement target is missing");
  }
  let output = index;
  if (output.includes(DEVELOPMENT_ENTRY)) output = output.replace(DEVELOPMENT_ENTRY, PAGES_ENTRY);
  else if (!output.includes(PAGES_ENTRY)) throw new Error("Pages entry replacement target is missing");
  if (appVersion === null) return output;
  if (!/^[a-f0-9]{12}$/.test(appVersion)) throw new Error("Pages app version must be a 12-character hex digest");
  return output.replace(PAGES_ENTRY, `<script type="module" src="app.bundle.js?v=${appVersion}"></script>`);
}
