import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { DerivClient, computeSignal, type Direction } from "@/lib/deriv";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mwase Deriv Bot — Rise/Fall Autopilot" },
      { name: "description", content: "Connect your Deriv demo or real account and trade Rise/Fall manually or on autopilot with loss limits." },
      { property: "og:title", content: "Mwase Deriv Bot — Rise/Fall Autopilot" },
      { property: "og:description", content: "Deriv Rise/Fall bot with Up-only, Down-only and trend strategies." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

type Mode = "UP_ONLY" | "DOWN_ONLY" | "TREND";
type Trade = { id: number; dir: Direction; stake: number; profit: number | null; symbol: string; time: string };
type Sym = { symbol: string; display_name: string; market_display_name: string };

const LS = "mwase-deriv-config";

function Dashboard() {
  const client = useRef<DerivClient | null>(null);
  const [appId, setAppId] = useState("1089");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"off" | "connecting" | "on">("off");
  const [error, setError] = useState("");
  const [account, setAccount] = useState<{ loginid: string; currency: string; isVirtual: boolean } | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [symbols, setSymbols] = useState<Sym[]>([]);
  const [symbol, setSymbol] = useState("R_75");
  const [prices, setPrices] = useState<number[]>([]);
  const [mode, setMode] = useState<Mode>("TREND");
  const [stake, setStake] = useState(1);
  const [duration, setDuration] = useState(5);
  const [minConf, setMinConf] = useState(60);
  const [martingale, setMartingale] = useState(1);
  const [maxLoss, setMaxLoss] = useState(20);
  const [takeProfit, setTakeProfit] = useState(10);
  const [maxTrades, setMaxTrades] = useState(50);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const curStake = useRef(1);
  const tickSub = useRef<string | null>(null);

  const addLog = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 80));

  useEffect(() => {
    try {
      const c = JSON.parse(localStorage.getItem(LS) || "{}");
      if (c.appId) setAppId(c.appId);
      if (c.token) setToken(c.token);
    } catch {}
  }, []);

  const net = trades.reduce((s, t) => s + (t.profit ?? 0), 0);
  const settled = trades.filter((t) => t.profit !== null);
  const wins = settled.filter((t) => (t.profit ?? 0) > 0).length;
  const signal = computeSignal(prices);

  const connect = async () => {
    setError("");
    setStatus("connecting");
    localStorage.setItem(LS, JSON.stringify({ appId, token }));
    try {
      client.current?.close();
      const c = new DerivClient();
      client.current = c;
      c.onClose = () => { setStatus("off"); setAuto(false); addLog("Disconnected"); };
      await c.connect(appId.trim());
      const auth = await c.send({ authorize: token.trim() });
      const a = auth.authorize;
      setAccount({ loginid: a.loginid, currency: a.currency, isVirtual: !!a.is_virtual });
      setBalance(Number(a.balance));
      c.on("balance", (m) => setBalance(Number(m.balance.balance)));
      await c.send({ balance: 1, subscribe: 1 });
      const s = await c.send({ active_symbols: "brief" });
      setSymbols((s.active_symbols as any[]).filter((x) => x.exchange_is_open).map((x) => ({ symbol: x.symbol, display_name: x.display_name, market_display_name: x.market_display_name })));
      c.on("tick", (m) => setPrices((p) => [...p, Number(m.tick.quote)].slice(-300)));
      setStatus("on");
      addLog(`Connected ${a.loginid} (${a.is_virtual ? "DEMO" : "REAL"})`);
    } catch (e: any) {
      setStatus("off");
      setError(e.message || "Connection failed");
    }
  };

  // Subscribe ticks when symbol changes
  useEffect(() => {
    const c = client.current;
    if (status !== "on" || !c) return;
    (async () => {
      if (tickSub.current) await c.send({ forget: tickSub.current }).catch(() => {});
      setPrices([]);
      try {
        const h = await c.send({ ticks_history: symbol, count: 120, end: "latest", style: "ticks" });
        setPrices((h.history.prices as number[]).map(Number));
        const r = await c.send({ ticks: symbol, subscribe: 1 });
        tickSub.current = r.subscription?.id ?? null;
      } catch (e: any) { addLog(`Ticks error: ${e.message}`); }
    })();
  }, [symbol, status]);

  const placeTrade = useCallback(async (dir: Direction, amount: number) => {
    const c = client.current;
    if (!c || !account) return;
    setBusy(true);
    try {
      const p = await c.send({
        proposal: 1, amount: Number(amount.toFixed(2)), basis: "stake", contract_type: dir,
        currency: account.currency, duration, duration_unit: "t", symbol,
      });
      const b = await c.send({ buy: p.proposal.id, price: Number(amount.toFixed(2)) });
      const id = b.buy.contract_id as number;
      setTrades((t) => [{ id, dir, stake: amount, profit: null, symbol, time: new Date().toLocaleTimeString() }, ...t]);
      addLog(`BUY ${dir === "CALL" ? "UP" : "DOWN"} ${amount.toFixed(2)} on ${symbol} #${id}`);
      const result = await new Promise<number>((resolve) => {
        const off = c.on("proposal_open_contract", (m) => {
          const poc = m.proposal_open_contract;
          if (poc.contract_id === id && poc.is_sold) { off(); resolve(Number(poc.profit)); }
        });
        c.send({ proposal_open_contract: 1, contract_id: id, subscribe: 1 }).catch(() => {});
      });
      setTrades((t) => t.map((x) => (x.id === id ? { ...x, profit: result } : x)));
      addLog(`${result > 0 ? "WIN" : "LOSS"} #${id}: ${result.toFixed(2)}`);
      return result;
    } catch (e: any) {
      addLog(`Order error: ${e.message}`);
      setError(e.message);
      return null;
    } finally { setBusy(false); }
  }, [account, duration, symbol]);

  // Autopilot loop
  useEffect(() => {
    if (!auto || busy || status !== "on") return;
    if (net <= -maxLoss) { setAuto(false); addLog("Stopped: loss limit reached"); return; }
    if (net >= takeProfit) { setAuto(false); addLog("Stopped: profit target reached"); return; }
    if (trades.length >= maxTrades) { setAuto(false); addLog("Stopped: max trades reached"); return; }
    let dir: Direction | null = null;
    if (mode === "UP_ONLY") dir = signal.dir === "CALL" && signal.confidence >= minConf ? "CALL" : null;
    else if (mode === "DOWN_ONLY") dir = signal.dir === "PUT" && signal.confidence >= minConf ? "PUT" : null;
    else dir = signal.confidence >= minConf ? signal.dir : null;
    if (!dir) return;
    const amt = curStake.current;
    placeTrade(dir, amt).then((r) => {
      if (r == null) return;
      curStake.current = r > 0 ? stake : Math.min(amt * martingale, stake * 50);
    });
  }, [auto, busy, prices.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const startAuto = () => {
    if (account && !account.isVirtual && !confirm("REAL MONEY account. Start autopilot with real funds?")) return;
    curStake.current = stake;
    setAuto(true);
    addLog(`Autopilot ON (${mode})`);
  };

  const last = prices[prices.length - 1];
  const min = Math.min(...prices.slice(-100)), max = Math.max(...prices.slice(-100));
  const pts = prices.slice(-100).map((p, i) => `${i * 4},${100 - ((p - min) / (max - min || 1)) * 100}`).join(" ");

  const num = (v: number, set: (n: number) => void, label: string, step = 1) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <input type="number" step={step} value={v} onChange={(e) => set(Number(e.target.value))}
        className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground" />
    </label>
  );

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h1 className="text-lg font-bold tracking-tight">MWASE <span className="text-primary">DERIV BOT</span></h1>
        <div className="flex items-center gap-2 text-xs">
          <span className={`h-2 w-2 rounded-full ${status === "on" ? "bg-up" : status === "connecting" ? "bg-primary" : "bg-down"}`} />
          {status === "on" && account ? `${account.loginid} · ${account.isVirtual ? "DEMO" : "REAL"}` : status}
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-3">
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="font-semibold">Deriv connection</h2>
          <label className="block text-xs text-muted-foreground">App ID
            <input value={appId} onChange={(e) => setAppId(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground" />
          </label>
          <label className="block text-xs text-muted-foreground">API token (needs Read + Trade scope)
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground" />
          </label>
          <p className="text-xs text-muted-foreground">Saved only in this browser. Use a demo-account token to test; a real-account token trades real money.</p>
          <button onClick={connect} disabled={status === "connecting"} className="w-full rounded-md bg-primary py-2 font-semibold text-primary-foreground disabled:opacity-50">
            {status === "on" ? "Reconnect" : status === "connecting" ? "Connecting…" : "Connect"}
          </button>
          {error && <p className="text-sm text-down">{error}</p>}
        </section>

        <section className="grid grid-cols-2 gap-3 lg:col-span-2 lg:grid-cols-4">
          {[
            ["Balance", balance != null ? `${balance.toFixed(2)} ${account?.currency ?? ""}` : "—"],
            ["Session P/L", net.toFixed(2)],
            ["Win rate", settled.length ? `${Math.round((wins / settled.length) * 100)}%` : "—"],
            ["Trades", `${trades.length}/${maxTrades}`],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground">{k}</div>
              <div className={`mt-1 font-mono text-xl font-semibold ${k === "Session P/L" ? (net >= 0 ? "text-up" : "text-down") : ""}`}>{v}</div>
            </div>
          ))}
          <div className="col-span-2 rounded-xl border border-border bg-card p-4 lg:col-span-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
                {(symbols.length ? symbols : [{ symbol: "R_75", display_name: "Volatility 75 Index", market_display_name: "Derived" }]).map((s) => (
                  <option key={s.symbol} value={s.symbol}>{s.market_display_name} · {s.display_name}</option>
                ))}
              </select>
              <span className="font-mono text-lg">{last?.toString() ?? "—"}</span>
            </div>
            <svg viewBox="0 0 400 100" preserveAspectRatio="none" className="h-40 w-full">
              <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="1.5" />
            </svg>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs text-muted-foreground">Signal</div>
                <div className={`text-2xl font-bold ${signal.dir === "CALL" ? "text-up" : signal.dir === "PUT" ? "text-down" : ""}`}>
                  {signal.dir === "CALL" ? "▲ UP" : signal.dir === "PUT" ? "▼ DOWN" : "WAIT"} <span className="font-mono text-base">{signal.confidence}%</span>
                </div>
                <div className="text-xs text-muted-foreground">{signal.note}</div>
              </div>
              <div className="flex gap-2">
                <button disabled={status !== "on" || busy} onClick={() => placeTrade("CALL", stake)} className="rounded-md bg-up px-6 py-3 font-bold text-primary-foreground disabled:opacity-40">▲ UP</button>
                <button disabled={status !== "on" || busy} onClick={() => placeTrade("PUT", stake)} className="rounded-md bg-down px-6 py-3 font-bold text-primary-foreground disabled:opacity-40">▼ DOWN</button>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="font-semibold">Strategy & risk</h2>
          <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1 text-xs">
            {(["UP_ONLY", "DOWN_ONLY", "TREND"] as Mode[]).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`rounded py-1.5 ${mode === m ? "bg-primary text-primary-foreground" : ""}`}>
                {m === "UP_ONLY" ? "Up only" : m === "DOWN_ONLY" ? "Down only" : "Trend"}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {num(stake, setStake, "Stake", 0.1)}
            {num(duration, setDuration, "Duration (ticks)")}
            {num(minConf, setMinConf, "Min confidence %")}
            {num(martingale, setMartingale, "Loss multiplier (1 = off)", 0.1)}
            {num(maxLoss, setMaxLoss, "Loss limit")}
            {num(takeProfit, setTakeProfit, "Profit target")}
            {num(maxTrades, setMaxTrades, "Max trades")}
          </div>
          {auto ? (
            <button onClick={() => { setAuto(false); addLog("Autopilot OFF"); }} className="w-full rounded-md bg-down py-3 font-bold text-primary-foreground">STOP AUTOPILOT</button>
          ) : (
            <button disabled={status !== "on"} onClick={startAuto} className="w-full rounded-md bg-up py-3 font-bold text-primary-foreground disabled:opacity-40">START AUTOPILOT</button>
          )}
          <p className="text-xs text-muted-foreground">No strategy guarantees profit. Autopilot stops at your loss limit, profit target or trade cap.</p>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 lg:col-span-1">
          <h2 className="mb-2 font-semibold">Trade history</h2>
          <div className="max-h-80 space-y-1 overflow-auto font-mono text-xs">
            {trades.length === 0 && <p className="text-muted-foreground">No trades yet.</p>}
            {trades.map((t) => (
              <div key={t.id} className="flex justify-between border-b border-border py-1">
                <span>{t.time} {t.dir === "CALL" ? "▲" : "▼"} {t.symbol}</span>
                <span className={t.profit == null ? "text-muted-foreground" : t.profit > 0 ? "text-up" : "text-down"}>
                  {t.profit == null ? "open" : t.profit.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-2 font-semibold">Activity log</h2>
          <div className="max-h-80 overflow-auto font-mono text-xs text-muted-foreground">
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </section>
      </main>
    </div>
  );
}
