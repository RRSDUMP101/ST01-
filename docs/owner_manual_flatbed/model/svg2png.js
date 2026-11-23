const { chromium } = require('playwright'); const fs=require('fs');
(async()=>{const [src,out,w]=process.argv.slice(2);const W=+w||1400;
const html=src.replace(/\.svg$/,'.view.html');fs.writeFileSync(html,`<body style="margin:0;background:#fff"><img id=i src="${src.split('/').pop()}" style="width:${W}px;display:block">`);
const b=await chromium.launch();const p=await b.newPage({viewport:{width:W,height:900}});
await p.goto('file://'+html);await p.waitForTimeout(800);const el=await p.$('#i');await el.screenshot({path:out});await b.close();})();
