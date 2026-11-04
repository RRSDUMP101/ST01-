// รูปชิ้นส่วน: two tabs - แบบ 2D (the flat pattern of the DWG) and รูปประกอบจริง (a photo a phone took, else the picture
// of the standard Part List when the PC found it is this part) - and a button to take a new photo.
import { api, useData } from './api.js';
import { Icon } from './icons.js';
import { Button, Empty, Seg } from './ui.js';
import { Part3D, PartImage } from './view3d.js';
import { feedback, html, store, toast, useRef, useState } from './lib.js';

const MAX_SIDE = 1600;  // a photo is made smaller on the phone (the PC keeps at most 1.5 MB)

function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * k);
      canvas.height = Math.round(img.naturalHeight * k);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      let data = canvas.toDataURL('image/jpeg', 0.82);
      if (data.length > 1900000) data = canvas.toDataURL('image/jpeg', 0.6);
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('เปิดรูปไม่ได้')); };
    img.src = url;
  });
}

export function PartTabs({ item, height = 220, onChanged }) {
  const photo = item.photo || {};
  const [tab, setTab] = useState(item.has_outline ? '2d' : 'real');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const canChange = ((store.state.device || {}).role || '') !== 'viewer';
  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const data = await shrink(file);
      await api.post('photo', { code: item.code, data });
      feedback.ok();
      toast('บันทึกรูปประกอบจริงแล้ว – ทุกเครื่องเห็นรูปนี้', 'ok');
      setTab('real');
      if (onChanged) onChanged();
    } catch (err) {
      feedback.error();
      toast(err.message || 'ส่งรูปไม่ได้', 'bad', 4200);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="part-tabs">
    <${Seg} className="small" value=${tab} onChange=${setTab}
      options=${[['2d', 'แบบ 2D'], ['real', 'รูปประกอบจริง']]} />
    ${tab === '2d' ? (item.has_outline ? html`<${Part3D} code=${item.outline_code || item.code} height=${height} flat />`
      : html`<${Empty} icon="cube" title="ไม่มีแบบ 2D ของชิ้นนี้" text="ยังไม่ได้นำเข้ารูปคลี่จากแบบ DWG / DXF ของรหัสนี้" />`)
    : html`<div class="real-photo">
        ${photo.has ? html`<${PartImage} code=${item.code} height=${height} version=${photo.version} />
          <p class="muted small"><${Icon} name=${photo.kind === 'taken' ? 'camera' : 'layers'} size=${14} /> ${photo.source}</p>`
        : html`<${Empty} icon="camera" title="ไม่มีรูปประกอบจริง"
            text=${photo.note || 'ไม่พบรูปใน Part List มาตรฐานที่ตรงกับชิ้นนี้ – ถ่ายรูปชิ้นงานจริงเพิ่มได้'} />`}
        ${canChange ? html`<${Button} kind=${photo.has ? 'secondary' : 'primary'} block icon="camera" disabled=${busy}
            onClick=${() => input.current && input.current.click()}>
            ${busy ? 'กำลังส่งรูป…' : photo.has ? 'ถ่ายรูปใหม่ (แทนรูปเดิม)' : 'ถ่ายรูปประกอบจริง'}</${Button}>
          <input ref=${input} type="file" accept="image/*" capture="environment" hidden onChange=${pick} />` : null}
      </div>`}
  </div>`;
}

// the tabs of a code, fetched again after a new photo (a scan result or a job part is not)
export function PartTabsLive({ code, first, height = 170 }) {
  const state = useData('item', { code });
  const item = state.data ? { ...first, ...state.data } : first;
  return html`<${PartTabs} item=${item || { code }} height=${height} onChanged=${state.reload} />`;
}
