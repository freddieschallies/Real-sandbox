// The app's memory: who is signed in, the day's jobs and job cards (kept on the phone so the app
// works with no signal), and the outbox of changes waiting to be sent.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useNetworkState } from 'expo-network';
import { randomUUID } from 'expo-crypto';
import { load, save, clear } from './storage.ts';
import { HttpTransport } from './http.ts';
import { DemoTransport, seedDemo, type DemoState } from './demo.ts';
import { Outbox, type Blocked, type Entry } from './outbox.ts';
import { Offline, reasonsOf, type Request, type Transport, type Upload } from './transport.ts';
import { apply, J } from './local.ts';
import type { CardView, CatalogueLine, Flag, InventoryLine, JobStockLine, Policy, Session, StockLine, StockRequest, StockReturn, SupplierInvoice, Today } from './types.ts';

const K = { session: 'rs.session', cache: 'rs.cache', outbox: 'rs.outbox', demo: 'rs.demo' };

interface Cache {
  today: Today | null; cards: Record<string, CardView>; stock: StockLine[]; flags: Flag[]; refreshedAt: string | null;
  inventory?: InventoryLine[]; invoices?: SupplierInvoice[]; returns?: StockReturn[]; catalogue?: CatalogueLine[];
  jobStock?: Record<string, JobStockLine[]>;
  requests?: StockRequest[];
  /** The stock controller app's own data. */
  ctl?: unknown;
}
const EMPTY: Cache = { today: null, cards: {}, stock: [], flags: [], refreshedAt: null, inventory: [], invoices: [], returns: [], catalogue: [], jobStock: {} };

export type { Cache };
export type ActionResult = { ok: true } | { ok: false; reasons: string[] };

export interface Store {
  ready: boolean;
  session: Session | null;
  needsPolicy: boolean;
  cache: Cache;
  waiting: number;
  blocked: Blocked | null;
  online: boolean;
  syncing: boolean;
  lastSentAt: string | null;
  demoNoSignal: boolean;
  signIn(mode: 'demo' | 'server', baseUrl: string, email: string, password: string): Promise<ActionResult>;
  signOut(): Promise<void>;
  policy(): Promise<Policy | null>;
  acknowledge(policyId: string): Promise<ActionResult>;
  refresh(): Promise<void>;
  loadCard(jobId: string): Promise<void>;
  /** A job card action: checked on the phone with the shared rules, then queued for the server. */
  jobAction(jobId: string, label: string, rule: (c: J.JobCard) => J.Result, req: Omit<Request, 'idemKey'>, after?: (v: CardView) => CardView): ActionResult;
  /** Anything else (vehicle scan, fuel, flag answers): queued for the server. */
  queue(label: string, req: Omit<Request, 'idemKey'>, jobId?: string): void;
  newId(): string;
  /** A one-off question to the server that is only useful with signal. Null when offline. */
  ask(req: Omit<Request, 'idemKey'>): Promise<{ status: number; body: any } | null>;
  /** Updates the day on the phone straight away (e.g. the vehicle he just scanned into). */
  patchToday(fn: (t: Today) => Today): void;
  /** Changes what the phone holds straight away (an invoice just scanned, a return just sent). */
  patchCache(fn: (c: Cache) => Cache): void;
  /** Keeps the van stock on the phone honest after materials are used offline. */
  adjustStock(stockItemId: string, delta: number): void;
  syncNow(): Promise<void>;
  discardBlocked(): Promise<void>;
  setDemoNoSignal(v: boolean): void;
}

const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
};

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [needsPolicy, setNeedsPolicy] = useState(false);
  const [cache, setCache] = useState<Cache>(EMPTY);
  const [tick, setTick] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [demoNoSignal, setDemoNoSignalState] = useState(false);
  const net = useNetworkState();

  const sessionRef = useRef<Session | null>(null);
  const cacheRef = useRef<Cache>(EMPTY);
  const demoRef = useRef<DemoTransport | null>(null);
  const httpRef = useRef<HttpTransport | null>(null);

  const transport = useCallback((): Transport => {
    const s = sessionRef.current;
    if (s?.mode === 'demo' && demoRef.current) return demoRef.current;
    if (!httpRef.current) httpRef.current = new HttpTransport(s?.baseUrl ?? '');
    return httpRef.current;
  }, []);

  const outbox = useMemo(() => new Outbox(transport, () => sessionRef.current?.token, o => save(K.outbox, o), () => setTick(t => t + 1)), [transport]);

  const setCacheAndSave = useCallback((fn: (c: Cache) => Cache) => {
    setCache(prev => {
      const next = fn(prev);
      cacheRef.current = next;
      save(K.cache, next);
      return next;
    });
  }, []);

  // Start-up: restore everything from the phone.
  useEffect(() => {
    (async () => {
      const s = await load<Session | null>(K.session, null);
      const demo = await load<DemoState | null>(K.demo, null);
      demoRef.current = new DemoTransport(demo ?? seedDemo(), st => save(K.demo, st));
      if (s?.mode === 'server') httpRef.current = new HttpTransport(s.baseUrl);
      sessionRef.current = s;
      setSession(s);
      const c = await load<Cache>(K.cache, EMPTY);
      cacheRef.current = c;
      setCache(c);
      outbox.restore(await load(K.outbox, { entries: [], blocked: null, lastSentAt: null }));
      setReady(true);
    })();
  }, [outbox]);

  const call = useCallback(async (req: Request) => transport().send(req, sessionRef.current?.token), [transport]);

  const refresh = useCallback(async () => {
    if (!sessionRef.current) return;
    try {
      if (outbox.waiting) return; // send what's waiting first; refresh after
      const t = await call({ method: 'GET', path: '/me/today' });
      if (t.status === 403 && t.body?.code === 'policy_required') { setNeedsPolicy(true); return; }
      if (t.status === 401) { setSession(null); sessionRef.current = null; await clear([K.session]); return; }
      if (t.status !== 200) return;
      const today = t.body as Today;
      const cards: Record<string, CardView> = {};
      for (const j of today.jobs) {
        const r = await call({ method: 'GET', path: `/jobs/${j.id}` });
        if (r.status === 200) cards[j.id] = r.body;
      }
      const get = async <T,>(path: string, keep: T): Promise<T> => { const r = await call({ method: 'GET', path }); return r.status === 200 ? r.body as T : keep; };
      const prev = cacheRef.current;
      const jobStock: Record<string, JobStockLine[]> = {};
      for (const j of today.jobs) jobStock[j.id] = await get(`/jobs/${j.id}/stock`, prev.jobStock?.[j.id] ?? []);
      const stock = await get('/me/stock', prev.stock);
      const flags = await get('/me/flags', prev.flags);
      const inventory = await get('/me/inventory', prev.inventory ?? []);
      const invoices = await get<SupplierInvoice[]>('/me/supplier-invoices', prev.invoices ?? []);
      const returns = await get('/me/returns', prev.returns ?? []);
      const catalogue = await get('/stock/catalogue', prev.catalogue ?? []);
      const requests = await get('/me/stock-requests', prev.requests ?? []);
      setCacheAndSave(c => ({
        ...c, today, cards, stock, flags, inventory, returns, catalogue, jobStock, requests,
        invoices: invoices.map(i => ({ ...i, localPhotoUri: prev.invoices?.find(x => x.id === i.id)?.localPhotoUri })),
        refreshedAt: new Date().toISOString(),
      }));
    } catch (e) {
      if (!(e instanceof Offline)) throw e;
    }
  }, [call, outbox, setCacheAndSave]);

  const syncNow = useCallback(async () => {
    if (!sessionRef.current) return;
    setSyncing(true);
    try {
      const r = await outbox.flush();
      if (r === 'signed_out') { setSession(null); sessionRef.current = null; await clear([K.session]); return; }
      if (r === 'done') await refresh();
    } finally {
      setSyncing(false);
    }
  }, [outbox, refresh]);

  // Send whenever signal returns, the app comes back to the front, and every 20 seconds while work is waiting.
  useEffect(() => { if (net.isConnected) syncNow(); }, [net.isConnected, syncNow]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => { if (s === 'active') syncNow(); });
    const timer = setInterval(() => { if (outbox.waiting) syncNow(); }, 20_000);
    return () => { sub.remove(); clearInterval(timer); };
  }, [outbox, syncNow]);

  const signIn = useCallback(async (mode: 'demo' | 'server', baseUrl: string, email: string, password: string): Promise<ActionResult> => {
    httpRef.current = mode === 'server' ? new HttpTransport(baseUrl) : null;
    sessionRef.current = { mode, baseUrl, token: '', user: { id: '', name: '', level: '' }, company: { id: '', name: '' } };
    try {
      const r = await transport().send({ method: 'POST', path: '/auth/login', json: { email, password } });
      if (r.status !== 200) { sessionRef.current = null; return { ok: false, reasons: reasonsOf(r) }; }
      const s: Session = { mode, baseUrl, token: r.body.token, user: r.body.user, company: r.body.company };
      if (s.user.level !== 'technician') {
        // The phone app is the technician's tool; office logins use the control base.
      }
      sessionRef.current = s;
      setSession(s);
      await save(K.session, s);
      setCacheAndSave(() => EMPTY);
      outbox.clearAll();
      await refresh();
      return { ok: true };
    } catch (e) {
      sessionRef.current = null;
      if (e instanceof Offline) return { ok: false, reasons: ['No connection to the server. Signing in needs signal.'] };
      throw e;
    }
  }, [outbox, refresh, setCacheAndSave, transport]);

  const signOut = useCallback(async () => {
    sessionRef.current = null;
    setSession(null);
    setNeedsPolicy(false);
    setCacheAndSave(() => EMPTY);
    await clear([K.session]);
  }, [setCacheAndSave]);

  const policy = useCallback(async () => {
    try {
      const r = await call({ method: 'GET', path: '/policy/current' });
      return r.status === 200 ? (r.body as Policy) : null;
    } catch { return null; }
  }, [call]);

  const acknowledge = useCallback(async (policyId: string): Promise<ActionResult> => {
    try {
      const r = await call({ method: 'POST', path: '/policy/acknowledge', json: { policyVersionId: policyId } });
      if (r.status !== 200) return { ok: false, reasons: reasonsOf(r) };
      setNeedsPolicy(false);
      await refresh();
      return { ok: true };
    } catch {
      return { ok: false, reasons: ['No connection. Acknowledging the policy needs signal.'] };
    }
  }, [call, refresh]);

  const loadCard = useCallback(async (jobId: string) => {
    if (outbox.entries.some(e => e.jobId === jobId)) return; // local copy is newer until sent
    try {
      const r = await call({ method: 'GET', path: `/jobs/${jobId}` });
      if (r.status === 200) setCacheAndSave(c => ({ ...c, cards: { ...c.cards, [jobId]: r.body } }));
    } catch { /* offline: keep the copy on the phone */ }
  }, [call, outbox, setCacheAndSave]);

  const queue = useCallback((label: string, req: Omit<Request, 'idemKey'>, jobId?: string) => {
    outbox.add({ ...req, id: randomUUID(), label, jobId });
    syncNow();
  }, [outbox, syncNow]);

  const jobAction = useCallback((jobId: string, label: string, rule: (c: J.JobCard) => J.Result, req: Omit<Request, 'idemKey'>, after?: (v: CardView) => CardView): ActionResult => {
    const view = cacheRef.current.cards[jobId];
    if (!view) return { ok: false, reasons: ['this job card is not on the phone yet; pull down to refresh with signal'] };
    const r = apply(view, rule);
    if (!r.ok) return r;
    const next = after ? after(r.view) : r.view;
    setCacheAndSave(c => ({
      ...c,
      cards: { ...c.cards, [jobId]: next },
      today: c.today ? { ...c.today, jobs: c.today.jobs.map(j => (j.id === jobId ? { ...j, status: next.status } : j)) } : c.today,
    }));
    queue(label, req, jobId);
    return { ok: true };
  }, [queue, setCacheAndSave]);

  const ask = useCallback(async (req: Omit<Request, 'idemKey'>) => {
    try { return await call(req); } catch (e) { if (e instanceof Offline) return null; throw e; }
  }, [call]);

  const patchToday = useCallback((fn: (t: Today) => Today) => {
    setCacheAndSave(c => ({ ...c, today: c.today ? fn(c.today) : c.today }));
  }, [setCacheAndSave]);

  const patchCache = useCallback((fn: (c: Cache) => Cache) => setCacheAndSave(fn), [setCacheAndSave]);

  const adjustStock = useCallback((stockItemId: string, delta: number) => {
    setCacheAndSave(c => ({ ...c, stock: c.stock.map(l => (l.id === stockItemId ? { ...l, qty: l.qty + delta } : l)) }));
  }, [setCacheAndSave]);

  const discardBlocked = useCallback(async () => {
    const removed = outbox.discardBlocked();
    const jobIds = new Set(removed.map((e: Entry) => e.jobId).filter(Boolean) as string[]);
    for (const j of jobIds) await loadCard(j);
    await syncNow();
  }, [loadCard, outbox, syncNow]);

  const setDemoNoSignal = useCallback((v: boolean) => {
    if (demoRef.current) demoRef.current.noSignal = v;
    setDemoNoSignalState(v);
    if (!v) syncNow();
  }, [syncNow]);

  void tick;
  const value: Store = {
    ready, session, needsPolicy, cache,
    waiting: outbox.waiting, blocked: outbox.blocked, lastSentAt: outbox.lastSentAt,
    online: session?.mode === 'demo' ? !demoNoSignal : net.isConnected !== false,
    syncing, demoNoSignal,
    signIn, signOut, policy, acknowledge, refresh, loadCard, jobAction, queue,
    newId: randomUUID, ask, patchToday, patchCache, adjustStock, syncNow, discardBlocked, setDemoNoSignal,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export type { Upload };
