import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  BootstrapPayload,
  Experiment,
  ExperimentDetail,
  RunArtifact,
  ScenarioRevision,
  VariantRevision,
} from "../domain/model.js";

type View = "overview" | "setup" | "experiment" | "run" | "scenarios";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(value));
}

function statusLabel(status: RunArtifact["status"] | undefined): string {
  return status === "passed" ? "Passed" : status === "failed" ? "Failed" : status === "unknown" ? "Needs review" : status === "error" ? "Error" : "Pending";
}

function StatusPill({ status }: { status: RunArtifact["status"] | undefined }) {
  return <span className={`status-pill status-${status ?? "unknown"}`}><span className="status-dot" />{statusLabel(status)}</span>;
}

function MetricCard({ label, value, note, tone = "neutral" }: { label: string; value: string; note: string; tone?: "neutral" | "good" | "warn" | "bad" }) {
  return <div className={`metric-card metric-${tone}`}><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-note">{note}</div></div>;
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-mark">◎</div><h3>{title}</h3><p>{body}</p>{action}</div>;
}

export function App() {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [view, setView] = useState<View>("overview");
  const [selectedExperiment, setSelectedExperiment] = useState<ExperimentDetail | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunArtifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const next = await api<BootstrapPayload>("/api/bootstrap");
      setData(next);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load Voice Labs.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const openExperiment = async (id: string) => {
    setError(null);
    try {
      setSelectedExperiment(await api<ExperimentDetail>(`/api/experiments/${id}`));
      setSelectedRun(null);
      setView("experiment");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load the experiment.");
    }
  };

  const runExperiment = async (id: string) => {
    setRunning(true);
    setError(null);
    try {
      const result = await api<ExperimentDetail>(`/api/experiments/${id}/run`, { method: "POST", body: "{}" });
      setSelectedExperiment(result);
      setSelectedRun(null);
      await refresh();
      setView("experiment");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The experiment could not run.");
    } finally {
      setRunning(false);
    }
  };

  const openRun = async (id: string) => {
    setError(null);
    try {
      setSelectedRun(await api<RunArtifact>(`/api/runs/${id}`));
      setView("run");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load the run.");
    }
  };

  const promoteScenario = async (scenarioId: string) => {
    try {
      await api(`/api/scenarios/${scenarioId}/promote`, { method: "POST" });
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Scenario promotion failed.");
    }
  };

  if (loading) return <div className="loading-screen"><div className="loader" /><span>Loading your lab…</span></div>;

  const currentData = data ?? { product: "voice-labs", scenarios: [], variants: [], evaluators: [], experiments: [], recentRuns: [], regressionScenarioIds: [] };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup" onClick={() => { setView("overview"); setSelectedExperiment(null); }} role="button" tabIndex={0}>
          <div className="brand-orbit"><span /><span /><span /></div>
          <div><div className="brand-name">voice<span>·</span>labs</div><div className="brand-caption">agent evaluation studio</div></div>
        </div>
        <div className="workspace-switcher"><div className="workspace-avatar">K</div><div><div className="workspace-name">Local workspace</div><div className="workspace-path">~/voice-labs</div></div><span className="chevron">⌄</span></div>
        <nav className="main-nav" aria-label="Main navigation">
          <NavButton active={view === "overview"} icon="⌂" label="Overview" onClick={() => setView("overview")} />
          <NavButton active={view === "setup"} icon="＋" label="New experiment" onClick={() => setView("setup")} accent />
          <NavButton active={view === "scenarios"} icon="◇" label="Scenario library" onClick={() => setView("scenarios")} />
        </nav>
        <div className="nav-section-label">Workspace</div>
        <nav className="secondary-nav">
          <NavButton active={false} icon="▦" label="Experiments" onClick={() => setView("overview")} count={currentData.experiments.length} />
          <NavButton active={false} icon="✓" label="Regression set" onClick={() => setView("scenarios")} count={currentData.regressionScenarioIds.length} />
        </nav>
        <div className="sidebar-spacer" />
        <div className="boundary-card"><div className="boundary-heading"><span className="pulse" />Local-first</div><p>Deterministic by default. TVIC execution and Earshot evidence stay behind explicit adapters.</p><div className="boundary-links"><span>TVIC <i>↗</i></span><span>Earshot <i>↗</i></span></div></div>
        <div className="sidebar-footer"><span className="version-badge">v0.1.0</span><span className="footer-item">⌘ K</span><span className="footer-item">?</span></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div className="breadcrumb"><span>Voice Labs</span><span className="crumb-separator">/</span><span className="crumb-current">{view === "overview" ? "Overview" : view === "setup" ? "New experiment" : view === "scenarios" ? "Scenario library" : view === "run" ? "Run detail" : selectedExperiment?.experiment.name ?? "Experiment"}</span></div><div className="topbar-actions"><span className="connection-state"><span className="status-dot" /> Local engine ready</span><button className="icon-button" title="Refresh" onClick={() => void refresh()}>↻</button><div className="user-avatar">K</div></div></header>
        {error && <div className="error-banner"><span>!</span>{error}<button onClick={() => setError(null)}>×</button></div>}
        {view === "overview" && <Overview data={currentData} onNew={() => setView("setup")} onOpen={openExperiment} onRun={runExperiment} running={running} />}
        {view === "setup" && <ExperimentSetup data={currentData} onCancel={() => setView("overview")} onChanged={refresh} onCreated={async (experiment) => { await runExperiment(experiment.id); }} />}
        {view === "scenarios" && <ScenarioLibrary data={currentData} onPromote={promoteScenario} onChanged={refresh} />}
        {view === "experiment" && selectedExperiment && <ExperimentView detail={selectedExperiment} onBack={() => setView("overview")} onRun={() => void runExperiment(selectedExperiment.experiment.id)} onOpenRun={openRun} running={running} onPromote={promoteScenario} regressionIds={currentData.regressionScenarioIds} />}
        {view === "run" && selectedRun && <RunView run={selectedRun} onBack={() => selectedExperiment ? setView("experiment") : setView("overview")} />}
      </main>
    </div>
  );
}

function NavButton({ active, icon, label, onClick, count, accent = false }: { active: boolean; icon: string; label: string; onClick: () => void; count?: number; accent?: boolean }) {
  return <button className={`nav-button ${active ? "active" : ""} ${accent ? "nav-accent" : ""}`} onClick={onClick}><span className="nav-icon">{icon}</span><span>{label}</span>{count !== undefined && <span className="nav-count">{count}</span>}</button>;
}

function Overview({ data, onNew, onOpen, onRun, running }: { data: BootstrapPayload; onNew: () => void; onOpen: (id: string) => void; onRun: (id: string) => void; running: boolean }) {
  const latestExperiment = data.experiments[0];
  const passed = data.recentRuns.filter((run) => run.status === "passed").length;
  const failed = data.recentRuns.filter((run) => run.status === "failed").length;
  const unknown = data.recentRuns.filter((run) => run.status === "unknown").length;
  const passRate = data.recentRuns.length ? passed / data.recentRuns.length : 0;
  return <div className="page-wrap overview-page">
    <section className="hero-row"><div><div className="eyebrow"><span className="eyebrow-line" /> WORKSPACE OVERVIEW</div><h1>Find the version<br /><em>worth shipping.</em></h1><p className="hero-copy">Simulate real conversations. Compare what changed. Build confidence before callers find the edge case.</p><div className="hero-actions"><button className="primary-button" onClick={onNew}><span>＋</span> New experiment</button><button className="quiet-button" onClick={() => document.getElementById("recent-experiments")?.scrollIntoView({ behavior: "smooth" })}>Explore runs <span>↓</span></button></div></div><div className="hero-visual"><div className="orbit-card"><div className="orbit-core"><span className="core-mark">◌</span><span className="core-label">SIMULATE</span></div><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-node node-one">prompt</div><div className="orbit-node node-two">tools</div><div className="orbit-node node-three">voice</div></div></div></section>
    <section className="metric-grid"><MetricCard label="Run health" value={data.recentRuns.length ? formatPercent(passRate) : "—"} note={data.recentRuns.length ? `${passed} passing · ${failed} regressions` : "Run your first experiment"} tone={failed > 0 ? "warn" : "good"} /><MetricCard label="Experiments" value={String(data.experiments.length).padStart(2, "0")} note={`${data.scenarios.length} scenarios · ${data.variants.length} variants`} /><MetricCard label="Regression set" value={String(data.regressionScenarioIds.length).padStart(2, "0")} note="promoted scenarios" tone="neutral" /><MetricCard label="Needs review" value={String(unknown).padStart(2, "0")} note="unknown or incomplete evidence" tone={unknown ? "warn" : "good"} /></section>
    <section className="content-section" id="recent-experiments"><div className="section-heading"><div><div className="eyebrow">YOUR LAB</div><h2>Experiments</h2></div><button className="text-button" onClick={onNew}>Create one <span>↗</span></button></div>
      {latestExperiment ? <div className="experiment-list"><ExperimentCard experiment={latestExperiment} data={data} onOpen={onOpen} onRun={onRun} running={running} /><div className="experiment-list-footer"><span>Showing {data.experiments.length} experiment{data.experiments.length === 1 ? "" : "s"}</span><span className="muted">Results stay local until you choose to export them.</span></div></div> : <EmptyState title="Your lab is ready." body="Create a scenario matrix, run it locally, and see which candidate holds up." action={<button className="primary-button" onClick={onNew}>Start first experiment</button>} />}
    </section>
    <section className="content-section recent-runs"><div className="section-heading"><div><div className="eyebrow">TRACE INBOX</div><h2>Recent runs</h2></div><span className="section-caption">Every result is inspectable</span></div>{data.recentRuns.length ? <div className="run-table">{data.recentRuns.slice(0, 6).map((run) => <button className="run-row" key={run.id} onClick={() => onOpen(run.experimentId)}><div className="run-cell-status"><StatusPill status={run.status} /></div><div className="run-cell-main"><strong>{data.scenarios.find((scenario) => scenario.id === run.scenarioId)?.name ?? "Scenario run"}</strong><span>{data.variants.find((variant) => variant.id === run.variantId)?.name ?? "Variant"} · repetition {run.repetition}</span></div><div className="run-cell-time">{run.durationMs}ms</div><div className="run-cell-date">{formatTime(run.startedAt)}</div><span className="row-arrow">›</span></button>)}</div> : <div className="mini-empty">No runs yet — your first result will appear here.</div>}</section>
  </div>;
}

function ExperimentCard({ experiment, data, onOpen, onRun, running }: { experiment: Experiment; data: BootstrapPayload; onOpen: (id: string) => void; onRun: (id: string) => void; running: boolean }) {
  const runs = data.recentRuns.filter((run) => run.experimentId === experiment.id);
  const passed = runs.filter((run) => run.status === "passed").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  return <div className="experiment-card"><div className="experiment-card-top"><div className="experiment-icon">✦</div><div className="experiment-card-title"><h3>{experiment.name}</h3><p>{experiment.description}</p></div><span className="mode-badge">{experiment.mode} mode</span></div><div className="experiment-card-meta"><span><b>{experiment.scenarioIds.length}</b> scenarios</span><span><b>{experiment.variantIds.length}</b> variants</span><span><b>{experiment.repetitions}</b> repetitions</span><span className="meta-spacer" /><span className="experiment-date">Created {formatTime(experiment.createdAt)}</span></div><div className="experiment-card-bottom"><div className="mini-statuses">{runs.length ? <><span className="mini-status good"><i />{passed} passed</span><span className="mini-status bad"><i />{failed} failed</span></> : <span className="mini-status neutral"><i />Not run yet</span>}</div><div className="card-actions"><button className="quiet-button small" onClick={() => onOpen(experiment.id)}>View results <span>→</span></button><button className="primary-button small" onClick={() => onRun(experiment.id)} disabled={running}>{running ? "Running…" : runs.length ? "Run again" : "Run experiment"}</button></div></div></div>;
}

function ExperimentSetup({ data, onCancel, onChanged, onCreated }: { data: BootstrapPayload; onCancel: () => void; onChanged: () => Promise<void>; onCreated: (experiment: Experiment) => Promise<void> }) {
  const [name, setName] = useState("New voice experiment");
  const [description, setDescription] = useState("Compare candidates against a focused scenario set.");
  const [scenarioIds, setScenarioIds] = useState<string[]>(data.scenarios[0] ? [data.scenarios[0].scenarioId] : []);
  const [variantIds, setVariantIds] = useState<string[]>(data.variants.slice(0, 2).map((variant) => variant.variantId));
  const [repetitions, setRepetitions] = useState(2);
  const [mode, setMode] = useState<Experiment["mode"]>("deterministic");
  const [submitting, setSubmitting] = useState(false);
  const [showVariantForm, setShowVariantForm] = useState(false);
  const [variantName, setVariantName] = useState("New candidate");
  const [variantStrategy, setVariantStrategy] = useState<VariantRevision["strategy"]>("reliable");
  const [variantLatency, setVariantLatency] = useState(160);
  const [variantReliability, setVariantReliability] = useState(0.9);
  const [variantToolRate, setVariantToolRate] = useState(0.9);
  const [variantSubmitting, setVariantSubmitting] = useState(false);
  const cells = scenarioIds.length * variantIds.length * repetitions;
  const toggle = (value: string, values: string[], setValues: (next: string[]) => void) => setValues(values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const experiment = await api<Experiment>("/api/experiments", { method: "POST", body: JSON.stringify({ name, description, scenarioIds, variantIds, repetitions, mode }) });
      await onCreated(experiment);
    } finally {
      setSubmitting(false);
    }
  };
  const createVariant = async () => {
    setVariantSubmitting(true);
    try {
      await api<VariantRevision>("/api/variants", { method: "POST", body: JSON.stringify({ name: variantName, description: "A candidate created in the experiment builder.", instructions: "Complete the caller goal and make the final state clear.", strategy: variantStrategy, latencyMs: variantLatency, reliability: variantReliability, toolSuccessRate: variantToolRate, providerLabel: "deterministic / local" }) });
      await onChanged();
      setShowVariantForm(false);
    } finally {
      setVariantSubmitting(false);
    }
  };
  return <div className="page-wrap setup-page"><div className="setup-header"><div><div className="eyebrow"><span className="eyebrow-line" /> EXPERIMENT BUILDER</div><h1>Set the question<br /><em>before the run.</em></h1><p>Choose the behavior you want to learn about, then make the comparison explicit.</p></div><div className="setup-summary"><div className="summary-kicker">RUN MATRIX</div><strong>{cells || 0}</strong><span>scenario × variant cells</span></div></div><form className="setup-grid" onSubmit={submit}><div className="setup-form-column"><section className="form-panel"><div className="panel-heading"><span className="panel-number">01</span><div><h2>Name the experiment</h2><p>Make the hypothesis recognizable six weeks from now.</p></div></div><label>Experiment name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label></section><section className="form-panel"><div className="panel-heading"><span className="panel-number">02</span><div><h2>Choose scenarios</h2><p>Start with outcomes, not a brittle conversation script.</p></div></div><div className="selection-list">{data.scenarios.map((scenario) => <SelectionCard key={scenario.scenarioId} selected={scenarioIds.includes(scenario.scenarioId)} onClick={() => toggle(scenario.scenarioId, scenarioIds, setScenarioIds)} title={scenario.name} description={scenario.goal} meta={`${scenario.tags.join(" · ")} · ${scenario.expectedOutcomeFacts.length} outcome facts${scenario.audioFixtures?.length ? ` · ${scenario.audioFixtures.length} audio fixtures` : ""}`} />)}</div>{!data.scenarios.length && <div className="inline-note">Create a scenario before setting up a run.</div>}</section><section className="form-panel"><div className="panel-heading panel-heading-with-action"><div className="panel-heading-title"><span className="panel-number">03</span><div><h2>Choose candidates</h2><p>Every candidate is resolved to a versioned configuration at run time.</p></div></div><button type="button" className="text-button" onClick={() => setShowVariantForm((visible) => !visible)}>{showVariantForm ? "Close" : "＋ New candidate"}</button></div>{showVariantForm && <div className="quick-create"><label>Candidate name<input value={variantName} onChange={(event) => setVariantName(event.target.value)} required /></label><div className="quick-create-row"><label>Strategy<select value={variantStrategy} onChange={(event) => setVariantStrategy(event.target.value as VariantRevision["strategy"])}><option value="reliable">Reliable</option><option value="concise">Concise</option><option value="fragile">Fragile</option></select></label><label>Latency (ms)<input type="number" min="1" max="60000" value={variantLatency} onChange={(event) => setVariantLatency(Number(event.target.value))} /></label><label>Reliability<input type="number" min="0" max="1" step="0.05" value={variantReliability} onChange={(event) => setVariantReliability(Number(event.target.value))} /></label></div><button type="button" className="primary-button small" onClick={() => void createVariant()} disabled={variantSubmitting}>{variantSubmitting ? "Saving…" : "Save candidate"}<span>→</span></button></div>}<div className="selection-list">{data.variants.map((variant) => <SelectionCard key={variant.variantId} selected={variantIds.includes(variant.variantId)} onClick={() => toggle(variant.variantId, variantIds, setVariantIds)} title={variant.name} description={variant.description} meta={`${variant.providerLabel} · ${variant.latencyMs}ms nominal`} color={variant.strategy === "reliable" ? "green" : "orange"} />)}</div>{!data.variants.length && <div className="inline-note">Create a variant before setting up a run.</div>}</section></div><aside className="setup-sidebar"><div className="form-panel sticky-panel"><div className="panel-heading compact"><span className="panel-number">04</span><div><h2>Run settings</h2><p>Keep the first loop cheap and repeatable.</p></div></div><label>Execution mode<select value={mode} onChange={(event) => setMode(event.target.value as Experiment["mode"])}><option value="deterministic">Deterministic simulation</option><option value="tvic">TVIC runtime · real LLM/TTS</option><option value="audio">TVIC audio · real STT/LLM/TTS</option></select></label><div className="inline-note">TVIC modes are opt-in. Transcript mode uses real model/synthesis providers with scripted input; audio mode additionally requires one fixture per caller turn.</div><label>Repetitions<div className="stepper"><button type="button" onClick={() => setRepetitions(Math.max(1, repetitions - 1))}>−</button><span>{repetitions}</span><button type="button" onClick={() => setRepetitions(Math.min(20, repetitions + 1))}>＋</button></div></label><div className="settings-callout"><span>✧</span><p><strong>Why deterministic first?</strong> It gives you a clean baseline for outcomes and tool behavior before provider variance enters the room.</p></div><div className="preflight"><div><span>Scenarios</span><strong>{scenarioIds.length}</strong></div><div><span>Variants</span><strong>{variantIds.length}</strong></div><div><span>Cells</span><strong>{cells}</strong></div></div><div className="form-actions"><button type="button" className="quiet-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-button" disabled={submitting || !scenarioIds.length || !variantIds.length}>{submitting ? "Creating…" : "Create & run"}<span>→</span></button></div></div></aside></form></div>;
}

function SelectionCard({ selected, onClick, title, description, meta, color = "purple" }: { selected: boolean; onClick: () => void; title: string; description: string; meta: string; color?: string }) {
  return <button type="button" className={`selection-card ${selected ? "selected" : ""}`} onClick={onClick}><span className={`selection-indicator ${color}`}>{selected ? "✓" : ""}</span><span className="selection-copy"><strong>{title}</strong><span>{description}</span><small>{meta}</small></span><span className="selection-chevron">›</span></button>;
}

function ExperimentView({ detail, onBack, onRun, onOpenRun, running, onPromote, regressionIds }: { detail: ExperimentDetail; onBack: () => void; onRun: () => void; onOpenRun: (id: string) => void; running: boolean; onPromote: (id: string) => void; regressionIds: string[] }) {
  const [filter, setFilter] = useState<"all" | "failed" | "passed">("all");
  const filteredRuns = detail.runs.filter((run) => filter === "all" || run.status === filter);
  return <div className="page-wrap experiment-page"><div className="detail-header"><button className="back-button" onClick={onBack}>← <span>All experiments</span></button><div className="detail-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> EXPERIMENT RESULT</div><h1>{detail.experiment.name}</h1><p>{detail.experiment.description}</p></div><div className="detail-actions"><button className="quiet-button" onClick={onRun} disabled={running}>{running ? "Running…" : "↻ Run again"}</button><button className="primary-button" onClick={() => detail.scenarios[0] && void onPromote(detail.scenarios[0].scenarioId)}>＋ Promote scenario</button></div></div></div><div className="result-strip"><div><span className="strip-label">TOTAL RUNS</span><strong>{detail.comparison.totalRuns}</strong></div><div><span className="strip-label">PASS RATE</span><strong className="text-good">{detail.comparison.totalRuns ? formatPercent(detail.comparison.totalPassed / detail.comparison.totalRuns) : "—"}</strong></div><div><span className="strip-label">REGRESSIONS</span><strong className={detail.comparison.totalFailed ? "text-bad" : "text-good"}>{detail.comparison.totalFailed}</strong></div><div><span className="strip-label">BASELINE</span><strong className="strip-baseline">{detail.comparison.rows.find((row) => row.variantId === detail.comparison.baselineVariantId)?.variantName ?? "—"}</strong></div><div className="strip-spacer" /><div className="evidence-chip"><span className="status-dot" />{regressionIds.some((id) => detail.scenarios.some((scenario) => scenario.scenarioId === id)) ? "In regression set" : "Not promoted"}</div></div><section className="comparison-section"><div className="section-heading"><div><div className="eyebrow">VARIANT COMPARISON</div><h2>What changed?</h2></div><div className="filter-tabs"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All runs</button><button className={filter === "failed" ? "active" : ""} onClick={() => setFilter("failed")}>Regressions <span>{detail.comparison.totalFailed}</span></button><button className={filter === "passed" ? "active" : ""} onClick={() => setFilter("passed")}>Passing</button></div></div><div className="comparison-table"><div className="comparison-head"><span>Candidate</span><span>Run health</span><span>Quality score</span><span>Avg latency</span><span>vs baseline</span><span /></div>{detail.comparison.rows.map((row, index) => <div className={`comparison-row ${index === 0 ? "baseline-row" : ""}`} key={row.variantId}><div className="candidate-cell"><span className={`candidate-dot candidate-${index}`} /><div><strong>{row.variantName}</strong><small>{row.providerLabel}{index === 0 && <b> BASELINE</b>}</small></div></div><div className="health-cell"><div className="health-bar"><span style={{ width: `${row.passRate * 100}%` }} /></div><strong>{formatPercent(row.passRate)}</strong><small>{row.passedRuns}/{row.runCount} passed</small></div><div className="score-cell"><strong>{row.qualityScore === null ? "—" : formatPercent(row.qualityScore)}</strong><small>{row.unknownRuns ? `${row.unknownRuns} unknown` : "all evidence scored"}</small></div><div className="latency-cell"><strong>{row.averageLatencyMs === null ? "—" : `${row.averageLatencyMs}ms`}</strong><small>per run</small></div><div className={`delta-cell ${row.deltaFromBaseline === null ? "muted" : row.deltaFromBaseline > 0 ? "positive" : row.deltaFromBaseline < 0 ? "negative" : "neutral"}`}>{row.deltaFromBaseline === null ? "—" : row.deltaFromBaseline === 0 ? "same" : `${row.deltaFromBaseline > 0 ? "+" : ""}${formatPercent(row.deltaFromBaseline)}`}</div><span className="row-arrow">›</span></div>)}</div></section><section className="case-section"><div className="section-heading"><div><div className="eyebrow">CASE MATRIX</div><h2>Trace every result</h2></div><span className="section-caption">{filteredRuns.length} visible · aligned by scenario</span></div><div className="case-table"><div className="case-head"><span>Status</span><span>Scenario</span><span>Candidate</span><span>Latency</span><span>Repetition</span><span /></div>{filteredRuns.length ? filteredRuns.map((run) => <button className="case-row" key={run.id} onClick={() => onOpenRun(run.id)}><StatusPill status={run.status} /><div className="case-primary"><strong>{detail.scenarios.find((scenario) => scenario.id === run.scenarioId)?.name ?? "Scenario"}</strong><small>{detail.scenarios.find((scenario) => scenario.id === run.scenarioId)?.goal ?? ""}</small></div><div className="case-candidate"><span className="tiny-dot" />{detail.variants.find((variant) => variant.id === run.variantId)?.name ?? "Variant"}</div><span>{run.durationMs}ms</span><span className="repetition-pill">trial {run.repetition}</span><span className="row-arrow">›</span></button>) : <div className="mini-empty">No runs match this filter.</div>}</div></section></div>;
}

function RunView({ run, onBack }: { run: RunArtifact; onBack: () => void }) {
  return <div className="page-wrap run-page"><button className="back-button" onClick={onBack}>← <span>Back to experiment</span></button><div className="run-header"><div><div className="eyebrow"><span className="eyebrow-line" /> RUN TRACE · {run.id}</div><h1>One conversation,<br /><em>fully explained.</em></h1><p>Every assertion is linked to the evidence that produced it.</p></div><div className="run-header-status"><StatusPill status={run.status} /><span>Trial {run.repetition} · seed {run.seed}</span></div></div><div className="trace-meta"><div><span>MODE</span><strong>{run.mode}</strong></div><div><span>DURATION</span><strong>{run.durationMs}ms</strong></div><div><span>TURNS</span><strong>{run.metrics.turnCount}</strong></div><div><span>TOOLS</span><strong>{run.metrics.toolCallCount}</strong></div><div><span>STARTED</span><strong>{formatTime(run.startedAt)}</strong></div><div className="trace-meta-spacer" /><div className="evidence-link">◈ Evidence {run.evidence?.status === "attached" ? "attached" : "not requested"}</div></div><div className="trace-layout"><section className="trace-panel"><div className="trace-panel-header"><div><div className="eyebrow">CONVERSATION TRACE</div><h2>What the agent did</h2></div><span className="trace-count">{run.transcript.length} events</span></div><div className="timeline">{run.transcript.map((turn) => <div className={`timeline-event ${turn.speaker}`} key={`${turn.index}-${turn.offsetMs}`}><div className="timeline-rail"><span className="timeline-dot" /><span className="timeline-line" /></div><div className="timeline-content"><div className="timeline-label"><span>{turn.speaker === "assistant" ? "AGENT" : turn.speaker.toUpperCase()}</span><time>+{turn.offsetMs}ms</time></div><div className="bubble">{turn.text}</div></div></div>)}{run.toolCalls.map((call) => <div className="timeline-event tool" key={call.id}><div className="timeline-rail"><span className="timeline-dot" /><span className="timeline-line" /></div><div className="timeline-content"><div className="timeline-label"><span>TOOL CALL</span><time>{call.elapsedMs}ms</time></div><div className="tool-card"><div className="tool-card-top"><strong>{call.name}</strong><span className={`tool-status ${call.status}`}>{call.status === "succeeded" ? "Succeeded" : "Failed"}</span></div><code>{JSON.stringify(call.arguments)}</code>{call.error && <p>{call.error}</p>}</div></div></div>)}</div></section><aside className="trace-sidebar"><section className="assertion-panel"><div className="eyebrow">EVALUATIONS</div><h2>Why it got this result</h2><div className="assertion-list">{(run.evaluations ?? []).map((evaluation) => <div className={`assertion ${evaluation.status}`} key={evaluation.id}><div className="assertion-top"><span className="assertion-icon">{evaluation.status === "passed" ? "✓" : evaluation.status === "failed" ? "×" : "?"}</span><strong>{evaluation.name}</strong><span className="assertion-score">{evaluation.status === "unknown" ? "—" : formatPercent(evaluation.score)}</span></div><p>{evaluation.reason}</p></div>)}</div></section><section className="manifest-panel"><div className="eyebrow">REPLAY MANIFEST</div><h2>Run is reproducible</h2><div className="manifest-list"><div><span>Scenario revision</span><strong>{run.scenarioId}</strong></div><div><span>Variant revision</span><strong>{run.variantId}</strong></div><div><span>Seed</span><strong>{run.seed}</strong></div><div><span>Audio</span><strong>{run.metrics.audioExercised ? "Exercised" : "Not exercised"}</strong></div></div><button className="quiet-button full-width">Copy replay config <span>↗</span></button></section></aside></div></div>;
}

function ScenarioLibrary({ data, onPromote, onChanged }: { data: BootstrapPayload; onPromote: (id: string) => void; onChanged: () => Promise<void> }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("New scenario");
  const [goal, setGoal] = useState("");
  const [turns, setTurns] = useState("");
  const [facts, setFacts] = useState("");
  const [phrases, setPhrases] = useState("");
  const [tool, setTool] = useState("");
  const [audioFixtures, setAudioFixtures] = useState("");
  const [tags, setTags] = useState("new");
  const [submitting, setSubmitting] = useState(false);
  const parseList = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);
  const createScenario = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const fixtures = audioFixtures.split("\n").map((item) => item.trim()).filter(Boolean);
      await api<ScenarioRevision>("/api/scenarios", { method: "POST", body: JSON.stringify({ name, description: "A scenario authored in the local scenario library.", persona: "A representative caller with a real customer goal.", goal, userTurns: turns.split("\n").map((item) => item.trim()).filter(Boolean), expectedOutcomeFacts: parseList(facts), forbiddenPhrases: [], requiredPhrases: parseList(phrases), expectedToolCalls: parseList(tool), latencyBudgetMs: 2_000, tags: parseList(tags), ...(fixtures.length ? { audioFixtures: fixtures } : {}) }) });
      await onChanged();
      setCreating(false);
      setName("New scenario");
      setGoal("");
      setTurns("");
      setFacts("");
      setPhrases("");
      setTool("");
      setAudioFixtures("");
    } finally {
      setSubmitting(false);
    }
  };
  return <div className="page-wrap scenarios-page"><div className="detail-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> SCENARIO LIBRARY</div><h1>Cases worth<br /><em>keeping around.</em></h1><p>Turn the failures you care about into durable, reviewable regression coverage.</p></div><button className="primary-button" onClick={() => setCreating((visible) => !visible)}>{creating ? "Close" : "＋ New scenario"}</button></div>{creating && <form className="form-panel scenario-create-panel" onSubmit={createScenario}><div className="panel-heading"><span className="panel-number">NEW</span><div><h2>Describe the case</h2><p>Keep the goal concrete enough that a future run can prove it.</p></div></div><div className="scenario-form-grid"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Goal<input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="What should be true at the end?" required /></label><label className="wide-field">Caller turns<textarea value={turns} onChange={(event) => setTurns(event.target.value)} placeholder="One user message per line" rows={4} required /></label><label>Outcome facts<input value={facts} onChange={(event) => setFacts(event.target.value)} placeholder="booking.created, confirmation.shared" /></label><label>Required phrases<input value={phrases} onChange={(event) => setPhrases(event.target.value)} placeholder="tomorrow, confirmation" /></label><label>Expected tools<input value={tool} onChange={(event) => setTool(event.target.value)} placeholder="appointments.book" /></label><label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="critical, billing" /></label><label className="wide-field">Audio fixtures (optional)<textarea value={audioFixtures} onChange={(event) => setAudioFixtures(event.target.value)} placeholder="One relative WAV path per caller turn" rows={3} /></label></div><div className="form-actions"><button type="submit" className="primary-button" disabled={submitting}>{submitting ? "Saving…" : "Save scenario"}<span>→</span></button></div></form>}<div className="scenario-grid">{data.scenarios.map((scenario) => { const promoted = data.regressionScenarioIds.includes(scenario.scenarioId); return <article className="scenario-card" key={scenario.scenarioId}><div className="scenario-card-top"><span className="scenario-symbol">◇</span><div className="scenario-tags">{scenario.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>{promoted && <span className="promoted-badge">✓ regression</span>}</div><h2>{scenario.name}</h2><p>{scenario.description}</p><div className="scenario-goal"><span>OUTCOME</span><strong>{scenario.goal}</strong></div><div className="scenario-footer"><span>{scenario.userTurns.length} user turns · {scenario.expectedOutcomeFacts.length} facts{scenario.audioFixtures?.length ? ` · ${scenario.audioFixtures.length} audio` : ""}</span>{promoted ? <button type="button" className="quiet-button small">View history <span>→</span></button> : <button type="button" className="quiet-button small" onClick={() => onPromote(scenario.scenarioId)}>Promote <span>↗</span></button>}</div></article>; })}</div>{!data.scenarios.length && <EmptyState title="No scenarios yet" body="Start with a customer outcome and a few representative caller turns." />}</div>;
}
