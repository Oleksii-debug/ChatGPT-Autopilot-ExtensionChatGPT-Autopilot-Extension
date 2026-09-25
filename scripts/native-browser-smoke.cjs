const { runBrowserSmoke } = require('./browser-smoke-lib.cjs');
runBrowserSmoke()
  .then(() => process.exit(0))
  .catch(error => { console.error(error.stack || error); process.exit(1); });
