// The job card as the client gets it (to print, file or attach to their own paperwork): the job, who
// worked on it and when, every fault with what was found and done, the parts used, the before and
// after photos and the store manager's sign-off. No prices: those are on the invoice. Pure: the server
// fills it in, and the app's test drive does the same.

export interface JobReportData {
  company: string;
  job: { number: number; type: string; status: string; fault: string; scheduledDate: string; clientRef: string | null; closedAt: string | null;
    managerName: string | null; unavailableReason: string | null; unavailableSpokeTo: string | null; cancelNote?: string | null };
  client: string; store: string; storeAddress: string | null;
  lead: string; helpers: { name: string; trade?: string | null }[]; crew: { name: string; kind: string; days: number }[];
  visits: { arrivedAt: string | null; endedAt: string | null; place?: string | null; checkedInWith?: string | null; technician?: string | null }[];
  items: { title: string; equipment: string | null; faultType: string | null; found: string | null; did: string | null; tested: string | null; outcome: string | null; stillNeeded: string | null;
    before: string[]; after: string[] }[];
  parts: { code: string | null; description: string; qty: number; unit?: string | null }[];
  signature: string | null;
}

const TYPE: Record<string, string> = { breakdown: 'Breakdown', planned_maintenance: 'Planned maintenance', installation: 'Installation', quote_visit: 'Quote visit', follow_up: 'Follow-up', workshop_repair: 'Workshop repair' };
const FAULT: Record<string, string> = { electrical: 'Electrical', refrigeration: 'Refrigeration', mechanical: 'Mechanical', water: 'Water', wear_and_tear: 'Wear and tear', user_damage: 'User damage', no_fault_found: 'No fault found', other: 'Other' };
const OUTCOME: Record<string, string> = { complete: 'Complete', needs_follow_up: 'Needs a follow-up visit', needs_quote: 'Needs a quote', waiting_for_parts: 'Waiting for parts' };
const TESTED: Record<string, string> = { yes: 'Tested and working', partly: 'Partly working', no: 'Not working yet' };
const STATUS: Record<string, string> = { assigned: 'Booked', in_progress: 'In progress', continue_later: 'To be continued', closed: 'Completed and signed off', cancelled: 'Cancelled' };

export const escHtml = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const sast = (iso: string | null, o: Intl.DateTimeFormatOptions) => (iso ? new Date(iso).toLocaleString('en-ZA', { ...o, timeZone: 'Africa/Johannesburg' }) : '–');
const dayOf = (iso: string | null) => sast(iso, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeOf = (iso: string | null) => sast(iso, { hour: '2-digit', minute: '2-digit' });

export const PAGE_CSS = `@page{size:A4;margin:12mm}body{font:12.5px Arial,sans-serif;margin:0;color:#111}.bar{height:8px;background:#E8701A}
.head{background:#111;color:#fff;padding:12px 22px;display:flex;justify-content:space-between;align-items:center}.head h1{margin:0;font-size:20px}.head .t{color:#E8701A;font-weight:900;font-size:17px;text-align:right}
.body{padding:14px 22px}.two{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}h3{margin:16px 0 4px;font-size:14px;border-bottom:2px solid #E8701A;padding-bottom:2px}
table{width:100%;border-collapse:collapse;margin-top:6px}th{text-align:left;border-top:2px solid #111;border-bottom:1px solid #ccc;padding:5px 4px}td{border-bottom:1px solid #eee;padding:5px 4px;vertical-align:top}.r{text-align:right}
.item{page-break-inside:avoid;border:1px solid #ddd;border-radius:6px;padding:8px 10px;margin:8px 0}.muted{color:#666}.ph{display:inline-block;margin:6px 8px 0 0;vertical-align:top}.ph img{display:block;max-width:230px;max-height:200px;border:1px solid #ccc}
.sig img{max-height:90px;border-bottom:1px solid #111}`;

/** The page's body (between the letterhead's top and bottom). */
export function jobReportBody(d: JobReportData): string {
  const e = escHtml;
  const j = d.job;
  const site = d.visits.filter(v => v.place !== 'workshop' && v.arrivedAt);
  const visits = d.visits.filter(v => v.arrivedAt).map(v => `<tr><td>${dayOf(v.arrivedAt)}</td><td>${v.place === 'workshop' ? 'Our workshop' : 'On site'}</td><td>${timeOf(v.arrivedAt)}</td><td>${v.endedAt ? timeOf(v.endedAt) : '–'}</td><td>${e(v.technician ?? d.lead)}${v.checkedInWith ? `<br><span class=muted>Checked in with ${e(v.checkedInWith)}</span>` : ''}</td></tr>`).join('');
  const pics = (list: string[], label: string) => (list.length ? `<div>${list.map(u => `<div class=ph><img src="${u}"><span class=muted>${label}</span></div>`).join('')}</div>` : '');
  const items = d.items.map((it, n) => `<div class=item><b>${n + 1}. ${e(it.title)}</b>${it.equipment ? `<div class=muted>${e(it.equipment)}</div>` : ''}
${it.faultType ? `<div><b>Fault:</b> ${e(FAULT[it.faultType] ?? it.faultType)}</div>` : ''}${it.found ? `<div><b>Found:</b> ${e(it.found)}</div>` : ''}${it.did ? `<div><b>Done:</b> ${e(it.did)}</div>` : ''}
${it.tested || it.outcome ? `<div><b>Result:</b> ${e([it.tested ? TESTED[it.tested] ?? it.tested : null, it.outcome ? OUTCOME[it.outcome] ?? it.outcome : null].filter(Boolean).join(' · '))}</div>` : ''}
${it.stillNeeded ? `<div><b>Still needed:</b> ${e(it.stillNeeded)}</div>` : ''}${pics(it.before, 'Before')}${pics(it.after, 'After')}</div>`).join('');
  const parts = d.parts.map(p => `<tr><td>${e(p.code ?? '')}</td><td>${e(p.description)}</td><td class=r>${e(p.qty)}${p.unit ? ` ${e(p.unit)}` : ''}</td></tr>`).join('');
  const people = [`${e(d.lead)} (lead technician)`, ...d.helpers.map(h => `${e(h.name)}${h.trade === 'assistant' ? ' (assistant)' : ''}`), ...d.crew.map(c => `${e(c.name)} (${c.kind === 'casual' ? 'casual labour' : 'assistant'})`)].join(', ');
  const sign = j.status === 'closed'
    ? (d.signature ? `<div class=sig><img src="${d.signature}"><div>Signed by ${e(j.managerName ?? 'the store manager')}, ${dayOf(j.closedAt)} ${timeOf(j.closedAt)}</div></div>`
      : `<p>Closed ${dayOf(j.closedAt)} ${timeOf(j.closedAt)} without a signature: ${e(j.unavailableReason ?? 'manager unavailable')}${j.unavailableSpokeTo ? ` (spoke to ${e(j.unavailableSpokeTo)})` : ''}.</p>`)
    : `<p class=muted>${e(STATUS[j.status] ?? j.status)}: not signed off yet.</p>`;
  return `<div class=two><div><b>${e(d.client)}</b>${d.store !== d.client ? `<br>${e(d.store)}` : ''}${d.storeAddress ? `<br>${e(d.storeAddress)}` : ''}</div>
<div><b>Job no.</b> ${j.number}<br><b>Type</b> ${e(TYPE[j.type] ?? j.type)}<br><b>Date</b> ${site.length ? dayOf(site[0].arrivedAt) : dayOf(`${j.scheduledDate}T12:00:00+02:00`)}${j.clientRef ? `<br><b>Your order no.</b> ${e(j.clientRef)}` : ''}<br><b>Status</b> ${e(STATUS[j.status] ?? j.status)}</div></div>
<h3>Fault reported</h3><p>${e(j.fault)}</p>${j.cancelNote ? `<p><b>Cancelled:</b> ${e(j.cancelNote)}</p>` : ''}
<h3>Who worked on it</h3><p>${people}</p>
${visits ? `<h3>Time on site</h3><table><tr><th>Day</th><th>Where</th><th>Arrived</th><th>Left</th><th>Technician</th></tr>${visits}</table>` : ''}
<h3>Work done</h3>${items || '<p class=muted>No work recorded yet.</p>'}
<h3>Parts used</h3>${parts ? `<table><tr><th>Code</th><th>Part</th><th class=r>Qty</th></tr>${parts}</table>` : '<p class=muted>No parts used.</p>'}
<h3>Sign-off</h3>${sign}`;
}

/** The whole page, given the letterhead's top and bottom (HTML). */
export function jobReportHtml(d: JobReportData, top: string, bottom: string): string {
  const plain = `<div class=bar></div><div class=head><h1>${escHtml(d.company)}</h1><div class=t>JOB CARD ${d.job.number}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Job card ${d.job.number}</title><style>${PAGE_CSS}</style></head><body>
${top || plain}${top ? `<h2 style="margin:10px 22px 0">Job card ${d.job.number}</h2>` : ''}<div class=body>${jobReportBody(d)}</div>${bottom || '<div class=bar></div>'}</body></html>`;
}
