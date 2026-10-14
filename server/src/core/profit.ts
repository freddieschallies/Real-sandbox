// What each job made: what it was invoiced (less credit notes) against what it cost the company:
// the technicians' time on site and driving (at what an hour of a technician costs), the parts used
// (at their latest cost), items bought for it, and the km driven (at the vehicle's running cost per
// km). Then the same added up per client, per technician and per month. Pure functions, the same on
// the server and in the app.

export interface JobMoney {
  jobId: string; jobNumber: number; client: string; store: string; technician: string; month: string; closed: string;
  /** Invoiced excl. VAT less credit notes; null: not invoiced yet. 0 when closed at no charge. */
  revenueCents: number | null; noCharge: boolean;
  /** Technician minutes (on site and driving, every technician on the job). */
  labourMinutes: number; km: number; kmEstimated: boolean;
  partsCostCents: number; partsWithoutCost: number; boughtOutCents: number;
}
export interface CostRates { labourCostPerHourCents: number; vehicleCostPerKmCents: number }

export interface JobProfit extends JobMoney {
  labourCostCents: number; travelCostCents: number; costCents: number; profitCents: number | null; marginPct: number | null;
}

export function jobProfit(j: JobMoney, r: CostRates): JobProfit {
  const labourCostCents = Math.round((j.labourMinutes / 60) * r.labourCostPerHourCents);
  const travelCostCents = Math.round(j.km * r.vehicleCostPerKmCents);
  const costCents = labourCostCents + travelCostCents + j.partsCostCents + j.boughtOutCents;
  const revenue = j.noCharge ? 0 : j.revenueCents;
  const profitCents = revenue === null ? null : revenue - costCents;
  return { ...j, labourCostCents, travelCostCents, costCents, profitCents, marginPct: revenue ? Math.round((profitCents! / revenue) * 1000) / 10 : null };
}

export interface ProfitGroup { key: string; jobs: number; revenueCents: number; costCents: number; profitCents: number; marginPct: number | null; noCharge: number }

/** Added up by client, technician or month (only jobs invoiced or closed at no charge count; others wait). */
export function groupProfit(list: JobProfit[], by: 'client' | 'technician' | 'month'): ProfitGroup[] {
  const m = new Map<string, ProfitGroup>();
  for (const j of list) {
    if (j.profitCents === null) continue;
    const k = j[by];
    const g = m.get(k) ?? { key: k, jobs: 0, revenueCents: 0, costCents: 0, profitCents: 0, marginPct: null, noCharge: 0 };
    g.jobs++; g.revenueCents += j.noCharge ? 0 : j.revenueCents ?? 0; g.costCents += j.costCents; g.profitCents += j.profitCents;
    if (j.noCharge) g.noCharge++;
    m.set(k, g);
  }
  return [...m.values()].map(g => ({ ...g, marginPct: g.revenueCents ? Math.round((g.profitCents / g.revenueCents) * 1000) / 10 : null }))
    .sort((a, b) => (by === 'month' ? b.key.localeCompare(a.key) : b.profitCents - a.profitCents));
}
