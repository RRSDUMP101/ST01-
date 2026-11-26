const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 700, height: 993 } });
  await p.goto('file://' + process.cwd() + '/booklet.html'); await p.evaluate(() => document.fonts.ready);
  await p.pdf({ path: 'RRS-Owner-Manual-Cargo-Flatbed.pdf', width: '148mm', height: '210mm', scale: 0.8, printBackground: true });
  const over = await p.evaluate(() => [...document.querySelectorAll('.page')].map((s, i) => { const m = s.querySelector('main'); return m ? [i + 1, Math.round(m.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom + 16 * 3.78)] : null }).filter(x => x && x[1] > 0));
  console.log('overflow(px beyond footer zone):', JSON.stringify(over));
  const secs = await p.$$('.page'); for (const i of []) await secs[i].screenshot({ path: `p${i + 1}.png` });
  await b.close();
})();
