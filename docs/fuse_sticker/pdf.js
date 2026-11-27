const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 548, height: 208 }, deviceScaleFactor: 8 });
  await p.goto('file://' + process.cwd() + '/sticker.html'); await p.evaluate(() => document.fonts.ready);
  await p.pdf({ path: 'RRS-Trailer-Fuse-Relay-Sticker-145x55.pdf', width: '145mm', height: '55mm', printBackground: true });
  await p.screenshot({ path: 'RRS-Trailer-Fuse-Relay-Sticker-145x55.png' });   // ~600 dpi preview
  await b.close();
})();
