// The stock controller's data: requests to issue, returns to receive, the stockroom, new items.
// Loaded when there is signal and kept on the device; actions go through the same outbox as the technician app.
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../state.tsx';
import { nowIso, takePhoto } from '../device.ts';
import type { StockRequest, StockReturn } from '../types.ts';

export interface RoomItem { id: string; code: string; description: string; unit: string; needsReview: boolean; supplierCode: string | null; inStockroom: number; withTechnicians: number }
export interface Overview { toIssue: number; toReceive: number; newItems: number; invoicesToday: number }
export interface BookedInvoice { id: string; technician?: string; job_number?: number | null; supplier_name: string | null; invoice_number: string | null; total_cents: number | null; confirmed_at: string | null; changed_from_read?: boolean; lines?: { description: string; qty: number; unitPriceCents: number | null }[] | null }

export interface Holding { technicianId: string; technician: string; stockItemId: string; code: string; description: string; unit: string; holdingJobId: string | null; jobNumber: number | null; jobStatus: string | null; store: string | null; qty: number; pendingReturn: number; mustReturn: boolean }
export interface Activity { id: string; at: string; kind: string; what: string; qty: number; code: string; description: string; unit: string; technician: string | null; by: string; jobNumber: number | null; store: string | null; unitCostCents: number | null; reference: string | null }

export interface Ctl {
  issues: StockRequest[]; returns: StockReturn[]; room: RoomItem[]; invoices: BookedInvoice[]; overview: Overview | null; loadedAt: string | null;
  holdings?: Holding[]; activity?: Activity[]; seenActivityAt?: string | null; issued?: StockRequest[];
}
const EMPTY: Ctl = { issues: [], returns: [], room: [], invoices: [], overview: null, loadedAt: null, holdings: [], activity: [], seenActivityAt: null };

export function useStockroom() {
  const s = useStore();
  const [ctl, setCtl] = useState<Ctl>(() => ((s.cache.ctl as Ctl | undefined) ?? EMPTY));
  const [loading, setLoading] = useState(false);

  const save = useCallback((fn: (c: Ctl) => Ctl) => {
    setCtl(prev => {
      const next = fn(prev);
      s.patchCache(c => ({ ...c, ctl: next }));
      return next;
    });
  }, [s]);

  const load = useCallback(async () => {
    if (s.waiting) { await s.syncNow(); if (s.waiting) return; }
    setLoading(true);
    try {
      const get = async <T,>(path: string): Promise<T | null> => { const r = await s.ask({ method: 'GET', path }); return r && r.status === 200 ? r.body as T : null; };
      const [issues, returns, room, invoices, overview, holdings, activity, issued] = await Promise.all([
        get<StockRequest[]>('/stock/issues?status=pending'), get<StockReturn[]>('/stock/returns?status=pending'),
        get<RoomItem[]>('/stock/stockroom'), get<BookedInvoice[]>('/stock/invoices'), get<Overview>('/stock/overview'),
        get<Holding[]>('/stock/holdings'), get<Activity[]>('/stock/activity?limit=150'), get<StockRequest[]>('/stock/issues?status=issued'),
      ]);
      if (issues === null && returns === null) return;   // no signal: keep what we have
      save(c => ({
        issues: issues ?? c.issues, returns: returns ?? c.returns, room: room ?? c.room, invoices: invoices ?? c.invoices,
        overview: overview ?? c.overview, loadedAt: new Date().toISOString(),
        holdings: holdings ?? c.holdings, activity: activity ?? c.activity, issued: issued ?? c.issued, seenActivityAt: c.seenActivityAt ?? activity?.[0]?.at ?? null,
      }));
    } finally {
      setLoading(false);
    }
  }, [s, save]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);   // "live": what the technicians do shows within seconds
    return () => clearInterval(t);
  }, []);

  /** Optional photo of an item: taken now, uploaded with the action. */
  const photo = useCallback(async () => {
    const p = await takePhoto();
    if (!p) return null;
    return { id: s.newId(), uri: p.uri, mime: p.mime };
  }, [s]);

  const uploadPhoto = (label: string, kind: string, p: { id: string; uri: string; mime: string }) =>
    s.queue(label, { method: 'POST', path: '/photos', upload: { fields: { kind, takenAt: nowIso(), id: p.id }, fileUri: p.uri, mime: p.mime } });

  const issue = (r: StockRequest, qty: Record<string, number>, photos: Record<string, { id: string; uri: string; mime: string }>, note?: string) => {
    for (const p of Object.values(photos)) uploadPhoto(`Photo for request #${r.job_number}`, 'stock_item', p);
    s.queue(`Issued stock to ${r.technician} for #${r.job_number}`, {
      method: 'POST', path: `/stock/issues/${r.id}/issue`,
      json: { at: nowIso(), note, lines: r.lines.map(l => ({ lineId: l.lineId, qtyIssued: qty[l.lineId] ?? 0, photoId: photos[l.lineId]?.id })) },
    });
    const done: StockRequest = { ...r, status: 'issued', decided_at: nowIso(), decided_by: s.session?.user.name ?? null, note: note ?? null,
      lines: r.lines.map(l => ({ ...l, qtyIssued: qty[l.lineId] ?? 0 })) };
    save(c => ({
      ...c, issues: c.issues.filter(x => x.id !== r.id), issued: [done, ...(c.issued ?? [])],
      room: c.room.map(i => ({ ...i, inStockroom: i.inStockroom - r.lines.filter(l => l.stockItemId === i.id).reduce((n, l) => n + (qty[l.lineId] ?? 0), 0) })),
      overview: c.overview ? { ...c.overview, toIssue: Math.max(0, c.overview.toIssue - 1) } : c.overview,
    }));
  };

  const reject = (r: StockRequest, reason: string) => {
    s.queue(`Rejected stock request #${r.job_number}`, { method: 'POST', path: `/stock/issues/${r.id}/reject`, json: { at: nowIso(), reason } });
    save(c => ({ ...c, issues: c.issues.filter(x => x.id !== r.id), overview: c.overview ? { ...c.overview, toIssue: Math.max(0, c.overview.toIssue - 1) } : c.overview }));
  };

  const receive = (r: StockReturn, qty: Record<string, number>, photos: Record<string, { id: string; uri: string; mime: string }>, note?: string) => {
    for (const p of Object.values(photos)) uploadPhoto(`Photo for return from ${r.technician ?? 'technician'}`, 'stock_item', p);
    s.queue(`Received return from ${r.technician ?? 'technician'}`, {
      method: 'POST', path: `/stock/returns/${r.id}/receive`,
      json: { note, lines: r.lines.map(l => ({ lineId: l.lineId, qtyReceived: qty[l.lineId] ?? 0, photoId: photos[l.lineId]?.id })) },
    });
    save(c => ({
      ...c, returns: c.returns.filter(x => x.id !== r.id),
      room: c.room.map(i => ({ ...i, inStockroom: i.inStockroom + r.lines.filter(l => l.stockItemId === i.id).reduce((n, l) => n + (qty[l.lineId] ?? 0), 0) })),
      overview: c.overview ? { ...c.overview, toReceive: Math.max(0, c.overview.toReceive - 1) } : c.overview,
    }));
  };

  const nameItem = (it: RoomItem, b: { code: string; description: string; unit: string }) => {
    s.queue(`Named ${it.code} as ${b.code}`, { method: 'PATCH', path: `/stock/items/${it.id}`, json: b });
    save(c => ({ ...c, room: c.room.map(i => (i.id === it.id ? { ...i, ...b, needsReview: false } : i)),
      overview: c.overview ? { ...c.overview, newItems: Math.max(0, c.overview.newItems - 1) } : c.overview }));
  };

  const delivery = (b: { supplierName: string; reference: string; lines: { stockItemId: string; qty: number }[] }, note?: { id: string; uri: string; mime: string } | null) => {
    if (note) uploadPhoto(`Delivery note ${b.reference}`, 'delivery_note', note);
    s.queue(`Delivery ${b.reference} from ${b.supplierName}`, { method: 'POST', path: '/stock/deliveries', json: { ...b, id: s.newId(), at: nowIso(), photoId: note?.id } });
    save(c => ({ ...c, room: c.room.map(i => ({ ...i, inStockroom: i.inStockroom + b.lines.filter(l => l.stockItemId === i.id).reduce((n, l) => n + l.qty, 0) })) }));
  };

  const seenActivity = () => save(c => ({ ...c, seenActivityAt: c.activity?.[0]?.at ?? c.seenActivityAt ?? null }));

  return { ctl, loading, load, seenActivity, photo, issue, reject, receive, nameItem, delivery };
}
