// Deriv API client (developers.deriv.com): PAT + App ID over REST, then OTP WebSocket.
// Token is kept in this browser only.

type Handler = (msg: any) => void;

export const DERIV_API = "https://api.derivws.com";

export type DerivAccount = {
  account_id: string;
  balance: number;
  currency: string;
  group: string;
  status: "active" | "inactive";
  account_type: "demo" | "real";
};

async function derivRest(path: string, appId: string, token: string, method = "GET") {
  let res: Response;
  try {
    res = await fetch(`${DERIV_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Deriv-App-ID": appId },
    });
  } catch {
    throw new Error("Could not reach api.derivws.com. Check your internet or disable ad-blockers for this site.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.errors?.[0]?.message || (typeof body === "string" ? body : "");
    if (res.status === 401) throw new Error(`Deriv rejected the App ID or token (401). ${msg}`.trim());
    if (res.status === 403) throw new Error(`Token is missing the "trade" scope (403). ${msg}`.trim());
    throw new Error(`Deriv error ${res.status}. ${msg}`.trim());
  }
  return body;
}

/** Lists the trader's Options accounts (demo + real) using a PAT and App ID. */
export async function fetchAccounts(appId: string, token: string): Promise<DerivAccount[]> {
  const b = await derivRest("/trading/v1/options/accounts", appId, token);
  return (b?.data ?? []) as DerivAccount[];
}

/** Gets a one-time authenticated WebSocket URL for one account (valid 120s, single use). */
export async function fetchOtpUrl(appId: string, token: string, accountId: string): Promise<string> {
  const b = await derivRest(`/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, appId, token, "POST");
  const url = b?.data?.url;
  if (!url) throw new Error("Deriv did not return a trading connection URL.");
  return url as string;
}

// WebSocket client for the new Deriv API (wss://api.derivws.com/trading/v1/options/ws/...).
export class DerivClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { resolve: (m: any) => void; reject: (e: any) => void }>();
  private subs = new Map<string, Set<Handler>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  onClose: (() => void) | null = null;

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const label = url.split("?")[0];
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to ${label}`));
      }, 15000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.pingTimer = setInterval(() => this.send({ ping: 1 }).catch(() => {}), 30000);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Could not open the Deriv trading connection (${label}). An ad-blocker or firewall may be blocking it.`));
      };
      ws.onclose = () => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pending.forEach((p) => p.reject(new Error("Connection closed")));
        this.pending.clear();
        this.onClose?.();
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        const id = msg.req_id as number | undefined;
        if (id && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg);
        }
        const set = this.subs.get(msg.msg_type);
        if (set && !msg.error) set.forEach((h) => h(msg));
      };
    });
  }

  send(payload: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error("Not connected"));
      const req_id = this.reqId++;
      this.pending.set(req_id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  on(type: string, h: Handler) {
    if (!this.subs.has(type)) this.subs.set(type, new Set());
    this.subs.get(type)!.add(h);
    return () => this.subs.get(type)?.delete(h);
  }

  close() {
    if (this.ws) this.ws.onclose = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }
}

export type Direction = "CALL" | "PUT";

/** Exponential moving average of the last values. */
export function ema(values: number[], period: number) {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) e = (values[i] ?? e) * k + e * (1 - k);
  return e;
}

/**
 * Tick-trend signal: fast/slow EMA alignment + recent tick direction ratio.
 * Returns direction and confidence 0-100. Not a guarantee of results.
 */
export function computeSignal(prices: number[]): { dir: Direction | null; confidence: number; note: string } {
  if (prices.length < 30) return { dir: null, confidence: 0, note: "Collecting ticks…" };
  const recent = prices.slice(-60);
  const fast = ema(recent, 5);
  const slow = ema(recent, 21);
  const last10 = prices.slice(-11);
  let ups = 0;
  for (let i = 1; i < last10.length; i++) if ((last10[i] ?? 0) > (last10[i - 1] ?? 0)) ups++;
  const upRatio = ups / 10;
  const spread = Math.abs(fast - slow) / (Math.abs(slow) || 1);
  const strength = Math.min(1, spread * 4000);
  const bullish = fast > slow;
  const agree = bullish ? upRatio : 1 - upRatio;
  const confidence = Math.round((0.55 * strength + 0.45 * agree) * 100);
  return {
    dir: bullish ? "CALL" : "PUT",
    confidence,
    note: `EMA5 ${bullish ? ">" : "<"} EMA21 · ${ups}/10 up ticks`,
  };
}
