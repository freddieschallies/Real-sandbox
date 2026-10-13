// Showing a photo by its id: one taken on this phone shows straight away; otherwise it is fetched
// from the office server with the person's own login (never with the login in the address).
import { useEffect, useState } from 'react';
import { useStore } from './state.tsx';

// Photos taken during this visit, kept when someone else signs in on the same screen (the test drive
// switches between people, and the office should still see the technician's photos).
const seen = new Map<string, string>();

export function usePhotoUri(id: string | null | undefined): string | null {
  const s = useStore();
  const local = id ? s.cache.photoUris?.[id] ?? seen.get(id) ?? null : null;
  const [uri, setUri] = useState<string | null>(local);
  useEffect(() => {
    if (!id) { setUri(null); return; }
    if (local) { setUri(local); return; }
    const sess = s.session;
    if (!sess || sess.mode !== 'server') return;
    let gone = false;
    (async () => {
      try {
        const r = await fetch(`${sess.baseUrl.replace(/\/+$/, '')}/photos/${id}`, { headers: { authorization: `Bearer ${sess.token}` } });
        if (!r.ok) return;
        const blob = await r.blob();
        const data = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(blob); });
        if (!gone) setUri(data);
      } catch { /* no signal: show nothing */ }
    })();
    return () => { gone = true; };
  }, [id, local]);
  return uri;
}

/** Remember a photo taken here so it shows at once. */
export function rememberPhoto(s: ReturnType<typeof useStore>, id: string, uri: string) {
  seen.set(id, uri);
  s.patchCache(c => ({ ...c, photoUris: { ...c.photoUris, [id]: uri } }));
}
