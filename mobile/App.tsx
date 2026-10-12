import React from 'react';
import { ActivityIndicator, Platform, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StoreProvider, useStore } from './src/state.tsx';
import { NavProvider, useNav } from './src/nav.tsx';
import { Login } from './src/screens/Login.tsx';
import { Policy } from './src/screens/Policy.tsx';
import { Day } from './src/screens/Day.tsx';
import { Job } from './src/screens/Job.tsx';
import { Item } from './src/screens/Item.tsx';
import { SignOff } from './src/screens/SignOff.tsx';
import { Later } from './src/screens/Later.tsx';
import { Scan } from './src/screens/Scan.tsx';
import { Fuel } from './src/screens/Fuel.tsx';
import { Flags } from './src/screens/Flags.tsx';
import { Sync } from './src/screens/Sync.tsx';
import { MyStock } from './src/screens/MyStock.tsx';
import { Invoice } from './src/screens/Invoice.tsx';
import { BookOut } from './src/screens/BookOut.tsx';
import { Return } from './src/screens/Return.tsx';
import { StockroomApp } from './src/stockroom/StockroomApp.tsx';
import { TesterWelcome } from './src/screens/TesterWelcome.tsx';
import { FleetApp } from './src/fleet/FleetApp.tsx';
import { VehicleFault } from './src/screens/VehicleFault.tsx';
import { Release } from './src/screens/Release.tsx';
import { TesterBar } from './src/screens/TesterBar.tsx';
import { C } from './src/theme.ts';

function Current() {
  const { route } = useNav();
  switch (route.name) {
    case 'day': return <Day />;
    case 'job': return <Job jobId={route.jobId} />;
    case 'item': return <Item jobId={route.jobId} itemId={route.itemId} />;
    case 'signoff': return <SignOff jobId={route.jobId} />;
    case 'later': return <Later jobId={route.jobId} />;
    case 'scan': return <Scan />;
    case 'fuel': return <Fuel />;
    case 'flags': return <Flags />;
    case 'sync': return <Sync />;
    case 'stock': return <MyStock />;
    case 'invoice': return <Invoice key={route.invoiceId ?? 'new'} invoiceId={route.invoiceId} jobId={route.jobId} />;
    case 'bookout': return <BookOut jobId={route.jobId} />;
    case 'return': return <Return />;
    case 'fault': return <VehicleFault />;
    case 'release': return <Release />;
  }
}

function Root() {
  const s = useStore();
  if (!s.ready) return <View style={{ flex: 1, backgroundColor: C.bg, justifyContent: 'center' }}><ActivityIndicator color={C.accent} size="large" /></View>;
  if (!s.session) return TESTER ? <TesterWelcome /> : <Login />;
  if (s.needsPolicy) return <Policy />;
  // Stock controllers get the stockroom app; everyone else on the phone gets the technician app.
  if (s.session.user.level === 'stockroom') return <NavProvider key={s.session.user.id}><StockroomApp /></NavProvider>;
  // Mechanics get the fleet app.
  if (s.session.user.level === 'mechanic') return <NavProvider key={s.session.user.id}><FleetApp /></NavProvider>;
  return <NavProvider key={s.session.user.id}><Current /></NavProvider>;
}

/** Test build only: the bar to switch between the three apps, shown once someone is in. */
function TesterBarSlot() {
  const s = useStore();
  return s.session && !s.needsPolicy ? <TesterBar /> : null;
}

/** The shared test build: demo only, with a short guide instead of the sign-in screen. */
const TESTER = process.env.EXPO_PUBLIC_TESTER === '1';

/** In a browser on a big screen the technician app keeps phone width, like it will look on a phone. */
function Frame({ children }: { children: React.ReactNode }) {
  const s = useStore();
  const { width } = useWindowDimensions();
  const narrow = Platform.OS === 'web' && width > 640 && !['stockroom', 'mechanic'].includes(s.session?.user.level ?? '');
  if (!narrow) return <>{children}</>;
  return (
    <View style={{ flex: 1, alignItems: 'center', backgroundColor: '#101214' }}>
      <View style={{ flex: 1, width: 440, borderLeftWidth: 1, borderRightWidth: 1, borderColor: C.line, overflow: 'hidden' }}>{children}</View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          {TESTER ? <TesterBarSlot /> : null}
          <Frame><Root /></Frame>
        </View>
        <StatusBar style="light" />
      </StoreProvider>
    </SafeAreaProvider>
  );
}
