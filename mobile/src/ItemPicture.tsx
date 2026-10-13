// A picture of how something looks (a vehicle, a tool or ladder): shown large with a button to take
// or change it, or small as a thumbnail in lists. Pictures are made smaller before they are sent.
import React, { useState } from 'react';
import { Image, Platform, Text, View } from 'react-native';
import { useStore } from './state.tsx';
import { usePhotoUri, rememberPhoto } from './photo.ts';
import { nowIso, pickImage, takePhoto } from './device.ts';
import { Button, st } from './ui.tsx';
import { C } from './theme.ts';

/** Small square picture for lists (a grey square with an initial when there is none yet). */
export function Thumb({ photoId, label, size = 48 }: { photoId: string | null | undefined; label: string; size?: number }) {
  const uri = usePhotoUri(photoId ?? null);
  return uri
    ? <Image source={{ uri }} style={{ width: size, height: size, borderRadius: 8, backgroundColor: '#000' }} resizeMode="cover" accessibilityLabel={`Picture of ${label}`} />
    : <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: C.panel2, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: C.quiet, fontWeight: '800', fontSize: size / 2.6 }}>{label.slice(0, 1).toUpperCase()}</Text></View>;
}

/** The big picture with "Take a picture" / "Change". save() stores the new photo's id on the item. */
export function ItemPicture({ photoId, kind, label, canEdit, save }: { photoId: string | null | undefined; kind: 'vehicle_profile' | 'tool'; label: string; canEdit: boolean; save: (photoId: string) => Promise<string | null> }) {
  const s = useStore();
  const uri = usePhotoUri(photoId ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const take = async (fromFiles: boolean) => {
    setErr(null);
    const p = fromFiles ? await pickImage('photo') : await takePhoto('photo');
    if (!p) return;
    const id = s.newId();
    rememberPhoto(s, id, p.uri);
    setBusy(true);
    const up = await s.ask({ method: 'POST', path: '/photos', upload: { fields: { kind, takenAt: nowIso(), id }, fileUri: p.uri, mime: p.mime } });
    if (!up || up.status >= 300) { setBusy(false); setErr('The picture could not be sent: try again with signal.'); return; }
    const e = await save(id);
    setBusy(false);
    if (e) setErr(e);
  };
  return (
    <View style={{ gap: 8 }}>
      {uri ? <Image source={{ uri }} style={{ width: '100%', height: 220, borderRadius: 10, backgroundColor: '#000' }} resizeMode="cover" accessibilityLabel={`Picture of ${label}`} />
        : <View style={{ height: 120, borderRadius: 10, backgroundColor: C.panel2, alignItems: 'center', justifyContent: 'center' }}><Text style={st.small}>No picture of {label} yet</Text></View>}
      {canEdit ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Button label={uri ? 'Take a new picture' : 'Take a picture'} kind="secondary" busy={busy} onPress={() => take(false)} style={{ flexGrow: 1 }} />
          {Platform.OS === 'web' ? <Button label="Choose a picture" kind="quiet" onPress={() => take(true)} style={{ flexGrow: 1 }} /> : null}
        </View>
      ) : null}
      {err ? <Text style={[st.small, { color: C.bad }]}>{err}</Text> : null}
    </View>
  );
}
