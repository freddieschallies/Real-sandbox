// Code 128 barcodes for the vehicle stickers: every phone camera and scanner reads them. Text is
// encoded in code set B (letters, digits and punctuation). Pure functions, used on the phone (to
// draw the sticker) and the server.

// The bar and space widths of each of the 107 symbols (bar, space, bar, space, bar, space[, bar]).
const P = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112').split(' ');
export const CODE128_PATTERNS = P;
const START_B = 104, STOP = 106;

/** The symbol values for text in code set B, with the start, checksum and stop. */
export function code128Values(text: string): number[] {
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error('only plain letters, digits and punctuation can go on a barcode');
  const data = [...text].map(ch => ch.charCodeAt(0) - 32);
  const check = (START_B + data.reduce((n, v, i) => n + v * (i + 1), 0)) % 103;
  return [START_B, ...data, check, STOP];
}

/** The widths of every bar and space, left to right (starting with a bar), quiet zones not included. */
export function code128Widths(text: string): number[] {
  return code128Values(text).flatMap(v => [...P[v]].map(Number));
}

/** A new sticker code: letters and digits that are easy to read aloud (no 0/O or 1/I), e.g. "V-7KQ3M9" for a vehicle, "T-…" for a tool. */
export function newCode(prefix: 'V' | 'T', random: () => number = Math.random): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[Math.floor(random() * A.length)];
  return `${prefix}-${s}`;
}
export const newVehicleCode = (random?: () => number) => newCode('V', random);

/** A code typed in (to keep a sticker already on it): letters, digits and dashes. */
export const validCode = (s: string) => /^[A-Z0-9][A-Z0-9-]{2,23}$/.test(s);
export const validVehicleCode = validCode;
