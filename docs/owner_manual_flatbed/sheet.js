const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1640, height: 1000 } });
  await p.goto('file://' + process.cwd() + '/booklet.html');
  await p.addStyleTag({ content: 'body{display:grid;grid-template-columns:repeat(4,215mm);gap:6mm;background:#888;padding:6mm;zoom:.49}' });
  const h = await p.evaluate(() => document.body.getBoundingClientRect().height);
  const half = Math.ceil(h / 2 / 463) * 463;
  await p.screenshot({ path: 'sheet1.png', clip: { x: 0, y: 0, width: 1640, height: Math.min(half, h) } , fullPage: true});
  await p.screenshot({ path: 'sheet2.png', clip: { x: 0, y: half, width: 1640, height: h - half }, fullPage: true });
  await b.close();
})();
