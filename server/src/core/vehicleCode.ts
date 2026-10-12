// What a technician scans in a vehicle: our own sticker (QR or barcode), or the vehicle's
// licence disc. A South African licence disc carries a PDF417 barcode with %-separated fields
// that include the registration, make, model, colour and VIN, so the disc works as the vehicle's code.

/** Registration as printed, reduced to letters and digits for comparing ("ND 412-778" → "ND412778"). */
export const normReg = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface DiscInfo { registration: string | null; make: string | null; model: string | null; colour: string | null; vin: string | null; expiry: string | null; candidates: string[] }

/** Reads a licence disc barcode. Null when the code is not a licence disc. */
export function parseLicenceDisc(data: string): DiscInfo | null {
  const t = data.trim();
  if (!t.startsWith('%') || !/MVL/i.test(t)) return null;
  const f = t.split('%').map(x => x.trim());
  if (f.length < 8) return null;
  const at = (i: number) => (f[i] ? f[i] : null);
  // Every field that could be a registration number: short, letters and digits.
  const candidates = [...new Set(f.map(normReg).filter(x => x.length >= 4 && x.length <= 10 && /[A-Z]/.test(x) && /\d/.test(x)))];
  return {
    registration: at(6), make: at(9), model: at(10), colour: at(11), vin: at(12),
    expiry: f.find(x => /^\d{4}-\d{2}-\d{2}$/.test(x)) ?? null,
    candidates,
  };
}

/** What the phone shows after a scan. */
export function describeCode(data: string): string {
  const d = parseLicenceDisc(data);
  if (!d) return data.length > 40 ? `${data.slice(0, 40)}…` : data;
  return ['Licence disc', d.registration, [d.make, d.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}

/** Registration numbers a code could stand for: the disc's fields, or the code itself typed as a registration. */
export function registrationCandidates(data: string): string[] {
  const d = parseLicenceDisc(data);
  return d ? d.candidates : [normReg(data)].filter(x => x.length >= 4);
}
