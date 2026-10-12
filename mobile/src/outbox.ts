// Everything the technician does is saved on the phone first and sent in order when there is
// signal. Each entry carries its own Idempotency-Key, so if the phone loses signal halfway and
// sends again, the server applies it only once.
import { Offline, reasonsOf, type Request, type Transport } from './transport.ts';

export interface Entry extends Request {
  id: string;            // also the Idempotency-Key
  label: string;         // what the technician sees: "Arrived at FreshMart Meerensee"
  createdAt: string;
  jobId?: string;
  attempts: number;
}

export interface Blocked { entry: Entry; reasons: string[] }

export type FlushResult = 'done' | 'offline' | 'blocked' | 'signed_out' | 'busy';

export class Outbox {
  entries: Entry[] = [];
  blocked: Blocked | null = null;
  lastSentAt: string | null = null;
  private flushing = false;

  constructor(
    private transport: () => Transport,
    private token: () => string | undefined,
    private persist: (o: { entries: Entry[]; blocked: Blocked | null; lastSentAt: string | null }) => void,
    private onChange: () => void = () => {},
  ) {}

  restore(o: { entries: Entry[]; blocked: Blocked | null; lastSentAt: string | null }) {
    this.entries = o.entries ?? [];
    this.blocked = o.blocked ?? null;
    this.lastSentAt = o.lastSentAt ?? null;
  }

  add(e: Omit<Entry, 'attempts' | 'createdAt'> & { createdAt?: string }) {
    this.entries.push({ ...e, createdAt: e.createdAt ?? new Date().toISOString(), attempts: 0 });
    this.save();
  }

  get waiting() { return this.entries.length; }

  /** Sends queued entries in order. Stops at the first one without signal or one the server refuses. */
  async flush(onSent?: (e: Entry) => void): Promise<FlushResult> {
    if (this.flushing) return 'busy';
    if (this.blocked) return 'blocked';
    this.flushing = true;
    try {
      while (this.entries.length) {
        const head = this.entries[0];
        head.attempts += 1;
        let res;
        try {
          res = await this.transport().send({ ...head, idemKey: head.id }, this.token());
        } catch (e) {
          if (e instanceof Offline) { this.save(); return 'offline'; }
          throw e;
        }
        if (res.status === 401) { this.save(); return 'signed_out'; }
        if (res.status >= 400) {
          this.blocked = { entry: head, reasons: reasonsOf(res) };
          this.save();
          return 'blocked';
        }
        this.entries.shift();
        this.lastSentAt = new Date().toISOString();
        this.save();
        onSent?.(head);
      }
      return 'done';
    } finally {
      this.flushing = false;
    }
  }

  /**
   * The technician gives up on a refused change. Later changes to the same job depended on it,
   * so they go too; the job card is then reloaded from the server.
   */
  discardBlocked(): Entry[] {
    if (!this.blocked) return [];
    const { entry } = this.blocked;
    const removed = this.entries.filter(e => e.id === entry.id || (entry.jobId && e.jobId === entry.jobId));
    this.entries = this.entries.filter(e => !removed.includes(e));
    this.blocked = null;
    this.save();
    return removed;
  }

  clearAll() {
    this.entries = [];
    this.blocked = null;
    this.save();
  }

  private save() {
    this.persist({ entries: this.entries, blocked: this.blocked, lastSentAt: this.lastSentAt });
    this.onChange();
  }
}
