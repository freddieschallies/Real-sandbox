// A department's logo (HR sets it with the name), or its initials until there is one. Shows wherever
// the department does, so a change shows everywhere.
import React from 'react';
import { Image, Text, View } from 'react-native';
import { usePhotoUri } from '../photo.ts';
import { C } from '../theme.ts';

export function DeptLogo({ name, photoId, size = 36 }: { name: string; photoId?: string | null; size?: number }) {
  const uri = usePhotoUri(photoId ?? null);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('');
  if (uri) {
    return (
      <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: '#FFFFFF', padding: 2, overflow: 'hidden' }}>
        <Image source={{ uri }} style={{ width: size - 4, height: size - 4 }} resizeMode="contain" accessibilityLabel={`${name} logo`} />
      </View>
    );
  }
  return (
    <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: C.quiet, fontWeight: '800', fontSize: size * 0.36 }}>{initials}</Text>
    </View>
  );
}
