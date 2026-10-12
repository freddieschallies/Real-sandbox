// The company's name and logo: in the header of every screen and on letterheads. Each company has
// its own; the CEO sets it under Accounts → Company. Until then the company name shows on its own.
import React, { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { useStore } from './state.tsx';
import { usePhotoUri } from './photo.ts';
import { setTheme, type Accent } from './theme.ts';

type Brand = { name: string; logoPhotoId: string | null; logoDataUri?: string | null; accent?: Accent; canTheme?: boolean };
const cache = new Map<string, Brand>();
const listeners = new Set<() => void>();
let lastLogo: string | null = null;

/** The logo as a data address, for printouts (letterheads). */
export const currentLogo = () => lastLogo;
/** After the CEO changes the logo: everyone shows the new one. */
export function brandChanged() { cache.clear(); listeners.forEach(f => f()); }

export function useBrand(): { name: string; logo: string | null; canTheme: boolean } {
  const s = useStore();
  const key = s.session ? `${s.session.company.id}|${s.session.user.id}` : '';
  const [b, setB] = useState<Brand | null>(cache.get(key) ?? null);
  const [tick, setTick] = useState(0);
  useEffect(() => { const f = () => setTick(t => t + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  useEffect(() => {
    if (!key) return;
    const hit = cache.get(key);
    if (hit) { setB(hit); return; }
    // The company's colour theme comes with the brand.
    s.ask({ method: 'GET', path: '/company/brand' }).then(r => { if (r?.status === 200) { cache.set(key, r.body); setB(r.body); if (r.body.accent) setTheme({ accent: r.body.accent }); } }).catch(() => {});
  }, [key, tick]);
  const fetched = usePhotoUri(b?.logoDataUri ? null : b?.logoPhotoId);
  const logo = b?.logoDataUri ?? fetched;
  if (logo) lastLogo = logo;
  return { name: b?.name ?? s.session?.company.name ?? '', logo, canTheme: !!b?.canTheme };
}

/** The logo on a white tile, for the dark headers. Nothing when there is no logo yet. */
export function BrandLogo({ height = 36 }: { height?: number }) {
  const { logo, name } = useBrand();
  if (!logo) return null;
  return (
    <View style={{ backgroundColor: '#FFFFFF', borderRadius: 6, padding: 3 }}>
      <Image source={{ uri: logo }} style={{ height, width: height * 1.8 }} resizeMode="contain" accessibilityLabel={`${name} logo`} />
    </View>
  );
}
