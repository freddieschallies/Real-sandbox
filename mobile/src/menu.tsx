// Which tabs this person's position has pinned to the bottom of the phone screen (the CEO or an admin
// chooses under Settings); null = the automatic choice. Fetched once per sign-in.
import { useEffect, useState } from 'react';
import { useStore } from './state.tsx';

type Menu = { pinned: string[] | null; canEdit: boolean };
const cache = new Map<string, Menu>();
const listeners = new Set<() => void>();

/** After the menus were changed: everyone on this phone picks up the new choice. */
export function menuChanged() { cache.clear(); listeners.forEach(f => f()); }

export function usePhoneMenu(): Menu {
  const s = useStore();
  const key = s.session ? `${s.session.company.id}|${s.session.user.id}|${s.session.user.level}` : '';
  const [m, setM] = useState<Menu>(cache.get(key) ?? { pinned: null, canEdit: false });
  const [tick, setTick] = useState(0);
  useEffect(() => { const f = () => setTick(t => t + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  useEffect(() => {
    if (!key) return;
    const hit = cache.get(key);
    if (hit) { setM(hit); return; }
    s.ask({ method: 'GET', path: '/me/phone-menu' }).then(r => {
      if (r?.status === 200) { const v = { pinned: r.body.pinned ?? null, canEdit: !!r.body.canEdit }; cache.set(key, v); setM(v); }
    }).catch(() => {});
  }, [key, tick]);
  return m;
}
