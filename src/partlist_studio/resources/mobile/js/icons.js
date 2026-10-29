// Line icons (24 × 24, stroke = currentColor) drawn for this app.
import { html } from './lib.js';

const P = {
  home: 'M3 11.5 12 4l9 7.5M5.5 9.8V20h13V9.8M10 20v-5.5h4V20',
  factory: 'M3 20V10l5 3V10l5 3V10l5 3V4h3v16zM7 17h2M12 17h2M17 17h1',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16',
  box: 'M12 3 20 7.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  pick: 'M7 11V6a2 2 0 0 1 4 0v4M11 10V4.5a2 2 0 0 1 4 0V10M15 10V6.5a2 2 0 0 1 4 0V14a7 7 0 0 1-7 7h-.5a7 7 0 0 1-5.6-2.8L3.5 15a2 2 0 0 1 3-2.6L7 13',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13.5l1.6 1.2-1.8 3.1-1.9-.6a7.6 7.6 0 0 1-1.7 1l-.4 2h-3.6l-.4-2a7.6 7.6 0 0 1-1.7-1l-1.9.6-1.8-3.1 1.6-1.2a7.7 7.7 0 0 1 0-2L2 10.3l1.8-3.1 1.9.6a7.6 7.6 0 0 1 1.7-1l.4-2h3.6l.4 2a7.6 7.6 0 0 1 1.7 1l1.9-.6 1.8 3.1-1.6 1.2a7.7 7.7 0 0 1 0 2z',
  back: 'M15 5l-7 7 7 7',
  chev: 'M9 5l7 7-7 7',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M4.5 12.5l5 5L19.5 7',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  alert: 'M12 3 2.5 20h19zM12 10v4.5M12 17.5v.5',
  search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM15.5 15.5 21 21',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  torch: 'M8 3h8l-1 6H9zM9 9l1 12h4l1-12M12 13v3',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
  layers: 'M12 3 2.5 8 12 13l9.5-5zM2.5 12.5 12 17.5l9.5-5M2.5 16.5 12 21.5l9.5-5',
  cube: 'M12 2.8 20.5 7.5v9L12 21.2 3.5 16.5v-9zM3.5 7.5 12 12.2l8.5-4.7M12 12.2v9',
  refresh: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  wifi: 'M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.7 16a5 5 0 0 1 6.6 0M12 19.5v.5',
  wifioff: 'M3 3l18 18M8.7 16a5 5 0 0 1 6.6 0M5.5 12.5a9.5 9.5 0 0 1 4.3-2.3M2.5 9a14 14 0 0 1 4.6-2.9M13.8 6.2A14 14 0 0 1 21.5 9M16.8 10.4a9.5 9.5 0 0 1 1.7 2.1M12 19.5v.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.5M4 12h.5M4 18h.5',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.5',
  count: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 17h6M17 14v6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2M16 16h2v2',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  send: 'M3 11 21 3l-8 18-2-8z',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v7M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13a8 8 0 0 1-8 8 6 6 0 0 1-5-2.7L2.5 15a1.5 1.5 0 0 1 2.5-1.7L8 16',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
};

export function Icon({ name, size = 22, stroke = 2, className = '', title }) {
  return html`<svg class=${`ic ${className}`} width=${size} height=${size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round"
    aria-hidden=${title ? undefined : 'true'} role=${title ? 'img' : undefined}>
    ${title ? html`<title>${title}</title>` : null}<path d=${P[name] || P.info} /></svg>`;
}
