// Photos are made smaller on the phone before they are kept or sent, so the server is not filled
// with large pictures and uploads work on weak signal. Each kind of picture has its own size:
//   photo     job, vehicle and stock photos: long edge 1600 px, about 150–450 KB
//   document  invoices, slips and delivery notes (read by the office or the invoice reader): 2200 px
//   picture   logos and the letterhead: 2000 px, PNG kept (for see-through logos)
//   profile   a person's picture: 800 px
// The web version (browser and test drive) uses the browser's canvas; the phone app uses
// expo-image-manipulator (see compress.native.ts).
export type PictureKind = 'photo' | 'document' | 'picture' | 'profile';
export interface Profile { maxEdge: number; quality: number; targetBytes: number; keepPng: boolean }
export const PROFILES: Record<PictureKind, Profile> = {
  photo: { maxEdge: 1600, quality: 0.72, targetBytes: 450_000, keepPng: false },
  document: { maxEdge: 2200, quality: 0.8, targetBytes: 900_000, keepPng: false },
  picture: { maxEdge: 2000, quality: 0.85, targetBytes: 800_000, keepPng: true },
  profile: { maxEdge: 800, quality: 0.75, targetBytes: 150_000, keepPng: false },
};
export interface Compressed { uri: string; mime: string; bytes: number | null; width: number | null; height: number | null }

/** The new size for a picture of w × h, keeping its shape, with the long edge at most maxEdge. */
export function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (!long || long <= maxEdge) return { width: w, height: h };
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** The qualities to try, from the profile's down, until the picture is small enough. */
export function qualitySteps(start: number): number[] {
  const out: number[] = [];
  for (let q = start; q >= 0.4 - 1e-9; q -= 0.1) out.push(Math.round(q * 100) / 100);
  return out;
}

