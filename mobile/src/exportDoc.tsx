// Export any document the app makes, the same way everywhere: a PDF to download (or open on a phone),
// WhatsApp (a link the client taps to view and print, for a week), email with the PDF attached, and
// print. The page is the printed one (on the letterhead); pictures are put inside it first. The server
// keeps every exported document as it went out (server routes/exports.ts).
import React, { useRef, useState } from 'react';
import { Linking, Platform, Share, Text, View } from 'react-native';
import { useStore } from './state.tsx';
import { Button, Field, st } from './ui.tsx';
import { C } from './theme.ts';

export type ExportKind = 'job_card' | 'quote' | 'invoice' | 'credit_note' | 'statement' | 'purchase_order' | 'timesheet' | 'site_report' | 'stock_take'
  | 'price_list' | 'profit' | 'debtors' | 'crew' | 'report' | 'other';
export interface ExportDoc { kind: ExportKind; title: string; ref?: string; html: string }
type Made = { id: string; fileName: string; pdf: boolean; email: boolean; linkDays: number; title?: string; storeEmail?: string | null; phone?: string | null; /** test drive */ html?: string };

const reasons = (r: { status: number; body: any } | null) => (r ? (r.body?.reasons ?? [r.body?.error ?? `The server said ${r.status}`]) : ['No signal: try again when there is signal.']) as string[];
/** A South African number for WhatsApp: 082 123 4567 → 27821234567. */
export const waNumber = (p?: string | null) => {
  const d = (p ?? '').replace(/\D/g, '');
  return d.length === 10 && d.startsWith('0') ? `27${d.slice(1)}` : d.length >= 11 ? d : '';
};

/** Opens the page in a new window to print or save as PDF (a computer's browser). */
export function printPage(html: string): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html); w.document.close();
  return true;
}

/** Every picture inside the page itself, so the PDF and the link show them without signing in. */
async function inlineImages(html: string): Promise<string> {
  const srcs = [...new Set([...html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*"([^"]+)"/gi)].map(m => m[1]).filter(u => !u.startsWith('data:')))];
  let out = html;
  for (const u of srcs) {
    try {
      const blob = await (await fetch(u)).blob();
      const data = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(blob); });
      out = out.split(`"${u}"`).join(`"${data}"`);
    } catch { /* left out of the export */ }
  }
  return out;
}

/** The export buttons for one document. `make` builds the printed page when a button is tapped. */
export function ExportBar({ make, server, email, phone, title = 'Export', noEmail, onSent }: {
  make?: () => ExportDoc | null | Promise<ExportDoc | null>;
  /** Documents the server makes itself (the job card, with its photos): the path that makes it. */ server?: string; email?: string | null; phone?: string | null; title?: string;
  /** Where the document has its own email (e.g. statements, kept with the customer). */ noEmail?: boolean;
  /** Told when it went out (e.g. a purchase order is then marked sent). */ onSent?: (how: 'whatsapp' | 'email' | 'pdf') => void;
}) {
  const s = useStore();
  const demo = s.session?.mode !== 'server';
  const made = useRef<{ html: string; m: Made } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [to, setTo] = useState(email ?? '');
  const [note, setNote] = useState('');

  /** Sends the page to the server once (again only if it changed). */
  const prepare = async (): Promise<{ doc: ExportDoc; m: Made } | null> => {
    if (server) {
      if (made.current?.html === server) { const m = made.current.m; return { doc: { kind: 'job_card', title: m.title ?? 'Document', html: m.html ?? '' }, m }; }
      const r = await s.ask({ method: 'POST', path: server }).catch(() => null);
      if (!r || r.status !== 201) { setMsg({ tone: 'bad', text: reasons(r).join(' ') }); return null; }
      const m = r.body as Made;
      if (m.storeEmail && !to) setTo(m.storeEmail);
      made.current = { html: server, m };
      return { doc: { kind: 'job_card', title: m.title ?? 'Document', html: m.html ?? '' }, m };
    }
    const d = await make?.();
    if (!d) { setMsg({ tone: 'bad', text: 'Nothing to export yet.' }); return null; }
    if (made.current?.html === d.html) return { doc: d, m: made.current.m };
    const html = await inlineImages(d.html);
    const r = await s.ask({ method: 'POST', path: '/exports', json: { kind: d.kind, title: d.title, ref: d.ref, html } }).catch(() => null);
    if (!r || r.status !== 201) { setMsg({ tone: 'bad', text: reasons(r).join(' ') }); return null; }
    made.current = { html: d.html, m: r.body as Made };
    return { doc: { ...d, html }, m: r.body as Made };
  };
  const link = async (id: string) => {
    const r = await s.ask({ method: 'POST', path: `/exports/${id}/link` }).catch(() => null);
    if (r?.status !== 200) { setMsg({ tone: 'bad', text: reasons(r).join(' ') }); return null; }
    return r.body as { url: string; message: string };
  };
  const run = (what: string, f: () => Promise<void>) => async () => { setBusy(what); setMsg(null); try { await f(); } finally { setBusy(null); } };

  const pdf = run('pdf', async () => {
    const p = await prepare();
    if (!p) return;
    if (demo) {
      if (!printPage(p.doc.html)) setMsg({ tone: 'bad', text: 'The browser blocked the window: allow pop-ups for this page.' });
      else setMsg({ tone: 'info', text: 'Test drive: the page opened to save as PDF. In the real app the PDF downloads straight away.' });
      return;
    }
    if (Platform.OS === 'web') {
      const sess = s.session!;
      const r = await fetch(`${sess.baseUrl.replace(/\/+$/, '')}/exports/${p.m.id}/file`, { headers: { authorization: `Bearer ${sess.token}` } }).catch(() => null);
      if (!r?.ok) { setMsg({ tone: 'bad', text: 'Could not download it: needs signal.' }); return; }
      const u = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = u; a.download = p.m.fileName; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setMsg({ tone: 'good', text: `Downloaded: ${p.m.fileName}` }); onSent?.('pdf');
      return;
    }
    // On a phone the PDF opens in the browser, which saves, prints or shares it.
    const l = await link(p.m.id);
    if (l) Linking.openURL(l.url).catch(() => setMsg({ tone: 'bad', text: 'Could not open the browser.' }));
  });

  const whatsapp = run('wa', async () => {
    const p = await prepare();
    if (!p) return;
    const l = await link(p.m.id);
    if (!l) return;
    if (demo) { setMsg({ tone: 'info', text: `Test drive: in the real app WhatsApp opens${waNumber(phone) ? ` to ${phone}` : ''} with a link to this ${p.m.pdf ? 'PDF' : 'document'}; the client taps it to open, save or print it (for ${p.m.linkDays} days).` }); return; }
    const n = waNumber(phone ?? p.m.phone);
    Linking.openURL(`https://wa.me/${n}?text=${encodeURIComponent(l.message)}`).then(() => onSent?.('whatsapp')).catch(() => setMsg({ tone: 'bad', text: 'WhatsApp did not open: use Share instead.' }));
  });

  const share = run('share', async () => {
    const p = await prepare();
    if (!p) return;
    const l = await link(p.m.id);
    if (!l) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(l.message); setMsg({ tone: 'good', text: 'The link is copied: paste it in any message.' }); }
      else await Share.share({ message: l.message });
    } catch { setMsg({ tone: 'bad', text: 'Could not share: try WhatsApp or email.' }); }
  });

  const send = run('email', async () => {
    const list = to.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
    if (!list.length) { setMsg({ tone: 'bad', text: 'Type the email address.' }); return; }
    const p = await prepare();
    if (!p) return;
    const r = await s.ask({ method: 'POST', path: `/exports/${p.m.id}/email`, json: { to: list, message: note.trim() || undefined } }).catch(() => null);
    if (r && r.status < 300) { setEmailing(false); onSent?.('email'); setMsg({ tone: 'good', text: `Emailed to ${list.join(', ')}${(r.body as { demo?: boolean }).demo ? ' (test drive: no email really goes out)' : ''}.` }); }
    else setMsg({ tone: 'bad', text: reasons(r).join(' ') });
  });

  const print = run('print', async () => {
    const d = await make?.();
    if (d && !printPage(d.html)) setMsg({ tone: 'bad', text: 'The browser blocked the print window: allow pop-ups for this page.' });
  });

  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: C.panel }} accessibilityLabel={title}>
      <Text style={[st.small, { fontWeight: '800', letterSpacing: 0.5 }]}>{title.toUpperCase()}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button label={Platform.OS === 'web' ? 'Download PDF' : 'Open PDF'} kind="secondary" busy={busy === 'pdf'} onPress={pdf} style={{ flexGrow: 1 }} />
        <Button label="WhatsApp" kind="secondary" busy={busy === 'wa'} onPress={whatsapp} style={{ flexGrow: 1 }} />
        {noEmail ? null : <Button label="Email" kind="secondary" busy={busy === 'email'} onPress={() => { setEmailing(e => !e); setMsg(null); if (server && !made.current && !to) prepare(); }} style={{ flexGrow: 1 }} />}
        <Button label={Platform.OS === 'web' ? 'Copy link' : 'Share'} kind="quiet" busy={busy === 'share'} onPress={share} style={{ flexGrow: 1 }} />
        {Platform.OS === 'web' && make ? <Button label="Print" kind="quiet" busy={busy === 'print'} onPress={print} style={{ flexGrow: 1 }} /> : null}
      </View>
      {emailing ? (
        <View style={{ gap: 8 }}>
          <Field label="To (separate several with commas)" value={to} onChangeText={setTo} autoCapitalize="none" keyboardType="email-address" placeholder="client@example.co.za" />
          <Field label="Message (optional)" value={note} onChangeText={setNote} multiline />
          <Button label="Send the email with the PDF" busy={busy === 'email'} onPress={send} />
        </View>
      ) : null}
      {msg ? <Text style={[st.small, { color: msg.tone === 'good' ? C.good : msg.tone === 'bad' ? C.bad : C.info }]}>{msg.text}</Text> : null}
    </View>
  );
}
