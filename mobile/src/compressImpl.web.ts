// Making a picture smaller in the browser: draw it smaller on a canvas and save it as JPEG (or
// PNG for logos), lowering the quality step by step until it is under the profile's size.
import { PROFILES, fitWithin, qualitySteps, type Compressed, type PictureKind } from './compress.ts';

const load = (uri: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = uri; });
const toBlob = (c: HTMLCanvasElement, mime: string, q?: number) => new Promise<Blob | null>(res => c.toBlob(res, mime, q));
const toDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(b); });

export async function compressImage(uri: string, mime: string, kind: PictureKind, _size?: { width?: number; height?: number }): Promise<Compressed> {
  const p = PROFILES[kind];
  try {
    const original = await (await fetch(uri)).blob();
    const img = await load(uri);
    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, p.maxEdge);
    const png = p.keepPng && mime === 'image/png';
    // Already small and not too big on screen: keep it as it is.
    if (width === img.naturalWidth && original.size <= p.targetBytes) return { uri, mime, bytes: original.size, width, height };
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const g = c.getContext('2d');
    if (!g) return { uri, mime, bytes: original.size, width: img.naturalWidth, height: img.naturalHeight };
    if (!png) { g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, width, height); } // JPEG has no see-through
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, width, height);
    let best: Blob | null = null;
    if (png) best = await toBlob(c, 'image/png');
    else {
      for (const q of qualitySteps(p.quality)) {
        best = await toBlob(c, 'image/jpeg', q);
        if (best && best.size <= p.targetBytes) break;
      }
    }
    // Keep the original only when it did not need making smaller on screen and is smaller in bytes.
    const resized = width !== img.naturalWidth || height !== img.naturalHeight;
    if (!best || (!resized && best.size >= original.size)) return { uri, mime, bytes: original.size, width: img.naturalWidth, height: img.naturalHeight };
    return { uri: await toDataUrl(best), mime: png ? 'image/png' : 'image/jpeg', bytes: best.size, width, height };
  } catch {
    return { uri, mime, bytes: null, width: null, height: null }; // could not read it: send as it is
  }
}
