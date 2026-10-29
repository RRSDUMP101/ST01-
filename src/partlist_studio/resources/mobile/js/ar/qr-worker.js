/* eslint-env worker */
// Reads every QR code in a camera frame (several at once, with their four corners) off the main thread.
// The phone's own BarcodeDetector when it has one (Android), else ZXing-C++ in WebAssembly (iPhone / iPad).
/* global ZXingWASM, BarcodeDetector */
importScripts('../../vendor/zxing-reader.js');

let ready = null;
let native = null;
let engine = 'auto';

function zxing() {
  if (!ready) {
    ready = ZXingWASM.prepareZXingModule({
      overrides: {
        locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL('../../vendor/zxing_reader.wasm', self.location.href).href : prefix + path),
      },
      fireImmediately: true,
    });
  }
  return ready;
}

async function nativeDetector() {
  if (native !== null) return native;
  native = false;
  try {
    if ('BarcodeDetector' in self) {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) native = new BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch (e) {
    native = false;
  }
  return native;
}

const OPTIONS = {
  formats: ['QRCode'], tryHarder: true, tryRotate: false, tryInvert: false, tryDownscale: true, maxNumberOfSymbols: 24,
};

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    engine = msg.engine || 'auto';
    try {
      const det = engine === 'zxing' ? false : await nativeDetector();
      if (!det) await zxing();
      self.postMessage({ type: 'ready', engine: det ? 'native' : 'zxing' });
    } catch (e) {
      self.postMessage({ type: 'error', error: String(e && e.message ? e.message : e) });
    }
    return;
  }
  if (msg.type !== 'frame') return;
  const { id, width, height, buffer } = msg;
  const started = performance.now();
  try {
    const image = new ImageData(new Uint8ClampedArray(buffer), width, height);
    let codes = [];
    const det = engine === 'zxing' ? false : await nativeDetector();
    if (det) {
      const found = await det.detect(image);
      codes = found.filter((b) => b.cornerPoints && b.cornerPoints.length === 4)
        .map((b) => ({ text: b.rawValue, pts: b.cornerPoints.map((p) => [p.x, p.y]) }));
    } else {
      await zxing();
      const found = await ZXingWASM.readBarcodes(image, OPTIONS);
      codes = found.filter((r) => r.isValid && r.text).map((r) => {
        const p = r.position;
        return { text: r.text, pts: [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map((q) => [q.x, q.y]) };
      });
    }
    self.postMessage({ type: 'result', id, codes, ms: performance.now() - started, buffer }, [buffer]);
  } catch (e) {
    self.postMessage({ type: 'result', id, codes: [], error: String(e && e.message ? e.message : e), buffer }, [buffer]);
  }
};
