const DEVELOPMENT_ENTRY = '<script type="module" src="app.mjs"></script>';
const PAGES_ENTRY = '<script type="module" src="app.bundle.js"></script>';
const STYLES_ENTRY = '<link rel="stylesheet" href="styles.css">';

/** Convert the local-development HTML entry to the self-contained Pages bundle. */
export function preparePagesIndex(index, appVersion = null, stylesVersion = null) {
  if (typeof index !== "string") {
    throw new Error("Pages entry replacement target is missing");
  }
  let output = index;
  if (output.includes(DEVELOPMENT_ENTRY)) output = output.replace(DEVELOPMENT_ENTRY, PAGES_ENTRY);
  else if (!output.includes(PAGES_ENTRY)) throw new Error("Pages entry replacement target is missing");
  if (appVersion !== null) {
    if (!/^[a-f0-9]{12}$/.test(appVersion)) throw new Error("Pages app version must be a 12-character hex digest");
    output = output.replace(PAGES_ENTRY, `<script type="module" src="app.bundle.js?v=${appVersion}"></script>`);
  }
  if (stylesVersion !== null) {
    if (!/^[a-f0-9]{12}$/.test(stylesVersion)) throw new Error("Pages styles version must be a 12-character hex digest");
    if (!output.includes(STYLES_ENTRY)) throw new Error("Pages stylesheet replacement target is missing");
    output = output.replace(STYLES_ENTRY, `<link rel="stylesheet" href="styles.css?v=${stylesVersion}">`);
  }
  return output;
}
