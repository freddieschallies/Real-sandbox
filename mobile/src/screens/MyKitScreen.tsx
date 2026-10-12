// The technician's own tools and PPE, as the stockroom has them on his name.
import React from 'react';
import { useNav } from '../nav.tsx';
import { useStore } from '../state.tsx';
import { Screen } from '../ui.tsx';
import { KitCard } from '../staff/Staff.tsx';

export function MyKitScreen() {
  const nav = useNav();
  const s = useStore();
  const me = s.session?.user;
  return (
    <Screen title="My tools and PPE" onBack={nav.back}>
      <KitCard userId={me?.id ?? ''} name={me?.name ?? ''} mine />
    </Screen>
  );
}
