// A technician's purchase order as a page for the supplier (approved POs), on the letterhead.
import { escHtml as e, letterPage } from '../letterhead.tsx';

export function techPoHtml(p: any, company: string): string {
  const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' }) : '–');
  const lines = (p.lines ?? []).map((l: any) => `<tr><td>${e(l.code ?? '')}</td><td>${e(l.description)}</td><td class=r>${e(l.qty)}</td></tr>`).join('');
  const body = `<div class=two><div><b>Supplier</b><br>${e(p.supplier_name)}</div>
<div><b>PO no.</b> ${e(p.external_number ?? p.po_number)}<br><b>Date</b> ${day(p.decided_at ?? p.requested_at)}<br>${p.job_number ? `<b>Job</b> ${e(p.job_number)}${p.store ? `, ${e(p.store)}` : ''}<br>` : ''}<b>Collected by</b> ${e(p.technician ?? '–')}</div></div>
<table><tr><th>Code</th><th>Description</th><th class=r>Qty</th></tr>${lines || '<tr><td colspan=3>See the attached list.</td></tr>'}</table>
${p.note ? `<p><b>Note:</b> ${e(p.note)}</p>` : ''}<p>${p.decided_by ? `Approved by ${e(p.decided_by)}. ` : ''}Please quote this PO number on your invoice / slip.</p>`;
  return letterPage({ title: `Purchase order ${p.external_number ?? p.po_number}`, label: `PURCHASE ORDER ${p.external_number ?? p.po_number}`, company, body });
}
