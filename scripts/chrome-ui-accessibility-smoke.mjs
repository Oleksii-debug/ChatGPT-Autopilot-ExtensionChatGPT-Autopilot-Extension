import smoke from './browser-smoke-lib.cjs';
smoke.runBrowserSmoke({ verbose: false })
  .then(() => { console.log('chrome-ui-accessibility-smoke: PASS — Chromium keyboard/mode/accessibility contract'); process.exit(0); })
  .catch(error => { console.error(error.stack || error); process.exit(1); });
