// A small stack navigator: the app has few screens and must behave the same on Android, iPhone and web.
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { BackHandler } from 'react-native';

export type Route =
  | { name: 'day' }
  | { name: 'job'; jobId: string }
  | { name: 'item'; jobId: string; itemId: string }
  | { name: 'signoff'; jobId: string }
  | { name: 'later'; jobId: string }
  | { name: 'scan' }
  | { name: 'fuel' }
  | { name: 'flags' }
  | { name: 'sync' };

interface Nav { route: Route; push(r: Route): void; back(): void; reset(): void }
const Ctx = createContext<Nav | null>(null);

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: 'day' }]);
  const push = useCallback((r: Route) => setStack(s => [...s, r]), []);
  const back = useCallback(() => setStack(s => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const reset = useCallback(() => setStack([{ name: 'day' }]), []);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) { back(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [stack, back]);
  return <Ctx.Provider value={{ route: stack[stack.length - 1], push, back, reset }}>{children}</Ctx.Provider>;
}

export const useNav = () => {
  const n = useContext(Ctx);
  if (!n) throw new Error('useNav outside NavProvider');
  return n;
};
