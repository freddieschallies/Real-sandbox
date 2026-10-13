// Camera and location, used only at the moment the technician taps something.
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import type { PictureKind } from './compress.ts';
// The browser version or the phone version (compressImpl.web.ts / compressImpl.native.ts).
import { compressImage } from './compressImpl';

export interface Photo { uri: string; mime: string; bytes?: number | null }

/** Opens the camera (never the gallery: job photos must be taken now). The photo is made smaller first. */
export async function takePhoto(kind: PictureKind = 'photo'): Promise<Photo | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return null;
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.8 });
  if (r.canceled || !r.assets?.[0]) return null;
  return shrink(r.assets[0], kind);
}

/** Choose a picture that is already on the phone or computer (a logo, a scan). Made smaller first. */
export async function pickImage(kind: PictureKind = 'picture'): Promise<Photo | null> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.9 });
  if (r.canceled || !r.assets?.[0]) return null;
  return shrink(r.assets[0], kind);
}

async function shrink(a: ImagePicker.ImagePickerAsset, kind: PictureKind): Promise<Photo> {
  const mime = a.mimeType && ['image/jpeg', 'image/png', 'image/webp'].includes(a.mimeType) ? a.mimeType : 'image/jpeg';
  const c = await compressImage(a.uri, mime, kind, { width: a.width, height: a.height });
  return { uri: c.uri, mime: c.mime, bytes: c.bytes };
}

/** One position reading, for Arrived. Returns null if the technician refuses or it fails. */
export async function positionNow(): Promise<{ lat: number; lng: number } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return { lat: p.coords.latitude, lng: p.coords.longitude };
  } catch {
    return null;
  }
}

export const nowIso = () => new Date().toISOString();
