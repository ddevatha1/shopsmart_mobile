process.chdir('/Users/ddevatha/shopsmart_dev/shopsmart_mobile');
(async () => {
  try {
    const { loadConfig } = require('metro-config');
    const config = await loadConfig({ cwd: process.cwd() });
    const Transformer = require('/Users/ddevatha/shopsmart_dev/shopsmart_mobile/node_modules/metro/src/DeltaBundler/Transformer.js').default;
    const t = new Transformer(config, { getOrComputeSha1: () => {} });
    console.log('Transformer constructed OK');
  } catch (e) {
    console.error('REAL ERROR:', e);
  }
})();
