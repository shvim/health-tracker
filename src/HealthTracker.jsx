import { useState, useEffect, useMemo } from "react";
import { loadEntries, saveEntries, signInWithGoogle, signOutGoogle, subscribeAuth } from "./firebase.js";

const STORAGE_KEY = "health-tracker-v3";
const today = () => new Date().toISOString().split("T")[0];
const fmtShort = (d) => { const [y,m,day] = d.split("-"); return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m-1]} ${+day}`; };
const fmtFull = (d) => { const [y,m,day] = d.split("-"); return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m-1]} ${+day}, ${y}`; };

const METRICS = [
  { key: "weight", label: "Weight", unit: "lbs", color: "#111", barColor: "#111" },
  { key: "bpSys", label: "BP Sys", unit: "mmHg", color: "#ef4444", barColor: "#ef4444" },
  { key: "bpDia", label: "BP Dia", unit: "mmHg", color: "#f97316", barColor: "#f97316" },
  { key: "diet", label: "Diet", unit: "/5", color: "#8b5cf6", barColor: "#8b5cf6", fixedMin: 0, fixedMax: 5 },
  { key: "fasting", label: "Fasting", unit: "hrs", color: "#06b6d4", barColor: "#06b6d4", fixedMin: 0, fixedMax: 36 },
  { key: "smokes", label: "Sm/Day", unit: "", color: "#eab308", barColor: "#eab308", fixedMin: 0, fixedMax: 10 },
  { key: "sleep", label: "Sleep", unit: "hrs", color: "#6366f1", barColor: "#6366f1", fixedMin: 0, fixedMax: 9 },
  { key: "mood", label: "Mood", unit: "/5", color: "#ec4899", barColor: "#ec4899", fixedMin: 0, fixedMax: 5 },
];

const EXPORT_COLUMNS = [
  { key: "date", label: "Date", value: (e) => fmtFull(e.date) },
  { key: "weight", label: "Weight (lbs)", value: (e) => e.weight },
  { key: "bpAm", label: "AM BP", value: (e) => formatBp(e.bpAmSys, e.bpAmDia) },
  { key: "bpPm", label: "PM BP", value: (e) => formatBp(e.bpPmSys, e.bpPmDia) },
  { key: "diet", label: "Diet (/5)", value: (e) => e.diet },
  { key: "fasting", label: "Fasting (hrs)", value: (e) => e.fasting },
  { key: "smokes", label: "Smokes/day", value: (e) => e.smokes },
  { key: "isometric", label: "Isometric", value: (e) => e.isometric ? "Yes" : "No" },
  { key: "sleep", label: "Sleep (hrs)", value: (e) => e.sleep },
  { key: "mood", label: "Mood (/5)", value: (e) => e.mood },
];

function formatBp(sys, dia) {
  return sys && dia ? `${sys}/${dia}` : "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function getMetricValue(entry, key) {
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  if (key === "bpSys") return num(entry.bpAmSys) || num(entry.bpPmSys);
  if (key === "bpDia") return num(entry.bpAmDia) || num(entry.bpPmDia);
  if (key === "diet") return entry.diet || 0;
  if (key === "fasting") return num(entry.fasting);
  if (key === "smokes") return num(entry.smokes);
  if (key === "sleep") return num(entry.sleep);
  if (key === "mood") return entry.mood || 0;
  return num(entry[key]);
}

function getRange(metric, vals) {
  const m = METRICS.find(x => x.key === metric);
  if (m?.fixedMin !== undefined) return { min: m.fixedMin, max: m.fixedMax, range: m.fixedMax - m.fixedMin };
  const nonZero = vals.filter(v => v > 0);
  if (nonZero.length === 0) return { min: 0, max: 1, range: 1 };
  const max = Math.max(...nonZero);
  const min = Math.min(...nonZero);
  const spread = max - min || 1;
  const pad = spread * 0.25;
  const floor = Math.max(0, min - pad);
  const ceil = max + pad * 0.5;
  return { min: floor, max: ceil, range: ceil - floor };
}

export default function HealthTracker() {
  const [entries, setEntries] = useState([]);
  const [tab, setTab] = useState("log");
  const [saved, setSaved] = useState(false);
  const [authInfo, setAuthInfo] = useState({ ready: false, signedIn: false, isAnonymous: false, label: "Not signed in" });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [editId, setEditId] = useState(null);
  const blank = { date: today(), weight: "", bpAmSys: "", bpAmDia: "", bpPmSys: "", bpPmDia: "", diet: 3, fasting: "", smokes: "", isometric: false, sleep: "", mood: 3 };
  const [form, setForm] = useState(blank);
  const [activeMetrics, setActiveMetrics] = useState(["weight"]);
  const [activeBarMetrics, setActiveBarMetrics] = useState(["weight"]);
  const toggleBarMetric = (key) => setActiveBarMetrics(prev => prev.includes(key) ? (prev.length > 1 ? prev.filter(k => k !== key) : prev) : [...prev, key]);
  const [filterMode, setFilterMode] = useState("all");
  const [filterValue, setFilterValue] = useState("");
  const [exportColumns, setExportColumns] = useState(EXPORT_COLUMNS.map(c => c.key));

  useEffect(() => {
    const unsubscribe = subscribeAuth(setAuthInfo);
    (async () => {
      try {
        setEntries(await loadEntries(STORAGE_KEY));
      } catch {
        const localValue = localStorage.getItem(STORAGE_KEY);
        if (localValue) setEntries(JSON.parse(localValue));
      }
    })();
    return unsubscribe;
  }, []);

  const persist = async (d) => { try { await saveEntries(STORAGE_KEY, d); } catch {} };

  const connectGoogle = async () => {
    setAuthBusy(true);
    setAuthError("");
    try {
      const result = await signInWithGoogle(STORAGE_KEY);
      if (result.user) setEntries(result.entries);
    } catch (error) {
      setAuthError(error.code === "auth/popup-blocked" ? "Allow popups for this site, then tap Sign in again." : error.message || "Google sign-in failed.");
    } finally {
      setAuthBusy(false);
    }
  };

  const disconnectGoogle = async () => {
    setAuthBusy(true);
    setAuthError("");
    try {
      await signOutGoogle();
      setEntries([]);
    } finally {
      setAuthBusy(false);
    }
  };

  const save = async () => {
    if (!form.date || !form.weight) return;
    let updated;
    if (editId !== null) {
      updated = entries.map(e => e.id === editId ? { ...form, id: editId } : e);
      setEditId(null);
    } else {
      const entry = { ...form, id: Date.now() };
      const idx = entries.findIndex(e => e.date === form.date);
      if (idx >= 0) { updated = [...entries]; updated[idx] = entry; }
      else { updated = [...entries, entry]; }
    }
    updated.sort((a, b) => b.date.localeCompare(a.date));
    setEntries(updated);
    await persist(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
    setForm(blank);
  };

  const startEdit = (e) => { setForm({ ...e }); setEditId(e.id); setTab("log"); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const cancelEdit = () => { setEditId(null); setForm(blank); };
  const del = async (id) => { const u = entries.filter(e => e.id !== id); setEntries(u); await persist(u); if (editId === id) cancelEdit(); };

  const totalLost = useMemo(() => {
    if (entries.length < 2) return null;
    return (parseFloat(entries[entries.length - 1].weight) - parseFloat(entries[0].weight)).toFixed(1);
  }, [entries]);

  const filtered = useMemo(() => {
    if (filterMode === "all" || !filterValue) return entries;
    return entries.filter(e => {
      const [y, m] = e.date.split("-");
      if (filterMode === "year") return y === filterValue;
      if (filterMode === "month") return `${y}-${m}` === filterValue;
      if (filterMode === "day") return e.date === filterValue;
      return true;
    });
  }, [entries, filterMode, filterValue]);

  const availableYears = useMemo(() => [...new Set(entries.map(e => e.date.split("-")[0]))].sort(), [entries]);
  const availableMonths = useMemo(() => [...new Set(entries.map(e => e.date.slice(0, 7)))].sort().reverse(), [entries]);
  const chartData = useMemo(() => [...filtered].reverse().slice(-30), [filtered]);

  const f = (key, val) => setForm(p => ({ ...p, [key]: val }));
  const toggleMetric = (key) => setActiveMetrics(prev => prev.includes(key) ? (prev.length > 1 ? prev.filter(k => k !== key) : prev) : [...prev, key]);
  const toggleExportColumn = (key) => setExportColumns(prev => prev.includes(key) ? (prev.length > 1 ? prev.filter(k => k !== key) : prev) : [...prev, key]);
  const avg = (arr, fn) => { const vals = arr.map(fn).filter(v => v > 0); return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0; };

  const selectedExportColumns = useMemo(
    () => EXPORT_COLUMNS.filter(c => exportColumns.includes(c.key)),
    [exportColumns]
  );

  const exportRows = useMemo(
    () => [...filtered].sort((a, b) => a.date.localeCompare(b.date)),
    [filtered]
  );

  const exportLabel = useMemo(() => {
    if (filterMode === "all" || !filterValue) return "All Entries";
    if (filterMode === "year") return filterValue;
    if (filterMode === "month") {
      const [y, m] = filterValue.split("-");
      return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m - 1]} ${y}`;
    }
    return fmtFull(filterValue);
  }, [filterMode, filterValue]);

  const exportFilename = (ext) => `health-tracker-${filterValue || filterMode}-${today()}.${ext}`;

  const downloadExcel = () => {
    if (!exportRows.length) return;
    const header = selectedExportColumns.map(c => csvCell(c.label)).join(",");
    const body = exportRows.map(row => selectedExportColumns.map(c => csvCell(c.value(row))).join(",")).join("\n");
    const blob = new Blob([`\uFEFF${header}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename("csv");
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadPdf = () => {
    if (!exportRows.length) return;
    const columns = selectedExportColumns;
    const rowsHtml = exportRows.map(row => (
      `<tr>${columns.map(c => `<td>${escapeHtml(c.value(row))}</td>`).join("")}</tr>`
    )).join("");
    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Health Tracker ${escapeHtml(exportLabel)}</title>
          <style>
            @page { size: landscape; margin: 0.4in; }
            * { box-sizing: border-box; }
            body { font-family: Arial, sans-serif; color: #111; margin: 0; }
            h1 { font-size: 20px; margin: 0 0 4px; }
            .meta { color: #555; font-size: 11px; margin-bottom: 14px; }
            table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10px; }
            th { background: #111; color: #fff; text-align: left; padding: 7px 6px; border: 1px solid #111; }
            td { padding: 6px; border: 1px solid #d8d8d8; vertical-align: top; word-break: break-word; }
            tr:nth-child(even) td { background: #f7f7f7; }
          </style>
        </head>
        <body>
          <h1>Health Tracker</h1>
          <div class="meta">${escapeHtml(exportLabel)} · ${exportRows.length} entries · Generated ${escapeHtml(fmtFull(today()))}</div>
          <table>
            <thead><tr>${columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join("")}</tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <script>
            window.addEventListener("load", () => {
              window.focus();
              window.print();
            });
          </script>
        </body>
      </html>`;
    const report = window.open("", "_blank");
    if (!report) {
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFilename("html");
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    report.document.open();
    report.document.write(html);
    report.document.close();
  };

  return (
    <div style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: "#f8f8fa", minHeight: "100vh", color: "#111" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
        input[type=date] { -webkit-appearance: none; appearance: none; }
        input[type=date]::-webkit-date-and-time-value { text-align: center; }
        ::-webkit-scrollbar { height: 4px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #ddd; border-radius: 4px; }
        @media (max-width: 520px) {
          .grid-2 { grid-template-columns: 1fr !important; }
          .stat-row { flex-wrap: wrap !important; }
          .stat-row > div { min-width: calc(50% - 4px) !important; flex: unset !important; }
        }
      `}</style>

      <div style={{ background: "#fff", borderBottom: "1px solid #eee", padding: "18px 20px 14px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 580, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: -0.5 }}>Health Tracker</div>
              <div style={{ fontSize: 11, color: "#aaa", marginTop: 1, fontWeight: 500 }}>
                {entries.length === 0 ? "Start logging today" : `${entries.length} entries`}
                {totalLost && parseFloat(totalLost) > 0 ? ` · ${totalLost} lbs lost` : ""}
              </div>
              <div style={{ fontSize: 10, color: authInfo.signedIn ? "#16a34a" : "#aaa", marginTop: 3, fontWeight: 700 }}>
                {authInfo.ready ? (authInfo.signedIn ? `Signed in: ${authInfo.label}` : "Not signed in") : "Checking sign-in..."}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {authInfo.signedIn ? (
                <button onClick={disconnectGoogle} disabled={authBusy} title={`Signed in as ${authInfo.label}`} style={authBtn}>
                  {authBusy ? "..." : "Sign out"}
                </button>
              ) : (
                <button onClick={connectGoogle} disabled={authBusy} style={authBtn}>
                  {authBusy ? "..." : "Sign in"}
                </button>
              )}
              <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#111", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>M</span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 3, background: "#f3f3f5", borderRadius: 22, padding: 3 }}>
            {["log","history","trends"].map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                flex: 1, padding: "7px 0", borderRadius: 20, border: "none", cursor: "pointer",
                fontSize: 11, fontWeight: 600, letterSpacing: 0.4, transition: "all 0.2s",
                background: tab === t ? "#111" : "transparent", color: tab === t ? "#fff" : "#999",
              }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 580, margin: "0 auto", padding: "16px 16px 40px" }}>
        {authError && (
          <div style={{ background: "#fef2f2", border: "1px solid #fee2e2", borderRadius: 12, padding: "10px 12px", color: "#b91c1c", fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
            {authError}
          </div>
        )}

        {tab === "log" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {editId && (
              <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#92400e" }}>Editing {fmtFull(form.date)}</span>
                <button onClick={cancelEdit} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#92400e", textDecoration: "underline" }}>Cancel</button>
              </div>
            )}
            <Card>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Label>Date</Label>
                  <input type="date" value={form.date} onChange={e => f("date", e.target.value)} style={{ width: "100%", padding: "9px 11px", border: "1px solid #eee", borderRadius: 10, fontSize: 13, fontFamily: "'DM Mono', monospace", background: "#fafafa", outline: "none", boxSizing: "border-box", height: 40, WebkitAppearance: "none", appearance: "none", display: "block", lineHeight: "20px" }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Label>Weight <span style={{ color: "#ccc", fontWeight: 400 }}>lbs</span></Label>
                  <input type="number" placeholder="185.5" value={form.weight} onChange={e => f("weight", e.target.value)} step="0.1" style={{ width: "100%", padding: "9px 11px", border: "1px solid #eee", borderRadius: 10, fontSize: 14, fontFamily: "'DM Mono', monospace", background: "#fafafa", outline: "none", boxSizing: "border-box", height: 40, MozAppearance: "textfield" }} onFocus={e => e.target.style.borderColor="#111"} onBlur={e => e.target.style.borderColor="#eee"} />
                </div>
              </div>
            </Card>
            <Card>
              <Label>Blood Pressure</Label>
              <div className="grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 10, color: "#bbb", marginBottom: 5, fontWeight: 600, letterSpacing: 0.5 }}>AM</div>
                  <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    <Input type="number" placeholder="SYS" value={form.bpAmSys} onChange={e => f("bpAmSys", e.target.value)} mb={0} />
                    <span style={{ color: "#ddd", fontSize: 16 }}>/</span>
                    <Input type="number" placeholder="DIA" value={form.bpAmDia} onChange={e => f("bpAmDia", e.target.value)} mb={0} />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "#bbb", marginBottom: 5, fontWeight: 600, letterSpacing: 0.5 }}>PM</div>
                  <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    <Input type="number" placeholder="SYS" value={form.bpPmSys} onChange={e => f("bpPmSys", e.target.value)} mb={0} />
                    <span style={{ color: "#ddd", fontSize: 16 }}>/</span>
                    <Input type="number" placeholder="DIA" value={form.bpPmDia} onChange={e => f("bpPmDia", e.target.value)} mb={0} />
                  </div>
                </div>
              </div>
            </Card>
            <Card>
              <Label>Diet Level</Label>
              <div style={{ display: "flex", gap: 5, marginBottom: 14 }}>
                {[1,2,3,4,5].map(n => (
                  <button key={n} onClick={() => f("diet", n)} style={{
                    flex: 1, height: 38, borderRadius: 10, border: form.diet === n ? "2px solid #111" : "1px solid #eee",
                    background: form.diet === n ? "#111" : "#fff", color: form.diet === n ? "#fff" : "#888",
                    fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.15s"
                  }}>{n}</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                <div style={{ flex: 1, minWidth: 0 }}><Label>Fasting Hours</Label><Input type="number" placeholder="16" value={form.fasting} onChange={e => f("fasting", Math.min(36, Math.max(0, e.target.value)))} mb={0} /></div>
                <div style={{ flex: 1, minWidth: 0 }}><Label>Sm / Day</Label><Input type="number" placeholder="0" value={form.smokes} onChange={e => f("smokes", Math.min(10, Math.max(0, e.target.value)))} mb={0} /></div>
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Label>Hours Slept</Label>
                  <Input type="number" placeholder="7" value={form.sleep} onChange={e => f("sleep", Math.min(9, Math.max(0, e.target.value)))} min="0" max="9" step="0.5" mb={0} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Label>Mood</Label>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[1,2,3,4,5].map(n => (
                      <button key={n} onClick={() => f("mood", n)} style={{
                        flex: 1, height: 38, borderRadius: 10, border: form.mood === n ? "2px solid #ec4899" : "1px solid #eee",
                        background: form.mood === n ? "#ec4899" : "#fff", color: form.mood === n ? "#fff" : "#888",
                        fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.15s"
                      }}>{n}</button>
                    ))}
                  </div>
                </div>
              </div>
              <Label>Isometric Exercise</Label>
              <div style={{ display: "flex", gap: 5 }}>
                {[true, false].map(v => (
                  <button key={String(v)} onClick={() => f("isometric", v)} style={{
                    flex: 1, height: 38, borderRadius: 10, border: form.isometric === v ? "2px solid #111" : "1px solid #eee",
                    background: form.isometric === v ? "#111" : "#fff", color: form.isometric === v ? "#fff" : "#888",
                    fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s"
                  }}>{v ? "Yes" : "No"}</button>
                ))}
              </div>
            </Card>
            <button onClick={save} style={{
              width: "100%", padding: 13, borderRadius: 12, border: "none", cursor: "pointer",
              background: saved ? "#22c55e" : "#111", color: "#fff", fontSize: 13, fontWeight: 600,
              fontFamily: "Inter, sans-serif", transition: "all 0.25s"
            }}>{saved ? "✓ Saved" : editId ? "Update Entry" : "Save Entry"}</button>
          </div>
        )}

        {tab === "history" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <FilterBar {...{ filterMode, setFilterMode, filterValue, setFilterValue, availableYears, availableMonths }} />
            <ExportPanel
              columns={EXPORT_COLUMNS}
              selectedColumns={exportColumns}
              onToggleColumn={toggleExportColumn}
              onDownloadPdf={downloadPdf}
              onDownloadExcel={downloadExcel}
              rowCount={exportRows.length}
              label={exportLabel}
            />
            {filtered.length === 0 ? <Empty text="No entries for this period" /> : filtered.map((e, i) => {
              const prev = i < filtered.length - 1 ? filtered[i + 1] : null;
              const diff = prev ? (parseFloat(prev.weight) - parseFloat(e.weight)).toFixed(1) : null;
              return (
                <div key={e.id} style={{ background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1px solid #f0f0f0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>{fmtFull(e.date)}</span>
                        {diff && parseFloat(diff) !== 0 && <PillBadge positive={parseFloat(diff) > 0}>{parseFloat(diff) > 0 ? `-${diff}` : `+${Math.abs(parseFloat(diff))}`} lb</PillBadge>}
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5, marginBottom: 6 }}>{e.weight} <span style={{ fontSize: 12, color: "#ccc", fontWeight: 500 }}>lbs</span></div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {e.bpAmSys && <Tag>AM {e.bpAmSys}/{e.bpAmDia}</Tag>}
                        {e.bpPmSys && <Tag>PM {e.bpPmSys}/{e.bpPmDia}</Tag>}
                        {e.diet && <Tag>Diet {e.diet}/5</Tag>}
                        {e.fasting && <Tag>{e.fasting}h fast</Tag>}
                        {e.smokes && <Tag>{e.smokes} sm</Tag>}
                        {e.sleep && <Tag>😴 {e.sleep}h</Tag>}
                        {e.mood && <Tag>Mood {e.mood}/5</Tag>}
                        {e.isometric && <Tag accent>Iso ✓</Tag>}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 2 }}>
                      <button onClick={() => startEdit(e)} style={iconBtn}>✎</button>
                      <button onClick={() => del(e.id)} style={{ ...iconBtn, color: "#ddd", fontSize: 16 }}>×</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === "trends" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <FilterBar {...{ filterMode, setFilterMode, filterValue, setFilterValue, availableYears, availableMonths }} />

            {chartData.length < 2 ? <Empty text="Add 2+ entries to see trends" /> : (
              <>
                {/* CURVE CHART */}
                <Card>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                    <Label style={{ marginBottom: 0 }}>Trend Lines</Label>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {METRICS.map(m => (
                        <button key={m.key} onClick={() => toggleMetric(m.key)} style={{
                          fontSize: 9, fontWeight: 700, padding: "3px 9px", borderRadius: 10, cursor: "pointer", transition: "all 0.15s",
                          border: activeMetrics.includes(m.key) ? `2px solid ${m.color}` : "1px solid #eee",
                          background: activeMetrics.includes(m.key) ? m.color + "14" : "#fff",
                          color: activeMetrics.includes(m.key) ? m.color : "#ccc"
                        }}>{m.label}</button>
                      ))}
                    </div>
                  </div>
                  <div style={{ overflowX: "auto", paddingBottom: 4 }}>
                    {(() => {
                      // Each entry gets 44px wide. Chart area: y=20 to y=120 (100px tall). Labels at y=135.
                      const CHART_H = 100; const TOP = 20; const BOTTOM = TOP + CHART_H;
                      const colW = 44;
                      const svgW = Math.max(chartData.length * colW, 240);
                      const svgH = 148;
                      return (
                        <svg width="100%" viewBox={`0 0 ${svgW} ${svgH}`} style={{ overflow: "visible", minWidth: chartData.length * 32 }}>
                          {[0, 0.5, 1].map(frac => (
                            <line key={frac} x1={0} y1={TOP + frac * CHART_H} x2={svgW} y2={TOP + frac * CHART_H} stroke="#f3f3f5" strokeWidth="1" />
                          ))}
                          {(() => {
                            // PASS 1: Compute all curve data
                            const allCurves = activeMetrics.map((mk, mIdx) => {
                              const m = METRICS.find(x => x.key === mk);
                              const vals = chartData.map(e => getMetricValue(e, mk));
                              const { min, range } = getRange(mk, vals);
                              const points = chartData.map((e, i) => {
                                const v = getMetricValue(e, mk);
                                if (v === 0) return null;
                                const y = TOP + (1 - (v - min) / range) * CHART_H;
                                return { x: i * colW + colW / 2, y: Math.max(TOP + 1, Math.min(BOTTOM - 1, y)), v };
                              }).filter(Boolean);
                              return { mk, m, mIdx, points };
                            }).filter(c => c.points.length > 0);

                            // PASS 2: Determine which points to label (first, last, max, min per curve)
                            const labelsToPlace = [];
                            allCurves.forEach(({ m, mIdx, points }) => {
                              if (points.length === 0) return;
                              const maxV = Math.max(...points.map(p => p.v));
                              const minV = Math.min(...points.map(p => p.v));
                              const keyIndices = new Set([0, points.length - 1]);
                              points.forEach((p, i) => { if (p.v === maxV || p.v === minV) keyIndices.add(i); });
                              keyIndices.forEach(i => {
                                const p = points[i];
                                const label = Number.isInteger(p.v) ? String(p.v) : p.v.toFixed(1);
                                // Initial position: alternate above/below by metric index
                                const above = mIdx % 2 === 0;
                                labelsToPlace.push({
                                  x: p.x, baseY: p.y, label, color: m.color, above, dotY: p.y
                                });
                              });
                            });

                            // PASS 3: Collision avoidance — sort by x, then by y; shift overlapping labels
                            labelsToPlace.sort((a, b) => a.x - b.x || a.baseY - b.baseY);
                            const placed = [];
                            const LABEL_H = 7; const LABEL_W_EST = (s) => s.length * 2.5 + 2;
                            labelsToPlace.forEach(lbl => {
                              let y = lbl.above ? lbl.baseY - 5 : lbl.baseY + 7;
                              let attempts = 0;
                              const lblW = LABEL_W_EST(lbl.label);
                              while (attempts < 8) {
                                const collision = placed.find(p => Math.abs(p.x - lbl.x) < (lblW + p.w) / 2 && Math.abs(p.y - y) < LABEL_H);
                                if (!collision) break;
                                y += lbl.above ? -LABEL_H : LABEL_H;
                                attempts++;
                              }
                              y = Math.max(TOP + 3, Math.min(BOTTOM + 8, y));
                              placed.push({ ...lbl, y, w: lblW });
                            });

                            return (
                              <g>
                                {/* Lines */}
                                {allCurves.map(({ mk, m, points }) => points.length > 1 && (
                                  <polyline key={`l-${mk}`} points={points.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={m.color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
                                ))}
                                {/* Dots */}
                                {allCurves.map(({ mk, m, points }) => points.map((p, idx) => (
                                  <circle key={`d-${mk}-${idx}`} cx={p.x} cy={p.y} r="2" fill="#fff" stroke={m.color} strokeWidth="1.2" />
                                )))}
                                {/* Labels with white background pill, rendered last so they sit on top */}
                                {placed.map((lbl, i) => (
                                  <g key={`lbl-${i}`}>
                                    <rect x={lbl.x - lbl.w / 2} y={lbl.y - 4.5} width={lbl.w} height={6} rx={1.5} fill="#fff" fillOpacity="0.92" />
                                    <text x={lbl.x} y={lbl.y} textAnchor="middle" fontSize="4.5" fill={lbl.color} fontFamily="'DM Mono', monospace" fontWeight="700">{lbl.label}</text>
                                  </g>
                                ))}
                              </g>
                            );
                          })()}
                          {chartData.map((e, i) => (
                            <text key={i} x={i * colW + colW / 2} y={svgH - 2} textAnchor="middle" fontSize="6.5" fill="#ccc" fontFamily="'DM Mono', monospace">{fmtShort(e.date)}</text>
                          ))}
                        </svg>
                      );
                    })()}
                  </div>
                  {activeMetrics.length > 1 && (
                    <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                      {activeMetrics.map(mk => {
                        const m = METRICS.find(x => x.key === mk);
                        return <span key={mk} style={{ fontSize: 10, fontWeight: 600, color: m.color, display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ width: 10, height: 3, background: m.color, borderRadius: 2, display: "inline-block" }} />{m.label}
                        </span>;
                      })}
                    </div>
                  )}
                </Card>

                {/* BAR CHART */}
                <Card>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                    <Label style={{ marginBottom: 0 }}>Daily Bars</Label>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {METRICS.map(m => (
                        <button key={m.key} onClick={() => toggleBarMetric(m.key)} style={{
                          fontSize: 9, fontWeight: 700, padding: "3px 9px", borderRadius: 10, cursor: "pointer", transition: "all 0.15s",
                          border: activeBarMetrics.includes(m.key) ? `2px solid ${m.color}` : "1px solid #eee",
                          background: activeBarMetrics.includes(m.key) ? m.color + "14" : "#fff",
                          color: activeBarMetrics.includes(m.key) ? m.color : "#ccc"
                        }}>{m.label}</button>
                      ))}
                    </div>
                  </div>
                  <div style={{ overflowX: "auto", paddingBottom: 4 }}>
                    {(() => {
                      // Each metric gets its own normalized scale (0–100px tall).
                      // Baseline for each metric is set so the lowest value = 15% height and highest = 100%.
                      // This makes small differences (247 vs 244) visible while proportional.
                      const BAR_H = 90; const BASELINE = 110;
                      const n = activeBarMetrics.length;
                      const barW = Math.max(8, Math.min(16, Math.floor(50 / Math.max(n, 1))));
                      const barGap = 2;
                      const groupGap = 8;
                      const groupW = n * barW + (n - 1) * barGap + groupGap;
                      const svgW = Math.max(chartData.length * groupW + 8, 200);

                      // Pre-compute per-metric range once
                      // Weight and BP: floor at 0, so bars reflect absolute proportion (247 vs 244 = nearly same height)
                      // Diet/Fasting/Smokes: use their fixedMax so the bar height means something (5/5 = full bar)
                      const metricRanges = {};
                      activeBarMetrics.forEach(mk => {
                        const mDef = METRICS.find(x => x.key === mk);
                        const vals = chartData.map(e => getMetricValue(e, mk)).filter(v => v > 0);
                        if (vals.length === 0) { metricRanges[mk] = { floor: 0, span: 1 }; return; }
                        const hi = Math.max(...vals);
                        if (mDef?.fixedMax !== undefined) {
                          // Fixed-range metrics: floor=0, span=fixedMax
                          metricRanges[mk] = { floor: 0, span: mDef.fixedMax };
                        } else {
                          // Weight, BP: floor at 0, span = highest value * 1.05 for a little headroom
                          metricRanges[mk] = { floor: 0, span: hi * 1.05 };
                        }
                      });

                      // Pre-compute max/min indices per metric for smart label placement
                      const metricExtremes = {};
                      activeBarMetrics.forEach(mk => {
                        const vals = chartData.map(e => getMetricValue(e, mk));
                        const nonZero = vals.map((v, i) => ({ v, i })).filter(x => x.v > 0);
                        if (nonZero.length === 0) { metricExtremes[mk] = new Set(); return; }
                        const maxV = Math.max(...nonZero.map(x => x.v));
                        const minV = Math.min(...nonZero.map(x => x.v));
                        const extremes = new Set([nonZero[0].i, nonZero[nonZero.length - 1].i]);
                        nonZero.forEach(x => { if (x.v === maxV || x.v === minV) extremes.add(x.i); });
                        metricExtremes[mk] = extremes;
                      });
                      const showAllLabels = n === 1;

                      return (
                        <svg width="100%" viewBox={`0 0 ${svgW} 130`} style={{ overflow: "visible", minWidth: chartData.length * 20 }}>
                          {[0, 0.5, 1].map(frac => (
                            <line key={frac} x1={0} y1={BASELINE - frac * BAR_H} x2={svgW} y2={BASELINE - frac * BAR_H} stroke="#f3f3f5" strokeWidth="1" />
                          ))}
                          {chartData.map((e, i) => {
                            const groupX = i * groupW + 4;
                            const groupCenter = groupX + (n * barW + (n - 1) * barGap) / 2;
                            return (
                              <g key={i}>
                                {activeBarMetrics.map((mk, bi) => {
                                  const bm = METRICS.find(x => x.key === mk);
                                  const v = getMetricValue(e, mk);
                                  const { floor, span } = metricRanges[mk];
                                  const h = v > 0 ? Math.max(4, ((v - floor) / span) * BAR_H) : 0;
                                  const bx = groupX + bi * (barW + barGap);
                                  const label = v > 0 ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : null;
                                  const shouldShowLabel = label && (showAllLabels || metricExtremes[mk].has(i));
                                  const labelY = BASELINE - h - 2;
                                  return (
                                    <g key={mk}>
                                      <rect x={bx} y={BASELINE - h} width={barW} height={h} rx={3} fill={v > 0 ? bm.barColor : "#eee"} opacity={v > 0 ? 0.85 : 0.15} />
                                      {shouldShowLabel && (() => {
                                        // White text inside the bar near top if tall enough, else dark text just above
                                        const insideBar = h >= 14;
                                        const ly = insideBar ? (BASELINE - h + 5) : Math.max(8, BASELINE - h - 2);
                                        const fill = insideBar ? "#fff" : bm.barColor;
                                        if (showAllLabels) {
                                          return <text x={bx + barW / 2} y={ly} textAnchor="middle" fontSize="5" fill={fill} fontFamily="'DM Mono', monospace" fontWeight="700">{label}</text>;
                                        }
                                        // Vertical rotated label for multi-metric mode
                                        return <text x={bx + barW / 2} y={insideBar ? (BASELINE - h + h / 2) : ly} textAnchor="middle" fontSize="4" fill={fill} fontFamily="'DM Mono', monospace" fontWeight="700" transform={insideBar ? `rotate(-90 ${bx + barW / 2} ${BASELINE - h + h / 2})` : ""}>{label}</text>;
                                      })()}
                                    </g>
                                  );
                                })}
                                <text x={groupCenter} y={126} textAnchor="middle" fontSize="6.5" fill="#ccc" fontFamily="'DM Mono', monospace">{fmtShort(e.date).split(" ")[1]}</text>
                              </g>
                            );
                          })}
                        </svg>
                      );
                    })()}
                  </div>
                  {activeBarMetrics.length > 1 && (
                    <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                      {activeBarMetrics.map(mk => {
                        const m = METRICS.find(x => x.key === mk);
                        return <span key={mk} style={{ fontSize: 10, fontWeight: 600, color: m.color, display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ width: 8, height: 8, background: m.color, borderRadius: 2, display: "inline-block", opacity: 0.8 }} />{m.label}
                        </span>;
                      })}
                    </div>
                  )}
                </Card>

                {/* STATS */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                  <StatCard label="High" value={Math.max(...filtered.map(e => parseFloat(e.weight) || 0))} unit="lbs" />
                  <StatCard label="Low" value={Math.min(...filtered.map(e => parseFloat(e.weight) || 0))} unit="lbs" />
                  {totalLost && parseFloat(totalLost) > 0 && <StatCard label="Lost" value={totalLost} unit="lbs" accent />}
                  {(() => {
                    const bp = filtered.filter(e => e.bpAmSys || e.bpPmSys);
                    if (!bp.length) return null;
                    return <StatCard label="Avg BP" value={`${Math.round(avg(bp, e => getMetricValue(e, "bpSys")))}/${Math.round(avg(bp, e => getMetricValue(e, "bpDia")))}`} unit="mmHg" />;
                  })()}
                  {filtered.some(e => e.diet) && <StatCard label="Avg Diet" value={avg(filtered.filter(e => e.diet), e => e.diet).toFixed(1)} unit="/5" />}
                  {filtered.some(e => e.fasting) && <StatCard label="Avg Fast" value={avg(filtered.filter(e => e.fasting), e => parseFloat(e.fasting)).toFixed(1)} unit="hrs" />}
                  {filtered.some(e => e.smokes) && <StatCard label="Avg Sm" value={avg(filtered.filter(e => e.smokes), e => parseFloat(e.smokes)).toFixed(1)} unit="/day" />}
                  {filtered.some(e => e.sleep) && <StatCard label="Avg Sleep" value={avg(filtered.filter(e => e.sleep), e => parseFloat(e.sleep)).toFixed(1)} unit="hrs" />}
                  {filtered.some(e => e.mood) && <StatCard label="Avg Mood" value={avg(filtered.filter(e => e.mood), e => e.mood).toFixed(1)} unit="/5" />}
                  <StatCard label="Iso Days" value={filtered.filter(e => e.isometric).length} unit={`/ ${filtered.length}`} />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterBar({ filterMode, setFilterMode, filterValue, setFilterValue, availableYears, availableMonths }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
      {["all","year","month","day"].map(m => (
        <button key={m} onClick={() => { setFilterMode(m); setFilterValue(""); }} style={{
          fontSize: 10, fontWeight: 600, padding: "5px 12px", borderRadius: 10, cursor: "pointer",
          border: filterMode === m ? "1.5px solid #111" : "1px solid #e5e5e5",
          background: filterMode === m ? "#111" : "#fff", color: filterMode === m ? "#fff" : "#999"
        }}>{m === "all" ? "All" : m.charAt(0).toUpperCase() + m.slice(1)}</button>
      ))}
      {filterMode === "year" && <select value={filterValue} onChange={e => setFilterValue(e.target.value)} style={selStyle}><option value="">Select year</option>{availableYears.map(y => <option key={y} value={y}>{y}</option>)}</select>}
      {filterMode === "month" && <select value={filterValue} onChange={e => setFilterValue(e.target.value)} style={selStyle}><option value="">Select month</option>{availableMonths.map(m => <option key={m} value={m}>{m}</option>)}</select>}
      {filterMode === "day" && <input type="date" value={filterValue} onChange={e => setFilterValue(e.target.value)} style={{ ...selStyle, fontFamily: "'DM Mono', monospace" }} />}
    </div>
  );
}

function ExportPanel({ columns, selectedColumns, onToggleColumn, onDownloadPdf, onDownloadExcel, rowCount, label }) {
  const canExport = rowCount > 0 && selectedColumns.length > 0;
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
        <div>
          <Label style={{ marginBottom: 4 }}>Export</Label>
          <div style={{ fontSize: 11, color: "#999", fontWeight: 600 }}>{label} · {rowCount} rows</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button onClick={onDownloadPdf} disabled={!canExport} style={{ ...exportBtn, opacity: canExport ? 1 : 0.45 }}>PDF</button>
          <button onClick={onDownloadExcel} disabled={!canExport} style={{ ...exportBtn, background: "#16a34a", opacity: canExport ? 1 : 0.45 }}>Excel</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {columns.map(column => {
          const active = selectedColumns.includes(column.key);
          return (
            <button key={column.key} onClick={() => onToggleColumn(column.key)} style={{
              fontSize: 9,
              fontWeight: 700,
              padding: "5px 8px",
              borderRadius: 9,
              cursor: "pointer",
              border: active ? "1.5px solid #111" : "1px solid #eee",
              background: active ? "#111" : "#fff",
              color: active ? "#fff" : "#aaa"
            }}>
              {column.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

const selStyle = { fontSize: 12, padding: "5px 10px", borderRadius: 8, border: "1px solid #e5e5e5", background: "#fff", outline: "none", fontFamily: "Inter, sans-serif", color: "#555" };
const authBtn = { border: "1px solid #e5e5e5", background: "#fff", color: "#555", borderRadius: 10, padding: "7px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "Inter, sans-serif" };
const exportBtn = { border: "none", background: "#111", color: "#fff", borderRadius: 10, padding: "7px 11px", fontSize: 11, fontWeight: 800, cursor: "pointer", fontFamily: "Inter, sans-serif" };
const iconBtn = { background: "none", border: "none", cursor: "pointer", color: "#bbb", fontSize: 14, padding: "6px 8px", borderRadius: 6, lineHeight: 1 };

function Card({ children }) { return <div style={{ background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #f0f0f0", overflow: "hidden" }}>{children}</div>; }
function Label({ children, style = {} }) { return <div style={{ fontSize: 10, fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 8, ...style }}>{children}</div>; }
function Input({ mb = 14, style = {}, ...props }) {
  return <input {...props} style={{ width: "100%", padding: "9px 11px", border: "1px solid #eee", borderRadius: 10, fontSize: 14, fontFamily: "'DM Mono', monospace", background: "#fafafa", outline: "none", marginBottom: mb, transition: "border 0.15s", ...style }} onFocus={e => e.target.style.borderColor = "#111"} onBlur={e => e.target.style.borderColor = "#eee"} />;
}
function Row({ children }) { return <div className="grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{children}</div>; }
function Tag({ children, accent }) { return <span style={{ fontSize: 10, fontWeight: 600, color: accent ? "#16a34a" : "#888", background: accent ? "#f0fdf4" : "#f5f5f5", padding: "2px 9px", borderRadius: 8 }}>{children}</span>; }
function PillBadge({ children, positive }) { return <span style={{ fontSize: 10, fontWeight: 700, color: positive ? "#22c55e" : "#ef4444", background: positive ? "#f0fdf4" : "#fef2f2", padding: "2px 8px", borderRadius: 10 }}>{children}</span>; }
function StatCard({ label, value, unit, accent }) {
  return (
    <div className="stat-card" style={{ flex: 1, minWidth: 0, background: "#fff", borderRadius: 12, padding: "14px 14px", border: "1px solid #f0f0f0", textAlign: "center" }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: "#bbb", textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 3, color: accent ? "#22c55e" : "#111", letterSpacing: -0.3 }}>{value} <span style={{ fontSize: 10, color: "#ccc", fontWeight: 500 }}>{unit}</span></div>
    </div>
  );
}
function Empty({ text = "No entries yet" }) { return <div style={{ textAlign: "center", padding: 50, color: "#ccc", fontSize: 13 }}>{text}</div>; }
