// Making a picture smaller on the phone with expo-image-manipulator: resize so the long edge is
// within the profile, and save as JPEG at the profile's quality (PNG kept for logos).
// Install it in the phone app with: npx expo install expo-image-manipulator
// Until it is installed, the camera's own compression is used (no resizing).
import { PROFILES, fitWithin, type Compressed, type PictureKind } from './compress.ts';

let M: any = null;
try { M = require('expo-image-manipulator'); } catch { M = null; }

export async function compressImage(uri: string, mime: string, kind: PictureKind, size?: { width?: number; height?: number }): Promise<Compressed> {
  const p = PROFILES[kind];
  if (!M?.manipulateAsync) return { uri, mime, bytes: null, width: size?.width ?? null, height: size?.height ?? null };
  try {
    const w = size?.width ?? 0, h = size?.height ?? 0;
    const fit = w && h ? fitWithin(w, h, p.maxEdge) : null;
    const actions = fit && (fit.width !== w || fit.height !== h) ? [{ resize: fit.width >= fit.height ? { width: fit.width } : { height: fit.height } }] : w && h ? [] : [{ resize: { width: p.maxEdge } }];
    const png = p.keepPng && mime === 'image/png';
    const r = await M.manipulateAsync(uri, actions, { compress: p.quality, format: png ? M.SaveFormat.PNG : M.SaveFormat.JPEG });
    return { uri: r.uri, mime: png ? 'image/png' : 'image/jpeg', bytes: null, width: r.width ?? null, height: r.height ?? null };
  } catch {
    return { uri, mime, bytes: null, width: size?.width ?? null, height: size?.height ?? null };
  }
}
