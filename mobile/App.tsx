import React from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StoreProvider, useStore } from './src/state.tsx';
import { NavProvider, useNav } from './src/nav.tsx';
import { OfficeApp, isOffice } from './src/office/OfficeApp.tsx';
import { QueriesScreen } from './src/screens/QueriesScreen.tsx';
import { MyKitScreen } from './src/screens/MyKitScreen.tsx';
import { MyTimesheetsScreen } from './src/timesheets/Timesheet.tsx';
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
    case 'queries': return <QueriesScreen />;
    case 'kit': return <MyKitScreen />;
    case 'timesheets': return <MyTimesheetsScreen />;
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
  // Admin, Management, Directors and the CEO get the office screen.
  if (isOffice(s.session.user.level)) return <NavProvider key={s.session.user.id}><OfficeApp /></NavProvider>;
  return <NavProvider key={s.session.user.id}><Current /></NavProvider>;
}

/** Someone given extra work on top of their own position (the stockroom, the mechanic's work, or
 *  the CEO, who has everything) switches between their own screens and those here. */
type View3 = 'main' | 'stock' | 'fleet';
const FleetView = React.createContext<{ on: View3; set: (v: View3) => void }>({ on: 'main', set: () => undefined });

function Switchable() {
  const s = useStore();
  const fv = React.useContext(FleetView);
  const ins = useSafeAreaInsets();
  const u = s.session?.user;
  if (!u || s.needsPolicy) return <Root />;
  const views: { k: View3; label: string }[] = [
    { k: 'main', label: isOffice(u.level) ? 'Office' : 'My work' },
    ...(u.stockDuty && u.level !== 'stockroom' ? [{ k: 'stock' as View3, label: 'Stockroom' }] : []),
    ...(u.fleetDuty && u.level !== 'mechanic' ? [{ k: 'fleet' as View3, label: 'Fleet' }] : []),
  ];
  if (views.length < 2) return <Root />;
  const on = views.some(v => v.k === fv.on) ? fv.on : 'main';
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', gap: 6, padding: 6, paddingTop: 6 + (TESTER ? 0 : ins.top), backgroundColor: '#0E1A2B', borderBottomWidth: 1, borderBottomColor: C.line }}>
        {views.map(o => (
          <Pressable key={o.k} onPress={() => fv.set(o.k)} accessibilityRole="tab" accessibilityState={{ selected: on === o.k }}
            style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8, backgroundColor: on === o.k ? '#2E4A73' : 'transparent' }}>
            <Text style={{ color: on === o.k ? '#EAF1FB' : C.quiet, fontWeight: '800' }}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flex: 1 }}>
        {on === 'fleet' ? <NavProvider key={`fleet-${u.id}`}><FleetApp /></NavProvider>
          : on === 'stock' ? <NavProvider key={`stock-${u.id}`}><StockroomApp /></NavProvider> : <Root />}
      </View>
    </View>
  );
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
  const fv = React.useContext(FleetView);
  const narrow = Platform.OS === 'web' && width > 640 && !['stockroom', 'mechanic', 'admin', 'management', 'hr', 'director', 'creator'].includes(s.session?.user.level ?? '') && fv.on === 'main';
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
          <FleetViewProvider><Frame><Switchable /></Frame></FleetViewProvider>
        </View>
        <StatusBar style="light" />
      </StoreProvider>
    </SafeAreaProvider>
  );
}

function FleetViewProvider({ children }: { children: React.ReactNode }) {
  const [on, set] = React.useState<View3>('main');
  return <FleetView.Provider value={{ on, set }}>{children}</FleetView.Provider>;
}
