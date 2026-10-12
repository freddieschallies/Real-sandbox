// Labels and little formatters shared by the mechanic's screens.
import * as F from '../../../server/src/core/fleet.ts';

export const K = { band: '#2E4A73', bandText: '#EAF1FB' };
export const STATUS: Record<F.VehicleStatus, { text: string; tone: 'good' | 'warn' | 'bad' }> = {
  in_service: { text: 'In service', tone: 'good' }, workshop: { text: 'In workshop', tone: 'warn' }, off_road: { text: 'Off the road', tone: 'bad' },
};
export const SEV: Record<F.FaultSeverity, 'bad' | 'warn' | 'quiet'> = { safety: 'bad', urgent: 'warn', normal: 'quiet' };
export const DUE: Record<F.Due['state'], 'good' | 'warn' | 'bad' | 'quiet'> = { ok: 'good', soon: 'warn', overdue: 'bad', unknown: 'quiet' };
export const TYPE_LABEL: Record<F.FleetJobType, string> = { service: 'Service', repair: 'Repair', tyres: 'Tyres', brakes: 'Brakes', electrical: 'Electrical', roadworthy: 'Roadworthy', breakdown: 'Breakdown', other: 'Other' };
export const SLOT_LABEL = { morning: 'Morning', afternoon: 'Afternoon', all_day: 'All day' } as const;
export const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const km = (n: number | null | undefined) => (n == null ? '–' : `${n.toLocaleString('en-ZA')} km`);
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
/** The next `n` days as YYYY-MM-DD, starting today. */
export const nextDays = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.now() + i * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }));
/** "Today", "Tomorrow" or "Thu 15 Oct". */
export function dayName(ymd: string) {
  const days = nextDays(2);
  if (ymd === days[0]) return 'Today';
  if (ymd === days[1]) return 'Tomorrow';
  return new Date(`${ymd}T12:00:00+02:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
}
export const ago = (min: number | null) => (min == null ? 'no tracker fix' : min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`);
