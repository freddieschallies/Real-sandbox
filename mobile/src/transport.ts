// How requests reach a server: the real office server over HTTP, or the demo server inside the app.
// Both answer the same requests the same way, so the rest of the app doesn't know the difference.
export interface Upload { fields: Record<string, string>; fileUri: string; mime: string; /** The file name (a spreadsheet); photos are sent as "photo". */ name?: string }

export interface Request {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  json?: unknown;
  upload?: Upload;
  idemKey?: string;
}

export interface Response { status: number; body: any }

export interface Transport {
  send(req: Request, token?: string): Promise<Response>;
}

/** Thrown when the request never got an answer (no signal, server down). The outbox retries these. */
export class Offline extends Error {}

/** The reasons a refusal carries, as the app shows them. */
export function reasonsOf(r: Response): string[] {
  if (Array.isArray(r.body?.reasons)) return r.body.reasons;
  if (typeof r.body?.error === 'string') return [r.body.error];
  return [`refused (${r.status})`];
}
