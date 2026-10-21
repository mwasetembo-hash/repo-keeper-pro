import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { DerivClient, computeSignal, fetchAccounts, fetchOtpUrl, type DerivAccount } from "@/lib/deriv";
import { CATALOG, CONTRACTS, digitStats, groupOf, kindSignal, trendStrength, type Inst, type Kind } from "@/lib/contracts";
import { BRS_PHASES, ENGINES, brsPhaseLabel, journal, runEngine, type EngineId } from "@/lib/engines";
import { DiagnosePanel } from "@/components/DiagnosePanel";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mwase Deriv Bot — Multi-Contract Trading Terminal" },
      { name: "description", content: "Trade Rise/Fall, Digits, Touch and range contracts on every Deriv instrument with a live market scanner and loss limits." },
      { property: "og:title", content: "Mwase Deriv Bot — Multi-Contract Trading Terminal" },
      { property: "og:description", content: "Every Deriv market, contract-specific signals, a ranking scanner and autopilot with risk limits." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

type Mode = "SIDE_A" | "SIDE_B" | "SIGNAL";
type Trade = { id: number; label: string; stake: number; profit: number | null; symbol: string; time: string };
type ScanRow = { symbol: string; name: string; group: string; trend: number; conf: number; dir: string };
type Unit = "t" | "s" | "m";

const LS = "mwase-deriv-config";
const LS_PROFILES = "mwase-deriv-profiles";
const GROUPS = ["Forex", "Gold & Metals", "Commodities", "Stock Indices", "Crypto", "Derived"];
type Profile = { name: string; settings: Record<string, unknown> };

function Dashboard() {
  const client = useRef<DerivClient | null>(null);
  const [appId, setAppId] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"off" | "connecting" | "on">("off");
  const [error, setError] = useState("");
  const [account, setAccount] = useState<{ loginid: string; currency: string; isVirtual: boolean } | null>(null);
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [instruments, setInstruments] = useState<(Inst & { open?: boolean; pip?: number | undefined })[]>(CATALOG);
  const [symbol, setSymbol] = useState("R_75");
  const [prices, setPrices] = useState<number[]>([]);
  const [kind, setKind] = useState<Kind>("RISE_FALL");
  const [mode, setMode] = useState<Mode>("SIGNAL");
  const [stake, setStake] = useState(1);
  const [duration, setDuration] = useState(5);
  const [unit, setUnit] = useState<Unit>("t");
  const [digit, setDigit] = useState(5);
  const [offset, setOffset] = useState(0.5);
  const [hi, setHi] = useState(0.5);
  const [lo, setLo] = useState(-0.5);
  const [minConf, setMinConf] = useState(75);
  const [martingale, setMartingale] = useState(1);
  const [maxLoss, setMaxLoss] = useState(20);
  const [takeProfit, setTakeProfit] = useState(10);
  const [maxTrades, setMaxTrades] = useState(50);
  const [maxStake, setMaxStake] = useState(10);
  const [lossStreakStop, setLossStreakStop] = useState(3);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [scan, setScan] = useState<ScanRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [brs, setBrs] = useState(false);
  const [brsStep, setBrsStep] = useState(0);
  const [brsLevels, setBrsLevels] = useState(3);
  const [brsMult, setBrsMult] = useState(3.75);
  const [engine, setEngine] = useState<EngineId>("A");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileName, setProfileName] = useState("");
  const curStake = useRef(1);
  const streak = useRef(0);
  const brsLevel = useRef(0);
  const tickSub = useRef<string | null>(null);

  const addLog = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 80));
  const def = CONTRACTS[kind];
  const inst = instruments.find((i) => i.symbol === symbol);
  const decimals = inst?.pip ? Math.max(0, Math.round(-Math.log10(inst.pip))) : 2;

  useEffect(() => {
    try {
      const c = JSON.parse(localStorage.getItem(LS) || "{}");
      if (c.appId) setAppId(c.appId);
      if (c.token) setToken(c.token);
      if (c.accountId) setAccountId(c.accountId);
    } catch {}
    try { setProfiles(JSON.parse(localStorage.getItem(LS_PROFILES) || "[]")); } catch {}
  }, []);

  const currentSettings = () => ({ appId, token, accountId, symbol, kind, mode, stake, duration, unit, digit, offset, hi, lo, minConf, martingale, maxLoss, takeProfit, maxTrades, maxStake, lossStreakStop, brs, brsLevels, brsMult });

  const applySettings = (s: Record<string, unknown>) => {
    const setters: Record<string, (v: any) => void> = { appId: setAppId, token: setToken, accountId: setAccountId, symbol: setSymbol, kind: setKind, mode: setMode, stake: setStake, duration: setDuration, unit: setUnit, digit: setDigit, offset: setOffset, hi: setHi, lo: setLo, minConf: setMinConf, martingale: setMartingale, maxLoss: setMaxLoss, takeProfit: setTakeProfit, maxTrades: setMaxTrades, maxStake: setMaxStake, lossStreakStop: setLossStreakStop, brs: setBrs, brsLevels: setBrsLevels, brsMult: setBrsMult };
    for (const [k, v] of Object.entries(s)) setters[k]?.(v);
    addLog("Profile loaded");
  };

  const saveProfile = () => {
    const name = profileName.trim();
    if (!name) return;
    const { appId: _a, token: _t, accountId: _c, ...safe } = currentSettings();
    const next = [...profiles.filter((p) => p.name !== name), { name, settings: safe }];
    setProfiles(next);
    localStorage.setItem(LS_PROFILES, JSON.stringify(next));
    setProfileName("");
    addLog(`Profile "${name}" saved`);
  };

  const exportProfiles = () => {
    const blob = new Blob([JSON.stringify(profiles, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mwase-bot-profiles.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importProfiles = (file: File) => {
    file.text().then((t) => {
      const parsed = JSON.parse(t) as Profile[];
      if (!Array.isArray(parsed)) throw new Error("bad file");
      const merged = [...profiles];
      for (const p of parsed) if (p?.name && p?.settings) {
        const i = merged.findIndex((m) => m.name === p.name);
        i >= 0 ? (merged[i] = p) : merged.push(p);
      }
      setProfiles(merged);
      localStorage.setItem(LS_PROFILES, JSON.stringify(merged));
      addLog(`Imported ${parsed.length} profile(s)`);
    }).catch(() => addLog("Import failed: not a valid profiles file"));
  };

  // Digit contracts need ticks
  useEffect(() => { if (def.digits) { setUnit("t"); setDuration((d) => Math.min(10, Math.max(1, d))); } }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const net = trades.reduce((s, t) => s + (t.profit ?? 0), 0);
  const settled = trades.filter((t) => t.profit !== null);
  const wins = settled.filter((t) => (t.profit ?? 0) > 0).length;
  const ticksEq = unit === "t" ? duration : unit === "s" ? duration / 2 : duration * 30;
  const sig = kindSignal(kind, prices, decimals, { digit, offset, hi, lo, ticks: ticksEq });
  const base = computeSignal(prices);
  const stats = def.digits ? digitStats(prices, decimals) : null;

  const connect = async () => {
    setError("");
    setStatus("connecting");
    try {
      const id = appId.trim(), tk = token.trim();
      if (!id) throw new Error("Enter your App ID from developers.deriv.com.");
      if (!tk.startsWith("pat_")) throw new Error("Enter a Personal Access Token (starts with pat_) from developers.deriv.com.");
      addLog("Fetching Deriv accounts…");
      const list = (await fetchAccounts(id, tk)).filter((a) => a.status === "active");
      if (!list.length) throw new Error("No active Options accounts found for this token.");
      setAccounts(list);
      const acc = list.find((a) => a.account_id === accountId) ?? list.find((a) => a.account_type === "demo") ?? list[0]!;
      setAccountId(acc.account_id);
      localStorage.setItem(LS, JSON.stringify({ appId: id, token: tk, accountId: acc.account_id }));
      const url = await fetchOtpUrl(id, tk, acc.account_id);
      client.current?.close();
      const c = new DerivClient();
      client.current = c;
      c.onClose = () => { setStatus("off"); setAuto(false); addLog("Disconnected — press Connect to reopen"); };
      await c.connect(url);
      const isVirtual = acc.account_type === "demo";
      setAccount({ loginid: acc.account_id, currency: acc.currency, isVirtual });
      setBalance(Number(acc.balance));
      c.on("balance", (m) => setBalance(Number(m.balance.balance)));
      await c.send({ balance: 1, subscribe: 1 }).catch(() => {});
      try {
        const s = await c.send({ active_symbols: "brief" });
        const live = (s.active_symbols as any[]).map((x) => {
          const sym = x.underlying_symbol ?? x.symbol;
          return { symbol: sym, name: x.underlying_symbol_name ?? x.display_name ?? sym, group: groupOf(sym, String(x.market ?? "")), open: !!(x.exchange_is_open ?? true), pip: Number(x.pip ?? x.pip_size) || undefined };
        });
        if (live.length) setInstruments(live);
      } catch (e: any) { addLog(`Symbols list error: ${e.message} — using built-in list`); }
      c.on("tick", (m) => { if (m.tick?.symbol === undefined || m.tick.symbol === symbolRef.current) setPrices((p) => [...p, Number(m.tick.quote)].slice(-500)); });
      setStatus("on");
      addLog(`Connected ${acc.account_id} (${isVirtual ? "DEMO" : "REAL"})`);
    } catch (e: any) {
      setStatus("off");
      setError(e.message || "Connection failed");
    }
  };

  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    const c = client.current;
    if (status !== "on" || !c) return;
    (async () => {
      if (tickSub.current) await c.send({ forget: tickSub.current }).catch(() => {});
      tickSub.current = null;
      setPrices([]);
      try {
        const h = await c.send({ ticks_history: symbol, count: 500, end: "latest", style: "ticks" });
        setPrices((h.history.prices as number[]).map(Number));
        const r = await c.send({ ticks: symbol, subscribe: 1 });
        tickSub.current = r.subscription?.id ?? null;
      } catch (e: any) { addLog(`Ticks error on ${symbol}: ${e.message}`); }
    })();
  }, [symbol, status]);

  const runScan = async () => {
    const c = client.current;
    if (!c) return;
    setScanning(true);
    const rows: ScanRow[] = [];
    const list = instruments.filter((i) => i.open !== false);
    for (const i of list) {
      try {
        const h = await c.send({ ticks_history: i.symbol, count: 200, end: "latest", style: "ticks" });
        const p = (h.history.prices as number[]).map(Number);
        const s = computeSignal(p);
        rows.push({ symbol: i.symbol, name: i.name, group: i.group, trend: trendStrength(p), conf: s.confidence, dir: s.dir === "CALL" ? "UP" : s.dir === "PUT" ? "DOWN" : "—" });
        setScan([...rows].sort((a, b) => b.conf + b.trend - (a.conf + a.trend)));
      } catch {}
    }
    setScanning(false);
    addLog(`Scan done: ${rows.length} instruments ranked`);
  };

  const placeTrade = useCallback(async (side: 0 | 1, amount: number) => {
    const c = client.current;
    if (!c || !account) return null;
    setBusy(true);
    const ct = def.types[side];
    const req: Record<string, unknown> = {
      proposal: 1, amount: Number(amount.toFixed(2)), basis: "stake", contract_type: ct,
      currency: account.currency, duration, duration_unit: unit, underlying_symbol: symbol,
    };
    const sgn = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    if (def.barrier === "digit") req["barrier"] = String(digit);
    if (def.barrier === "offset") req["barrier"] = sgn(offset);
    if (def.barrier === "range") { req["barrier"] = sgn(hi); req["barrier2"] = sgn(lo); }
    const label = `${def.sides[side]}${def.barrier === "digit" ? ` ${digit}` : ""}`;
    try {
      const p = await c.send(req);
      const b = await c.send({ buy: p.proposal.id, price: Number(amount.toFixed(2)) });
      const id = b.buy.contract_id as number;
      setTrades((t) => [{ id, label, stake: amount, profit: null, symbol, time: new Date().toLocaleTimeString() }, ...t]);
      addLog(`BUY ${label} ${amount.toFixed(2)} on ${symbol} #${id}`);
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
  }, [account, duration, unit, symbol, def, digit, offset, hi, lo]);

  /** Places one phased digit contract (Differs → Over 2 → Under 7 cycle), 1 tick. */
  const placeBrsTrade = useCallback(async (step: number, amount: number) => {
    const c = client.current;
    if (!c || !account) return null;
    const phase = BRS_PHASES[step % BRS_PHASES.length]!;
    setBusy(true);
    try {
      const p = await c.send({
        proposal: 1, amount: Number(amount.toFixed(2)), basis: "stake", contract_type: phase.kind,
        currency: account.currency, duration: 1, duration_unit: "t", underlying_symbol: symbol, barrier: String(phase.barrier),
      });
      const b = await c.send({ buy: p.proposal.id, price: Number(amount.toFixed(2)) });
      const id = b.buy.contract_id as number;
      setTrades((t) => [{ id, label: `BRS ${phase.label}`, stake: amount, profit: null, symbol, time: new Date().toLocaleTimeString() }, ...t]);
      addLog(`BUY BRS ${phase.label} ${amount.toFixed(2)} on ${symbol} #${id}`);
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
  }, [account, symbol]);

  /** Fires n orders of the given side(s) together; each settles separately. */
  const bulkTrade = (side: 0 | 1 | "both", n: number) => {
    if (status !== "on") return;
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < n; i++) {
      if (side === 0 || side === "both") jobs.push(placeTrade(0, stake));
      if (side === 1 || side === "both") jobs.push(placeTrade(1, stake));
    }
    addLog(`Bulk execute: ${jobs.length} orders dispatched`);
    void Promise.allSettled(jobs);
  };

  useEffect(() => {
    if (!auto || busy || status !== "on") return;
    if (net <= -maxLoss) { setAuto(false); addLog("Stopped: loss limit reached"); return; }
    if (net >= takeProfit) { setAuto(false); addLog("Stopped: profit target reached"); return; }
    if (trades.length >= maxTrades) { setAuto(false); addLog("Stopped: max trades reached"); return; }
    if (streak.current >= lossStreakStop) { setAuto(false); addLog(`Stopped: ${streak.current} losses in a row`); return; }
    const amt = curStake.current;
    if (brs) {
      placeBrsTrade(brsStep, amt).then((r) => {
        if (r == null) return;
        streak.current = r > 0 ? 0 : streak.current + 1;
        if (r > 0) {
          brsLevel.current = 0;
          curStake.current = stake;
          setBrsStep((s) => s + 1);
        } else {
          brsLevel.current += 1;
          if (brsLevel.current >= brsLevels) { setAuto(false); addLog(`Stopped: ${brsLevels} recovery levels used`); return; }
          curStake.current = Math.min(amt * brsMult, maxStake);
        }
      });
      return;
    }
    if (sig.side === null || sig.confidence < minConf) return;
    if (mode === "SIDE_A" && sig.side !== 0) return;
    if (mode === "SIDE_B" && sig.side !== 1) return;
    placeTrade(sig.side, amt).then((r) => {
      if (r == null) return;
      streak.current = r > 0 ? 0 : streak.current + 1;
      curStake.current = r > 0 ? stake : Math.min(amt * Math.min(martingale, 2), maxStake);
    });
  }, [auto, busy, prices.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const startAuto = () => {
    if (account && !account.isVirtual && !confirm("REAL MONEY account. Start autopilot with real funds?")) return;
    curStake.current = stake;
    streak.current = 0;
    setAuto(true);
    addLog(`Autopilot ON (${def.label})`);
  };

  const last = prices[prices.length - 1];
  const view = prices.slice(-100);
  const min = Math.min(...view), max = Math.max(...view);
  const pts = view.map((p, i) => `${i * 4},${100 - ((p - min) / (max - min || 1)) * 100}`).join(" ");

  const engineStats = (Object.keys(ENGINES) as EngineId[]).map((id) => ({ id, ...runEngine(id, prices) }));
  const j = journal(trades);
  const eqMin = Math.min(0, ...j.curve), eqMax = Math.max(0, ...j.curve);
  const eqPts = j.curve.map((v, i) => `${(i / Math.max(1, j.curve.length - 1)) * 200},${40 - ((v - eqMin) / (eqMax - eqMin || 1)) * 40}`).join(" ");

  const field = "rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground";
  const num = (v: number, set: (n: number) => void, label: string, step = 1) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <input type="number" step={step} value={v} onChange={(e) => set(Number(e.target.value))} className={field} />
    </label>
  );

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h1 className="text-lg font-bold tracking-tight">MWASE <span className="text-primary">DERIV BOT</span></h1>
        <div className="flex items-center gap-2 text-xs">
          <span className={`h-2.5 w-2.5 rounded-full ${status === "on" ? "bg-up" : status === "connecting" ? "bg-primary" : "bg-down"}`} />
          {status === "on" && account ? `${account.loginid} · ${account.isVirtual ? "DEMO" : "REAL"}` : status}
        </div>
      </header>

      {scan.length > 0 && (
        <div className="overflow-hidden border-b border-border bg-card py-1.5">
          <div className="flex animate-pulse flex-wrap gap-x-6 gap-y-1 px-4 font-mono text-xs">
            {scan.slice(0, 20).map((r) => (
              <button key={r.symbol} onClick={() => setSymbol(r.symbol)} className="flex gap-1.5">
                <span className="text-muted-foreground">{r.name}</span>
                <span className={r.dir === "UP" ? "text-up" : r.dir === "DOWN" ? "text-down" : ""}>{r.dir === "UP" ? "▲" : r.dir === "DOWN" ? "▼" : "•"} {r.conf}%</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-3">
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="font-semibold">Deriv connection</h2>
          <label className="block text-xs text-muted-foreground">App ID
            <input value={appId} onChange={(e) => setAppId(e.target.value)} className={`mt-1 w-full ${field}`} />
          </label>
          <label className="block text-xs text-muted-foreground">Personal Access Token (pat_…, needs "trade" scope)
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} className={`mt-1 w-full ${field}`} />
          </label>
          {accounts.length > 0 && (
            <label className="block text-xs text-muted-foreground">Account
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={`mt-1 w-full ${field}`}>
                {accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_id} · {a.account_type.toUpperCase()} · {a.currency}</option>)}
              </select>
            </label>
          )}
          <p className="text-xs text-muted-foreground">Get both from developers.deriv.com. Saved only in this browser. Use a demo token to test.</p>
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
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className={field}>
                {GROUPS.map((g) => {
                  const items = instruments.filter((i) => i.group === g);
                  return items.length ? (
                    <optgroup key={g} label={`${g} (${items.length})`}>
                      {items.map((i) => <option key={i.symbol} value={i.symbol}>{i.name}{i.open === false ? " (closed)" : ""}</option>)}
                    </optgroup>
                  ) : null;
                })}
              </select>
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={field}>
                {(Object.keys(CONTRACTS) as Kind[]).map((k) => <option key={k} value={k}>{CONTRACTS[k].label}</option>)}
              </select>
              <span className="ml-auto font-mono text-lg">{last?.toFixed(decimals) ?? "—"}</span>
            </div>
            <svg viewBox="0 0 400 100" preserveAspectRatio="none" className="h-40 w-full">
              {def.barrier === "offset" && last != null && <line x1="0" x2="400" y1={100 - ((last + offset - min) / (max - min || 1)) * 100} y2={100 - ((last + offset - min) / (max - min || 1)) * 100} stroke="var(--primary)" strokeDasharray="4 3" strokeWidth="0.8" />}
              {def.barrier === "range" && last != null && [hi, lo].map((b) => { const y = 100 - ((last + b - min) / (max - min || 1)) * 100; return <line key={b} x1="0" x2="400" y1={y} y2={y} stroke="var(--primary)" strokeDasharray="4 3" strokeWidth="0.8" />; })}
              <polyline points={pts} fill="none" stroke="var(--up)" strokeWidth="1.5" />
            </svg>

            {stats && (
              <div className="mt-2 grid grid-cols-10 gap-1 text-center font-mono text-xs">
                {stats.counts.map((c, d) => {
                  const p = stats.total ? (c / stats.total) * 100 : 0;
                  return (
                    <button key={d} onClick={() => setDigit(d)} className={`rounded border py-1 ${d === digit ? "border-primary bg-primary/20" : "border-border"} ${p >= 12 ? "text-up" : p <= 8 ? "text-down" : ""}`}>
                      <div className="font-bold">{d}</div><div>{p.toFixed(0)}%</div>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs text-muted-foreground">{def.label} signal</div>
                <div className={`text-2xl font-bold ${sig.side === 0 ? "text-up" : sig.side === 1 ? "text-down" : ""}`}>
                  {sig.side === null ? "WAIT" : def.sides[sig.side]} <span className="font-mono text-base">{sig.confidence}%</span>
                </div>
                <div className="text-xs text-muted-foreground">{sig.note}</div>
                {!def.digits && (
                  <ul className="mt-2 space-y-0.5 text-xs">
                    {base.parts.map((p) => (
                      <li key={p.name} className="flex gap-2">
                        <span className={p.bias === "CALL" ? "text-up" : p.bias === "PUT" ? "text-down" : "text-muted-foreground"}>{p.bias === "CALL" ? "▲" : p.bias === "PUT" ? "▼" : "•"}</span>
                        <span className="text-muted-foreground">{p.name}:</span><span>{p.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex gap-2">
                <button disabled={status !== "on" || busy} onClick={() => placeTrade(0, stake)} className="rounded-md bg-up px-5 py-3 font-bold text-primary-foreground disabled:opacity-40">{def.sides[0]}</button>
                <button disabled={status !== "on" || busy} onClick={() => placeTrade(1, stake)} className="rounded-md bg-down px-5 py-3 font-bold text-primary-foreground disabled:opacity-40">{def.sides[1]}</button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button disabled={status !== "on"} onClick={() => bulkTrade(0, 9)} className="rounded-md border border-up px-3 py-1.5 text-xs font-semibold text-up disabled:opacity-40">9× {def.sides[0]}</button>
              <button disabled={status !== "on"} onClick={() => bulkTrade(1, 9)} className="rounded-md border border-down px-3 py-1.5 text-xs font-semibold text-down disabled:opacity-40">9× {def.sides[1]}</button>
              <button disabled={status !== "on"} onClick={() => bulkTrade("both", 9)} className="rounded-md border border-primary px-3 py-1.5 text-xs font-semibold text-primary disabled:opacity-40">⚡ 9× Double (both sides)</button>
              <span className="text-xs text-muted-foreground">9 orders per side · dispatched together · separate confirmations</span>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 lg:col-span-3">
          <h2 className="mb-1 font-semibold">Demo strategy comparison <span className="text-xs font-normal text-muted-foreground">— paper trades on live ticks, no real orders</span></h2>
          <div className="grid gap-3 md:grid-cols-3">
            {engineStats.map((e) => {
              const settledN = e.wins + e.losses;
              const wr = settledN ? Math.round((e.wins / settledN) * 100) : null;
              return (
                <button key={e.id} onClick={() => setEngine(e.id)} className={`rounded-lg border p-3 text-left ${engine === e.id ? "border-primary bg-primary/10" : "border-border"}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">Engine {e.id}: {ENGINES[e.id].name}</span>
                    <span className={`font-mono text-sm ${e.net >= 0 ? "text-up" : "text-down"}`}>{e.net.toFixed(2)}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{ENGINES[e.id].desc}</div>
                  <div className="mt-2 grid grid-cols-3 gap-1 font-mono text-xs">
                    <span>{e.wins}W / {e.losses}L / {e.flat} flat</span>
                    <span>Win rate {wr == null ? "—" : `${wr}%`}</span>
                    <span>Pending {e.pending}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{e.note}</div>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Engine {engine} selected. Paper results use a fixed 1-unit stake and 0.95 payout over {prices.length} ticks — they are estimates, not guarantees.</p>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="font-semibold">Trade parameters & risk</h2>
          <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1 text-xs">
            {(["SIDE_A", "SIDE_B", "SIGNAL"] as Mode[]).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`rounded py-1.5 ${mode === m ? "bg-primary text-primary-foreground" : ""}`}>
                {m === "SIDE_A" ? `Only ${def.sides[0].replace(/[▲▼] /, "")}` : m === "SIDE_B" ? `Only ${def.sides[1].replace(/[▲▼] /, "")}` : "Follow signal"}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {num(stake, setStake, "Stake", 0.01)}
            <div className="flex gap-1">
              <div className="flex-1">{num(duration, setDuration, "Duration")}</div>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">Unit
                <select value={unit} disabled={def.digits} onChange={(e) => setUnit(e.target.value as Unit)} className={field}>
                  <option value="t">Ticks</option><option value="s">Seconds</option><option value="m">Minutes</option>
                </select>
              </label>
            </div>
            {def.barrier === "digit" && num(digit, (n) => setDigit(Math.max(0, Math.min(9, Math.round(n)))), "Prediction digit (0-9)")}
            {def.barrier === "offset" && num(offset, setOffset, "Barrier offset (+/-)", 0.01)}
            {def.barrier === "range" && <>{num(hi, setHi, "High barrier offset (+)", 0.01)}{num(lo, setLo, "Low barrier offset (-)", 0.01)}</>}
            {num(minConf, setMinConf, "Min confidence %")}
            {num(martingale, (n) => setMartingale(Math.min(2, Math.max(1, n))), "Loss multiplier (1-2)", 0.1)}
            {num(maxStake, setMaxStake, "Max stake cap", 0.1)}
            {num(lossStreakStop, setLossStreakStop, "Stop after N losses")}
            {num(maxLoss, setMaxLoss, "Loss limit")}
            {num(takeProfit, setTakeProfit, "Profit target")}
            {num(maxTrades, setMaxTrades, "Max trades")}
          </div>
          <div className="rounded-md border border-border p-2">
            <label className="flex items-center gap-2 text-xs font-semibold">
              <input type="checkbox" checked={brs} onChange={(e) => setBrs(e.target.checked)} />
              Phased digit cycle (Differs 5 → Over 2 → Under 7, 1 tick)
            </label>
            {brs && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {num(brsLevels, (n) => setBrsLevels(Math.max(1, Math.min(7, Math.round(n)))), "Max recovery levels")}
                {num(brsMult, (n) => setBrsMult(Math.max(1, n)), "Recovery multiplier", 0.05)}
                <div className="col-span-2 text-xs text-muted-foreground">Next phase: {brsPhaseLabel(brsStep)} · Recovery level {brsLevel.current}/{brsLevels}</div>
              </div>
            )}
          </div>
          {auto ? (
            <button onClick={() => { setAuto(false); addLog("Autopilot OFF"); }} className="w-full rounded-md bg-down py-3 font-bold text-primary-foreground">STOP AUTOPILOT</button>
          ) : (
            <button disabled={status !== "on"} onClick={startAuto} className="w-full rounded-md bg-up py-3 font-bold text-primary-foreground disabled:opacity-40">START AUTOPILOT</button>
          )}
          <p className="text-xs text-muted-foreground">No strategy guarantees profit. Autopilot stops at your loss limit, profit target, trade cap or loss streak.</p>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">Market scanner</h2>
            <button disabled={status !== "on" || scanning} onClick={runScan} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-40">
              {scanning ? `Scanning… ${scan.length}` : "Scan all markets"}
            </button>
          </div>
          {status !== "on" && <p className="text-xs text-muted-foreground">Connect to rank all {instruments.length} instruments by trend strength and signal confidence.</p>}
          <div className="max-h-80 overflow-auto">
            <table className="w-full font-mono text-xs">
              <thead className="text-muted-foreground"><tr><th className="text-left">#</th><th className="text-left">Instrument</th><th className="text-left">Group</th><th>Trend</th><th>Conf</th><th>Bias</th><th /></tr></thead>
              <tbody>
                {scan.map((r, i) => (
                  <tr key={r.symbol} className="border-t border-border">
                    <td>{i + 1}</td><td>{r.name}</td><td className="text-muted-foreground">{r.group}</td>
                    <td className="text-center">{r.trend}</td><td className="text-center">{r.conf}%</td>
                    <td className={`text-center font-bold ${r.dir === "UP" ? "text-up" : r.dir === "DOWN" ? "text-down" : ""}`}>{r.dir}</td>
                    <td><button onClick={() => setSymbol(r.symbol)} className="rounded border border-primary px-2 text-primary">Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-2 font-semibold">Trade history</h2>
          <div className="max-h-80 space-y-1 overflow-auto font-mono text-xs">
            {trades.length === 0 && <p className="text-muted-foreground">No trades yet.</p>}
            {trades.map((t) => (
              <div key={t.id} className="flex justify-between border-b border-border py-1">
                <span>{t.time} {t.label} {t.symbol}</span>
                <span className={t.profit == null ? "text-muted-foreground" : t.profit > 0 ? "text-up" : "text-down"}>{t.profit == null ? "open" : t.profit.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-2 font-semibold">Saved settings</h2>
          <div className="flex gap-2">
            <input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="Profile name" className={field} />
            <button onClick={saveProfile} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground">Save</button>
          </div>
          <div className="mt-2 space-y-1">
            {profiles.length === 0 && <p className="text-xs text-muted-foreground">No saved profiles yet.</p>}
            {profiles.map((p) => (
              <div key={p.name} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{p.name}</span>
                <span className="flex gap-1">
                  <button onClick={() => applySettings(p.settings)} className="rounded border border-primary px-2 text-xs text-primary">Load</button>
                  <button onClick={() => { const next = profiles.filter((x) => x.name !== p.name); setProfiles(next); localStorage.setItem(LS_PROFILES, JSON.stringify(next)); }} className="rounded border border-down px-2 text-xs text-down">✕</button>
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2 text-xs">
            <button onClick={exportProfiles} disabled={!profiles.length} className="rounded border border-border px-2 py-1 disabled:opacity-40">Export file</button>
            <label className="cursor-pointer rounded border border-border px-2 py-1">
              Import file
              <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importProfiles(e.target.files[0])} />
            </label>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 lg:col-span-2">
          <h2 className="mb-2 font-semibold">Performance journal</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["Win rate", j.winRate == null ? "—" : `${j.winRate.toFixed(0)}%`],
              ["Profit factor", j.profitFactor == null ? "—" : j.profitFactor === Infinity ? "∞" : j.profitFactor.toFixed(2)],
              ["Max drawdown", j.maxDrawdown.toFixed(2)],
              ["Best / worst streak", `${j.bestWin}W / ${j.bestLoss}L`],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className="font-mono text-lg font-semibold">{v}</div>
              </div>
            ))}
          </div>
          {j.curve.length > 1 ? (
            <svg viewBox="0 0 200 40" preserveAspectRatio="none" className="mt-3 h-20 w-full">
              <polyline points={eqPts} fill="none" stroke="var(--primary)" strokeWidth="1.5" />
            </svg>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">Equity curve appears after trades settle.</p>
          )}
        </section>

        <section className="rounded-xl border border-border bg-card p-4 lg:col-span-2">
          <h2 className="mb-2 font-semibold">Activity log</h2>
          <div className="max-h-80 overflow-auto font-mono text-xs text-muted-foreground">
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </section>

        <DiagnosePanel error={error} log={log} appId={appId} />
      </main>
    </div>
  );
}
