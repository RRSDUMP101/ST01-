// App shell: start, pairing, routes, the tab bar (phone) / the side rail (tablet, iPad).
import { api, auth, startEvents } from './api.js';
import { Icon } from './icons.js';
import { CountScreen } from './screens/count.js';
import { HomeScreen } from './screens/home.js';
import { PairScreen } from './screens/pair.js';
import { PickJobScreen, PickListsScreen } from './screens/pick.js';
import { JobScreen, ProductionScreen } from './screens/production.js';
import { ScanScreen } from './screens/scan.js';
import { SettingsScreen } from './screens/settings.js';
import { ItemScreen, StockScreen } from './screens/stock.js';
import { countSession, pickSession } from './sessions.js';
import { SheetHost, Spinner, ToastHost } from './ui.js';
import {
  cls, go, html, local, render, store, unlockAudio, useEffect, useRoute, useStore,
} from './lib.js';

const TABS = [
  ['home', 'home', 'หน้าหลัก'],
  ['prod', 'factory', 'งานผลิต'],
  ['scan', 'scan', 'สแกน AR'],
  ['stock', 'box', 'สต็อก'],
  ['pick', 'pick', 'หยิบของ'],
];

function screenFor(route) {
  const [a, b] = route.parts;
  switch (route.name) {
    case 'prod': return b === 'job' ? html`<${JobScreen} route=${route} />` : html`<${ProductionScreen} route=${route} />`;
    case 'stock': return b === 'item' ? html`<${ItemScreen} route=${route} />` : html`<${StockScreen} route=${route} />`;
    case 'pick': return b === 'job' ? html`<${PickJobScreen} route=${route} />` : html`<${PickListsScreen} route=${route} />`;
    case 'count': return html`<${CountScreen} />`;
    case 'scan': return html`<${ScanScreen} route=${route} key=${route.params.mode + (route.params.code || '')} />`;
    case 'settings': return html`<${SettingsScreen} />`;
    case 'pair': return html`<${PairScreen} />`;
    default: return a === 'home' || !a ? html`<${HomeScreen} />` : html`<${HomeScreen} />`;
  }
}

function TabBar({ current }) {
  const pickJob = useStore((s) => s.pickJob);
  const countN = useStore((s) => s.countN);
  return html`<nav class="tabbar" aria-label="เมนูหลัก">
    ${TABS.map(([key, icon, label]) => {
      const badge = key === 'pick' && pickJob ? '•' : key === 'stock' && countN ? countN : '';
      return html`<button class=${cls('tab', key === 'scan' && 'tab-scan', current === key && 'on')} aria-current=${current === key ? 'page' : undefined}
        onClick=${() => go(key === 'scan' ? 'scan?mode=info' : key)}>
        <span class="tab-ic"><${Icon} name=${icon} size=${key === 'scan' ? 28 : 23} />${badge ? html`<span class="tab-badge">${badge}</span>` : null}</span>
        <span class="tab-label">${label}</span></button>`;
    })}
  </nav>`;
}

function App() {
  const route = useRoute();
  const paired = useStore((s) => s.paired);
  const booted = useStore((s) => s.booted);
  useEffect(() => {
    if (booted && paired === false && route.name !== 'pair' && !(route.name === 'scan' && route.params.mode === 'pair')) go('pair', true);
  }, [booted, paired, route.name]);
  useEffect(() => { window.scrollTo(0, 0); }, [route.path]);
  if (!booted) return html`<div class="boot"><div class="boot-logo"></div><${Spinner} text="กำลังเชื่อมต่อโปรแกรมบนคอม…" /></div>`;
  const full = route.name === 'scan' || route.name === 'pair';
  const tab = route.name === 'count' ? 'stock' : route.name;
  return html`<div class=${cls('app', full && 'app-full')}>
    ${!full ? html`<${TabBar} current=${tab} />` : null}
    <main class="content">${screenFor(route)}</main>
    <${SheetHost} /><${ToastHost} />
  </div>`;
}

async function boot() {
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  store.set({ countN: countSession.get().lines.length, pickJob: (pickSession.get() || {}).job_no || '', queue: local.get('outbox', []).length });
  if (!auth.token) {
    store.set({ paired: false, booted: true });
  } else {
    try {
      const hello = await api.get('hello');
      local.set('hello', hello);
      store.set({ hello, device: hello.device, paired: true, booted: true });
    } catch (e) {
      const cached = local.get('hello', null);
      if (e.status === 401) store.set({ paired: false, booted: true });
      else store.set({ hello: cached, device: cached && cached.device, paired: true, booted: true, offlineBoot: true });
    }
  }
  startEvents();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* certificate not trusted yet: works without it */ });
  }
}

// the QR of the PC opens https://…/#pair=CODE: start on the pairing screen with the code
if (/[#?&]pair=/.test(location.href) && !location.hash.startsWith('#/pair')) {
  const code = (location.href.match(/pair=([A-Za-z0-9-]+)/) || [])[1] || '';
  history.replaceState(null, '', `${location.pathname}#/pair?code=${code}`);
}
render(html`<${App} />`, document.getElementById('app'));
boot();
