import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const base = new URL('../src/ui/', import.meta.url);
function setup() {
  const stored = new Map();
  const root = { RRS: { util: {}, auth: { can: (_, p) => p !== 'forbidden' } }, localStorage: { getItem: k => stored.get(k) ?? null, setItem: (k,v) => stored.set(k,v) }, console };
  vm.runInNewContext(fs.readFileSync(new URL('kit.js', base), 'utf8'),root);
  vm.runInNewContext(fs.readFileSync(new URL('app.js', base),'utf8').replace('RRS.boot = boot;', 'RRS.shellTest = { NAV_GROUPS, navHtml, builtin, themeControls }; RRS.boot = boot;'),root);
  root.document = { documentElement: { dataset: {} }, querySelector: () => null };
  return { root, stored, api:root.RRS.shellTest };
}
test('every registered page remains reachable in exactly one of seven task groups', () => {
  const {api} = setup();
  const grouped=Array.from(api.NAV_GROUPS.flatMap(g=>g.ids));
  const files=fs.readdirSync(new URL('pages/',base));
  const ids=files.filter(f=>f.endsWith('.js')).map(f=>fs.readFileSync(new URL('pages/'+f,base),'utf8').match(/RRS\.ui\.page\(\{\s*id:\s*'([^']+)'/)?.[1]).filter(Boolean);
  assert.equal(api.NAV_GROUPS.length,7);
  assert.equal(new Set(grouped).size,grouped.length);
  assert.deepEqual(ids.filter(id=>!grouped.includes(id)),[]);
});
test('navigation preserves permission filtering and escapes page titles',()=>{
  const {root,api}=setup();
  root.RRS.ui.pages={stock:{id:'stock',title:'<img src=x onerror=1>'},items:{id:'items',title:'private',perm:'forbidden'}};
  root.RRS.app.page='stock';
  const html=String(api.navHtml({}));
  assert.match(html,/aria-current="page"/);
  assert.match(html,/&lt;img/);
  assert.doesNotMatch(html,/data-go="items"/);
  assert.match(html,/<details[^>]* open/);
});
test('theme choice persists locally without resetting the current page or form view',()=>{
  const {root,stored,api}=setup();
  root.RRS.app.page='docs';root.RRS.app.views.docs={unsaved:'keep'};
  api.builtin._theme({dataset:{arg:'dark'}});
  assert.equal(root.document.documentElement.dataset.theme,'dark');
  assert.equal(stored.get('rrs-sq:theme'),'"dark"');
  assert.equal(root.RRS.app.views.docs.unsaved,'keep');
  assert.equal(root.RRS.app.page,'docs');
  assert.match(String(api.themeControls()),/data-arg="dark" aria-pressed="true"/);
  api.builtin._theme({dataset:{arg:'<script>'}});
  assert.equal(root.document.documentElement.dataset.theme,'dark');
  api.builtin._theme({dataset:{arg:'light'}});
  assert.equal(root.document.documentElement.dataset.theme,'light');
});
