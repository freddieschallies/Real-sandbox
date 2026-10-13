import { Platform } from 'react-native';
import { Offline, type Request, type Response, type Transport } from './transport.ts';

export class HttpTransport implements Transport {
  constructor(private baseUrl: string) {}

  async send(req: Request, token?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (req.idemKey) headers['idempotency-key'] = req.idemKey;
    let body: any;
    if (req.upload) {
      const form = new FormData();
      for (const [k, v] of Object.entries(req.upload.fields)) form.append(k, v);
      if (Platform.OS === 'web') {
        const blob = await (await fetch(req.upload.fileUri)).blob();
        form.append('file', blob, req.upload.name ?? 'photo');
      } else {
        form.append('file', { uri: req.upload.fileUri, name: req.upload.name ?? 'photo', type: req.upload.mime } as any);
      }
      body = form;
    } else if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: globalThis.Response;
    try {
      res = await fetch(this.baseUrl.replace(/\/$/, '') + req.path, { method: req.method, headers, body, signal: controller.signal });
    } catch {
      throw new Offline('no connection to the server');
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500) {
      throw new Offline(`server busy (${res.status})`);
    }
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text }; }
    return { status: res.status, body: parsed };
  }
}

