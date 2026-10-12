import React from 'react';
import { ActivityIndicator, View } from 'react-native';
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
  }
}

function Root() {
  const s = useStore();
  if (!s.ready) return <View style={{ flex: 1, backgroundColor: C.bg, justifyContent: 'center' }}><ActivityIndicator color={C.accent} size="large" /></View>;
  if (!s.session) return <Login />;
  if (s.needsPolicy) return <Policy />;
  // Stock controllers get the stockroom app; everyone else on the phone gets the technician app.
  if (s.session.user.level === 'stockroom') return <NavProvider key={s.session.user.id}><StockroomApp /></NavProvider>;
  return <NavProvider key={s.session.user.id}><Current /></NavProvider>;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          <Root />
        </View>
        <StatusBar style="light" />
      </StoreProvider>
    </SafeAreaProvider>
  );
}
