import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

type Page = "overview" | "jobs" | "settings";
type Route = { page: Page; jobId?: string };
type Theme = "light" | "dark";
type Session = {
  authenticated: true;
  scriberrUrl: string;
  setup: {
    required: boolean;
    manageable: boolean;
    credentialStatus: "missing" | "valid" | "invalid" | "unavailable";
    source: "environment" | "database" | "default" | "unset";
  };
};
type SettingSource = "environment" | "database" | "default" | "unset";
type SettingSnapshot = {
  key: string;
  env: string;
  group: string;
  value?: string | number | boolean;
  source: SettingSource;
  editable: boolean;
  secret: boolean;
  advanced: boolean;
  configured: boolean;
  defaultValue?: string;
  input: "text" | "url" | "number" | "boolean" | "select";
  options?: readonly string[];
  error?: string;
};
type SettingsGroup = { key: string; settings: SettingSnapshot[] };
type SettingsPayload = {
  revision: string;
  groups: SettingsGroup[];
  issues: Array<{ key: string; group: string; message: string }>;
  active?: boolean;
  restartRequired?: boolean;
  activationError?: string;
};
type HealthStatus = "healthy" | "disabled" | "needs_attention" | "paused";
type OperationsPayload = {
  health: Array<{ key: string; label: string; status: HealthStatus; detail: string }>;
  recentFailures: Array<{ category: string; jobId: string; title: string; message: string; occurredAt: string }>;
};
type JobSummary = {
  id: string;
  title: string;
  source: string;
  state: string;
  scriberrStatus: string | null;
  status: string;
  active: boolean;
  attempt: number;
  outcome: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  lastCheckedAt: string | null;
  updatedAt: string;
  readyAt: string | null;
  recording: { filename: string | null; sizeBytes: number | null; durationSeconds: number | null };
  likelyDuplicateCount: number;
  error: string | null;
};
type JobsPayload = {
  jobs: JobSummary[];
  pagination: { page: number; limit: number; total: number; pages: number };
};
type OperationOutcome = {
  attempt?: number;
  operation?: string;
  event?: string;
  destination?: string;
  status: string;
  attempts: number;
  error: string | null;
  updatedAt?: string;
  createdAt?: string;
  completedAt?: string | null;
  deliveredAt?: string | null;
  acknowledgedAt?: string | null;
};
type JobDetailsPayload = {
  job: JobSummary;
  warnings: Array<{ code: string; title: string; message: string; actionRequired: boolean }>;
  likelyDuplicates: Array<{ id: string; title: string; status: string; firstSeenAt: string }>;
  links: { scriberr: string; notion: string | null };
  history: Array<{ attempt: number; state: string; scriberrStatus: string | null; error: string | null; occurredAt: string }>;
  destinations: {
    notion: null | { status: string; audioStatus: string; currentAttempt: number; updatedAt: string; operations: OperationOutcome[] };
    mqtt: OperationOutcome[];
    notifications: OperationOutcome[];
  };
  actions: {
    retranscription: {
      latest: null | { status: "queued" | "starting" | "started" | "cancelled" | "failed"; requested_at: string; started_at: string | null; error: string | null };
      canRequest: boolean;
      canCancel: boolean;
    };
    notion: { canDismiss: boolean; canRecreate: boolean };
  };
};

const basePath = document.querySelector<HTMLMetaElement>('meta[name="sidecarr-base"]')?.content.replace(/\/$/, "") || "/sidecarr";
const scriberrLinkHint = "Open Scriberr. You may need to sign in again.";

function routeFromPath(): Route {
  const route = window.location.pathname.slice(basePath.length).replace(/^\/+|\/+$/g, "");
  if (route === "settings") return { page: "settings" };
  if (route === "jobs") return { page: "jobs" };
  if (route.startsWith("jobs/")) {
    try {
      return { page: "jobs", jobId: decodeURIComponent(route.slice("jobs/".length)) };
    } catch {
      return { page: "jobs" };
    }
  }
  return { page: "overview" };
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${remainingSeconds}s` : `${minutes}m ${remainingSeconds}s`;
}

function statusTone(status: string): "success" | "warning" | "danger" | "muted" {
  const normalized = status.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("attention")) return "danger";
  if (normalized.includes("warning") || normalized.includes("paused") || normalized.includes("missing")) return "warning";
  if (["ready", "healthy", "succeeded", "synchronized", "delivered"].some((value) => normalized.includes(value))) return "success";
  return "muted";
}

async function scriberrToken(): Promise<string | null> {
  try {
    const response = await fetch("/api/v1/auth/refresh", { method: "POST", credentials: "same-origin" });
    if (response.ok) {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "token" in body && typeof body.token === "string") return body.token;
    }
  } catch {
    // The login view handles an unavailable Scriberr instance.
  }
  const sidecarrToken = sessionStorage.getItem("sidecarr-auth-token");
  if (sidecarrToken) return sidecarrToken;
  try {
    const stored = JSON.parse(localStorage.getItem("auth-storage") ?? "null") as unknown;
    if (stored && typeof stored === "object" && "state" in stored) {
      const state = stored.state;
      if (state && typeof state === "object" && "token" in state && typeof state.token === "string") return state.token;
    }
  } catch {
    // Ignore malformed state owned by Scriberr.
  }
  return null;
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromPath);
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authState, setAuthState] = useState<"loading" | "login" | "unavailable" | "ready">("loading");
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("sidecarr-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  const loadSession = useCallback(async (candidate: string | null) => {
    if (!candidate) {
      setAuthState("login");
      return;
    }
    try {
      const response = await fetch(`${basePath}/api/session`, { headers: { Authorization: `Bearer ${candidate}` } });
      if (response.status === 401) {
        sessionStorage.removeItem("sidecarr-auth-token");
        setToken(null);
        setSession(null);
        setAuthState("login");
        return;
      }
      if (!response.ok) {
        setAuthState("unavailable");
        return;
      }
      setToken(candidate);
      sessionStorage.setItem("sidecarr-auth-token", candidate);
      setSession(await response.json() as Session);
      setAuthState("ready");
    } catch {
      setAuthState("unavailable");
    }
  }, []);

  useEffect(() => { void scriberrToken().then(loadSession); }, [loadSession]);
  useEffect(() => {
    if (authState !== "ready") return;
    const interval = window.setInterval(() => void scriberrToken().then(loadSession), 15 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [authState, loadSession]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("sidecarr-theme", theme);
  }, [theme]);
  useEffect(() => {
    const update = () => setRoute(routeFromPath());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  const navigate = (next: Page, jobId?: string) => {
    const suffix = next === "overview" ? "" : `/${next}${jobId ? `/${encodeURIComponent(jobId)}` : ""}`;
    window.history.pushState({}, "", `${basePath}${suffix}`);
    setRoute({ page: next, ...(jobId ? { jobId } : {}) });
  };

  const logout = async () => {
    try {
      await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      localStorage.removeItem("auth-storage");
      sessionStorage.removeItem("sidecarr-auth-token");
      setToken(null);
      setSession(null);
      setAuthState("login");
    }
  };

  if (authState === "loading") return <CenteredState title="Opening Sidecarr" message="Checking your Scriberr session…" />;
  if (authState === "unavailable") {
    return <CenteredState title="Scriberr is unavailable" message="Sidecarr is running, but it cannot validate your login right now." action="Try again" onAction={() => void scriberrToken().then(loadSession)} />;
  }
  if (authState === "login") return <Login onAuthenticated={(next) => void loadSession(next)} theme={theme} setTheme={setTheme} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Primary navigation">
          <NavButton active={route.page === "overview"} label="Overview" icon="◫" onClick={() => navigate("overview")} />
          <NavButton active={route.page === "jobs"} label="Jobs" icon="≡" onClick={() => navigate("jobs")} />
          <NavButton active={route.page === "settings"} label="Settings" icon="⚙" onClick={() => navigate("settings")} />
        </nav>
        <div className="sidebar-footer">
          <ScriberrLink href={session?.scriberrUrl ?? "/"} />
          <button className="nav-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><span>{theme === "dark" ? "☀" : "☾"}</span>{theme === "dark" ? "Light mode" : "Dark mode"}</button>
          <button className="nav-button" onClick={() => void logout()}><span>⇥</span>Sign out</button>
        </div>
      </aside>
      <main>
        <header className="mobile-header"><Brand /><div className="header-actions"><a className="icon-button" aria-label={scriberrLinkHint} title={scriberrLinkHint} href={session?.scriberrUrl ?? "/"}>↗</a><button className="icon-button" aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "☾"}</button><button className="icon-button" aria-label="Sign out" onClick={() => void logout()}>⇥</button></div></header>
        <div className="content">
          {route.page === "overview" && <Overview session={session!} token={token!} reload={() => loadSession(token)} openJob={(jobId) => navigate("jobs", jobId)} />}
          {route.page === "jobs" && <Jobs token={token!} jobId={route.jobId} openJob={(jobId) => navigate("jobs", jobId)} back={() => navigate("jobs")} />}
          {route.page === "settings" && <Settings token={token!} />}
        </div>
      </main>
      <nav className="bottom-nav" aria-label="Mobile navigation">
        <NavButton active={route.page === "overview"} label="Overview" icon="◫" onClick={() => navigate("overview")} />
        <NavButton active={route.page === "jobs"} label="Jobs" icon="≡" onClick={() => navigate("jobs")} />
        <NavButton active={route.page === "settings"} label="Settings" icon="⚙" onClick={() => navigate("settings")} />
        <ScriberrLink href={session?.scriberrUrl ?? "/"} compact />
      </nav>
    </div>
  );
}

function Brand() {
  return <div className="brand"><span className="brand-mark">S</span><span><strong>Sidecarr</strong><small>for Scriberr</small></span></div>;
}

function NavButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: string; onClick: () => void }) {
  return <button className={`nav-button${active ? " active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}><span>{icon}</span>{label}</button>;
}

function ScriberrLink({ href, compact = false }: { href: string; compact?: boolean }) {
  return <a className="nav-button scriberr-link" href={href} title={scriberrLinkHint}><span>↗</span><span className="scriberr-link-label">{compact ? "Scriberr" : "Open Scriberr"}<small>May require login</small></span></a>;
}

function Overview({ session, token, reload, openJob }: { session: Session; token: string; reload: () => void; openJob: (jobId: string) => void }) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [operations, setOperations] = useState<OperationsPayload | null>(null);
  const [operationsError, setOperationsError] = useState("");
  const setupText = useMemo(() => {
    if (session.setup.credentialStatus === "unavailable") return "The worker credential could not be checked.";
    if (session.setup.credentialStatus === "invalid") return "The worker credential was rejected by Scriberr.";
    return "Sidecarr needs a dedicated API key for unattended processing.";
  }, [session]);

  const loadOperations = useCallback(async () => {
    setOperationsError("");
    try {
      const response = await fetch(`${basePath}/api/operations/overview`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Overview request failed with HTTP ${response.status}`);
      setOperations(await response.json() as OperationsPayload);
    } catch (error) {
      setOperationsError(error instanceof Error ? error.message : "Unable to load operational status");
    }
  }, [token]);

  useEffect(() => { void loadOperations(); }, [loadOperations]);

  const connect = async () => {
    setWorking(true);
    setMessage("");
    try {
      const response = await fetch(`${basePath}/api/setup/api-key`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-Sidecarr-Request": "1" }
      });
      const body = await response.json() as { error?: string; restartRequired?: boolean };
      if (!response.ok) setMessage(body.error ?? "Unable to connect Sidecarr.");
      else if (body.restartRequired) setMessage("The key was saved. Restart Sidecarr to activate it.");
      else reload();
    } catch {
      setMessage("Unable to reach Sidecarr.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <section>
      <div className="page-heading"><div><div className="eyebrow">Control center</div><h1>Overview</h1><p className="lede">Current background processing and destination health.</p></div><button className="secondary-button" onClick={() => void loadOperations()}>Refresh</button></div>
      {session.setup.required && (
        <article className="setup-card">
          <div><span className="status-dot warning" /><strong>Background connection needed</strong><p>{setupText}</p></div>
          {session.setup.manageable
            ? <button className="primary-button" disabled={working} onClick={() => void connect()}>{working ? "Connecting…" : "Connect to Scriberr"}</button>
            : <p className="inline-note">Update <code>SIDECARR_SCRIBERR_API_KEY</code> in your environment, then restart Sidecarr.</p>}
          {message && <p className="form-message">{message}</p>}
        </article>
      )}
      {operationsError && <div className="error-banner" role="alert">{operationsError}</div>}
      <div className="health-grid">
        {operations?.health.map((item) => <StatusCard key={item.key} label={item.label} value={item.status.replaceAll("_", " ")} detail={item.detail} tone={statusTone(item.status)} />)}
      </div>
      <div className="section-heading"><div><h2>Recent failures</h2><p>Failures that may need investigation. Recovery actions remain in Scriberr for now.</p></div></div>
      {!operations ? <div className="loading-row"><span className="spinner" />Loading operational status…</div>
        : operations.recentFailures.length === 0 ? <article className="compact-empty"><strong>No recent failures</strong><p>Sidecarr has no recent operational errors to show.</p></article>
          : <div className="failure-list">{operations.recentFailures.map((failure) => (
            <button key={`${failure.category}-${failure.jobId}-${failure.occurredAt}`} className="failure-row" onClick={() => openJob(failure.jobId)}>
              <span className="status-badge danger">{failure.category}</span><span><strong>{failure.title}</strong><small>{failure.message}</small></span><time>{formatTime(failure.occurredAt)}</time><b aria-hidden="true">›</b>
            </button>
          ))}</div>}
    </section>
  );
}

function StatusCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "success" | "warning" | "danger" | "muted" }) {
  return <article className="card health-card"><span className="card-label">{label}</span><strong><span className={`status-dot ${tone}`} />{value}</strong><p>{detail}</p></article>;
}

function Jobs({ token, jobId, openJob, back }: { token: string; jobId?: string; openJob: (jobId: string) => void; back: () => void }) {
  if (jobId) return <JobDetails token={token} jobId={jobId} back={back} openJob={openJob} />;
  return <JobsList token={token} openJob={openJob} />;
}

function JobsList({ token, openJob }: { token: string; openJob: (jobId: string) => void }) {
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<JobsPayload | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`${basePath}/api/jobs?page=${page}&limit=10`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Jobs request failed with HTTP ${response.status}`);
      setPayload(await response.json() as JobsPayload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load jobs");
    }
  }, [page, token]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section>
      <div className="page-heading"><div><div className="eyebrow">Operations</div><h1>Jobs</h1><p className="lede">The most recently discovered Scriberr jobs.</p></div><button className="secondary-button" onClick={() => void load()}>Refresh</button></div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {!payload ? <div className="loading-row"><span className="spinner" />Loading jobs…</div>
        : payload.jobs.length === 0 ? <article className="empty-state"><span>◌</span><h2>No jobs yet</h2><p>New Scriberr recordings will appear here after Sidecarr discovers them.</p></article>
          : <>
            <div className="jobs-list">
              <div className="jobs-header"><span>Recording</span><span>Status</span><span>Discovered</span><span>Activity</span><span /></div>
              {payload.jobs.map((job) => <button key={job.id} className="job-row" onClick={() => openJob(job.id)}>
                <span className="job-title"><strong>{job.title}</strong><small>{job.id}</small>{job.likelyDuplicateCount > 0 && <em>Likely duplicate · {job.likelyDuplicateCount} related</em>}</span>
                <span><span className={`status-badge ${statusTone(job.status)}`}>{job.status}</span></span>
                <time>{formatTime(job.firstSeenAt)}</time>
                <time>{formatTime(job.updatedAt)}</time>
                <b aria-hidden="true">›</b>
              </button>)}
            </div>
            <div className="pagination"><button className="secondary-button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>← Newer</button><span>Page {payload.pagination.page} of {payload.pagination.pages} · {payload.pagination.total} jobs</span><button className="secondary-button" disabled={page >= payload.pagination.pages} onClick={() => setPage((current) => current + 1)}>Older →</button></div>
          </>}
    </section>
  );
}

function JobDetails({ token, jobId, back, openJob }: { token: string; jobId: string; back: () => void; openJob: (jobId: string) => void }) {
  const [payload, setPayload] = useState<JobDetailsPayload | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionRunning, setActionRunning] = useState("");
  const [confirmRetranscription, setConfirmRetranscription] = useState(() => new URLSearchParams(window.location.search).get("retranscribe") === "true");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    setError("");
    try {
      const response = await fetch(`${basePath}/api/jobs/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(response.status === 404 ? "This job is not tracked by Sidecarr." : `Job request failed with HTTP ${response.status}`);
      setPayload(await response.json() as JobDetailsPayload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load job details");
    } finally {
      setRefreshing(false);
    }
  }, [jobId, token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!payload?.job.active) return;
    const refreshIfVisible = () => { if (document.visibilityState === "visible") void load(true); };
    const interval = window.setInterval(refreshIfVisible, 30_000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [load, payload?.job.active]);

  useEffect(() => {
    setConfirmRetranscription(new URLSearchParams(window.location.search).get("retranscribe") === "true");
  }, [jobId]);

  const mutate = async (action: "retranscribe" | "cancel-retranscribe" | "dismiss-notion" | "recreate-notion") => {
    const routes = {
      retranscribe: { path: "retranscribe", method: "POST" },
      "cancel-retranscribe": { path: "retranscribe", method: "DELETE" },
      "dismiss-notion": { path: "notion-warning", method: "DELETE" },
      "recreate-notion": { path: "notion-page", method: "POST" }
    } as const;
    setActionRunning(action);
    setActionError("");
    try {
      const target = routes[action];
      const response = await fetch(`${basePath}/api/jobs/${encodeURIComponent(jobId)}/actions/${target.path}`, {
        method: target.method,
        headers: { Authorization: `Bearer ${token}`, "X-Sidecarr-Request": "1" }
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Action failed with HTTP ${response.status}`);
      setConfirmRetranscription(false);
      if (window.location.search) window.history.replaceState({}, "", window.location.pathname);
      await load();
    } catch (mutationError) {
      setActionError(mutationError instanceof Error ? mutationError.message : "Unable to complete the action");
    } finally {
      setActionRunning("");
    }
  };

  if (!payload && !error) return <CenteredState title="Loading job" message="Reading Sidecarr's operational history…" />;
  if (!payload) return <section><button className="back-button" onClick={back}>← Jobs</button><article className="empty-state"><h2>Job unavailable</h2><p>{error}</p><button className="primary-button" onClick={() => void load()}>Try again</button></article></section>;
  const { job } = payload;
  return (
    <section>
      <button className="back-button" onClick={back}>← Jobs</button>
      <div className="page-heading job-heading"><div><div className="eyebrow">Job details</div><h1>{job.title}</h1><p className="job-id">{job.id}</p></div><div className="heading-actions"><span className={`status-badge large ${statusTone(job.status)}`}>{job.status}</span><button className="secondary-button" disabled={refreshing} onClick={() => void load()}>{refreshing ? "Refreshing…" : "Refresh"}</button></div></div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {actionError && <div className="error-banner" role="alert">{actionError}</div>}
      {job.error && <div className="error-banner"><strong>Latest error</strong><span>{job.error}</span></div>}
      {payload.warnings.map((warning) => <aside className="warning-banner" key={warning.code}>
        <div><strong>{warning.title}</strong><p>{warning.message}</p></div>
        {!warning.actionRequired && <span className="status-badge success">No action required</span>}
      </aside>)}
      {payload.actions.retranscription.latest?.status === "queued" && <aside className="action-banner">
        <div><strong>Re-transcription queued</strong><p>Sidecarr will start it after the current summary finishes.</p></div>
        <button className="secondary-button" disabled={Boolean(actionRunning)} onClick={() => void mutate("cancel-retranscribe")}>{actionRunning === "cancel-retranscribe" ? "Cancelling…" : "Cancel queued re-transcription"}</button>
      </aside>}
      {payload.actions.retranscription.latest?.status === "failed" && <div className="error-banner"><strong>Re-transcription did not start</strong><span>{payload.actions.retranscription.latest.error}</span></div>}
      {payload.likelyDuplicates.length > 0 && <aside className="duplicate-banner">
        <div><strong>Likely duplicate recordings</strong><p>{payload.likelyDuplicates.length} other {payload.likelyDuplicates.length === 1 ? "job has" : "jobs have"} the same filename and arrived within one hour. Review them before removing anything in Scriberr.</p></div>
        <div className="duplicate-links">{payload.likelyDuplicates.map((candidate) => <button key={candidate.id} onClick={() => openJob(candidate.id)}><span>{formatTime(candidate.firstSeenAt)}</span><strong>{candidate.status}</strong><b aria-hidden="true">›</b></button>)}</div>
      </aside>}
      <div className="detail-links"><a className="primary-button link-button" href={payload.links.scriberr}>Open in Scriberr ↗</a>{payload.links.notion && <a className="secondary-button link-button" href={payload.links.notion}>Open in Notion ↗</a>}<button className="secondary-button" disabled={!payload.actions.retranscription.canRequest || Boolean(actionRunning)} onClick={() => setConfirmRetranscription(true)}>Re-transcribe</button></div>
      <div className="detail-grid">
        <DetailValue label="Filename" value={job.recording.filename ?? "—"} />
        <DetailValue label="Duration" value={formatDuration(job.recording.durationSeconds)} />
        <DetailValue label="File size" value={formatFileSize(job.recording.sizeBytes)} />
        <DetailValue label="Attempt" value={String(job.attempt)} />
        <DetailValue label="Source" value={job.source} />
        <DetailValue label="Discovered" value={formatTime(job.firstSeenAt)} />
        <DetailValue label="Last activity" value={formatTime(job.updatedAt)} />
        <DetailValue label="Last checked" value={formatTime(job.lastCheckedAt)} />
        <DetailValue label="Ready at" value={formatTime(job.readyAt)} />
        <DetailValue label="Scriberr status" value={job.scriberrStatus ?? "Unknown"} />
        <DetailValue label="Sidecarr state" value={job.state.replaceAll("_", " ")} />
        <DetailValue label="Outcome" value={job.outcome?.replaceAll("_", " ") ?? "—"} />
      </div>

      <OperationsSection title="State history" empty="No state history is available.">
        {payload.history.map((entry, index) => <div className="timeline-row" key={`${entry.attempt}-${entry.state}-${entry.occurredAt}-${index}`}><span className={`timeline-dot ${statusTone(entry.state)}`} /><div><strong>{entry.state.replaceAll("_", " ")}</strong><small>Attempt {entry.attempt}{entry.scriberrStatus ? ` · Scriberr: ${entry.scriberrStatus}` : ""}</small>{entry.error && <p>{entry.error}</p>}</div><time>{formatTime(entry.occurredAt)}</time></div>)}
      </OperationsSection>

      <div className="destination-grid">
        <DestinationCard title="Notion" status={payload.destinations.notion?.status ?? "Not configured"} outcomes={payload.destinations.notion?.operations ?? []} extra={payload.destinations.notion ? `Attempt ${payload.destinations.notion.currentAttempt} · Audio: ${payload.destinations.notion.audioStatus} · Updated ${formatTime(payload.destinations.notion.updatedAt)}` : undefined} />
        <DestinationCard title="MQTT" status={destinationStatus(payload.destinations.mqtt)} outcomes={payload.destinations.mqtt} />
        <DestinationCard title="Notifications" status={destinationStatus(payload.destinations.notifications)} outcomes={payload.destinations.notifications} />
      </div>
      {(payload.actions.notion.canDismiss || payload.actions.notion.canRecreate) && <div className="notion-actions">
        <strong>Resolve Notion warning</strong><p>Restore and re-share the existing page, dismiss this warning, or recreate the managed page.</p><div>
          {payload.actions.notion.canDismiss && <button className="secondary-button" disabled={Boolean(actionRunning)} onClick={() => void mutate("dismiss-notion")}>Dismiss warning</button>}
          {payload.actions.notion.canRecreate && <button className="primary-button" disabled={Boolean(actionRunning)} onClick={() => void mutate("recreate-notion")}>{actionRunning === "recreate-notion" ? "Recreating…" : "Recreate Notion page"}</button>}
        </div>
      </div>}
      {confirmRetranscription && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmRetranscription(false); }}>
        <section className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="retranscribe-title">
          <div className="eyebrow">New processing attempt</div><h2 id="retranscribe-title">Re-transcribe this recording?</h2>
          <p>Scriberr will reuse the previous transcription settings and replace its current transcript and summary. Sidecarr will preserve the previous generated content in Notion and keep your Notes.</p>
          {job.state.includes("summary") && <p className="inline-note">The request will remain queued until the current summary finishes.</p>}
          <div className="modal-actions"><button className="secondary-button" disabled={Boolean(actionRunning)} onClick={() => setConfirmRetranscription(false)}>Cancel</button><button className="primary-button" disabled={Boolean(actionRunning)} onClick={() => void mutate("retranscribe")}>{actionRunning === "retranscribe" ? "Requesting…" : "Re-transcribe"}</button></div>
        </section>
      </div>}
    </section>
  );
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return <article><span>{label}</span><strong>{value}</strong></article>;
}

function OperationsSection({ title, empty, children }: { title: string; empty: string; children: ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <section className="operations-section"><div className="section-heading"><h2>{title}</h2></div>{hasChildren ? <div className="timeline">{children}</div> : <p className="muted-copy">{empty}</p>}</section>;
}

function destinationStatus(outcomes: OperationOutcome[]): string {
  if (outcomes.length === 0) return "No deliveries";
  if (outcomes.some((outcome) => outcome.status === "failed")) return "Needs attention";
  if (outcomes.some((outcome) => outcome.status === "pending")) return "Pending";
  return "Succeeded";
}

function outcomeDetail(outcome: OperationOutcome): string {
  const timestamp = outcome.completedAt ?? outcome.deliveredAt ?? outcome.updatedAt ?? outcome.createdAt;
  return [
    outcome.attempt ? `Job attempt ${outcome.attempt}` : undefined,
    outcome.attempts === 0 ? "No failed attempts" : `${outcome.attempts} failed ${outcome.attempts === 1 ? "attempt" : "attempts"}`,
    timestamp ? formatTime(timestamp) : undefined,
    outcome.acknowledgedAt ? `Dismissed ${formatTime(outcome.acknowledgedAt)}` : outcome.error ?? undefined
  ].filter(Boolean).join(" · ");
}

function DestinationCard({ title, status, outcomes, extra }: { title: string; status: string; outcomes: OperationOutcome[]; extra?: string }) {
  return <article className="destination-card"><header><div><span>{title}</span><strong>{status}</strong></div><span className={`status-dot ${statusTone(status)}`} /></header>{extra && <p>{extra}</p>}{outcomes.length === 0 ? <p>No recorded activity.</p> : <div className="outcome-list">{outcomes.slice(0, 8).map((outcome, index) => <div key={`${outcome.operation ?? outcome.event ?? outcome.destination}-${index}`}><span><strong>{outcome.operation ?? outcome.event ?? outcome.destination}</strong><small>{outcomeDetail(outcome)}</small></span><span className={`status-badge ${statusTone(outcome.status)}`}>{outcome.status}</span></div>)}</div>}</article>;
}

const groupLabels: Record<string, { title: string; description: string; optional?: boolean }> = {
  scriberr: { title: "Scriberr", description: "Connection, browser links, and API behavior." },
  discovery: { title: "Discovery", description: "How Sidecarr finds work and checks for missed jobs." },
  notion: { title: "Notion", description: "Publish completed recordings to a shared Notion page.", optional: true },
  mqtt: { title: "MQTT", description: "Publish lifecycle events to an MQTT broker.", optional: true },
  notifications: { title: "Notifications", description: "Send job-ready webhooks or direct email.", optional: true },
  summaries: { title: "Summaries", description: "Control Sidecarr-requested summary generation." }
};

function settingLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase())
    .replace(/\bApi\b/g, "API")
    .replace(/\bMqtt\b/g, "MQTT")
    .replace(/\bSmtp\b/g, "SMTP")
    .replace(/\bUrl\b/g, "URL")
    .replace(/\bQos\b/g, "QoS");
}

function Settings({ token }: { token: string }) {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [secretActions, setSecretActions] = useState<Record<string, "preserve" | "replace" | "remove">>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");

  const acceptPayload = useCallback((next: SettingsPayload, resetGroup?: string) => {
    const nextDrafts: Record<string, string> = {};
    const nextSecrets: Record<string, "preserve"> = {};
    for (const group of next.groups) {
      for (const setting of group.settings) {
        nextDrafts[setting.key] = setting.secret || setting.source === "default" || setting.source === "unset"
          ? ""
          : String(setting.value ?? "");
        if (setting.secret) nextSecrets[setting.key] = "preserve";
      }
    }
    setPayload(next);
    setDrafts((current) => resetGroup
      ? Object.fromEntries(Object.entries(nextDrafts).map(([key, value]) => {
          const settingGroup = next.groups.find((group) => group.settings.some((setting) => setting.key === key))?.key;
          return [key, settingGroup === resetGroup ? value : current[key] ?? value];
        }))
      : nextDrafts);
    setSecretActions((current) => resetGroup
      ? Object.fromEntries(Object.entries(nextSecrets).map(([key, value]) => {
          const settingGroup = next.groups.find((group) => group.settings.some((setting) => setting.key === key))?.key;
          return [key, settingGroup === resetGroup ? value : current[key] ?? value];
        }))
      : nextSecrets);
  }, []);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const response = await fetch(`${basePath}/api/settings`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Settings request failed with HTTP ${response.status}`);
      acceptPayload(await response.json() as SettingsPayload);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load settings");
    }
  }, [acceptPayload, token]);

  useEffect(() => { void load(); }, [load]);

  const save = async (group: SettingsGroup) => {
    if (!payload) return;
    setSaving(group.key);
    setMessage((current) => ({ ...current, [group.key]: "" }));
    const values: Record<string, unknown> = {};
    for (const setting of group.settings.filter((candidate) => candidate.editable)) {
      if (setting.secret) {
        const action = secretActions[setting.key] ?? "preserve";
        values[setting.key] = action === "replace" ? { action, value: drafts[setting.key] ?? "" } : { action };
      } else {
        values[setting.key] = drafts[setting.key]?.trim() ? drafts[setting.key] : null;
      }
    }
    try {
      const response = await fetch(`${basePath}/api/settings/${group.key}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Sidecarr-Request": "1" },
        body: JSON.stringify({ revision: payload.revision, values })
      });
      const body = await response.json() as SettingsPayload & { error?: string };
      if (!response.ok && response.status !== 202) {
        if (response.status === 409) void load();
        throw new Error(body.error ?? `Save failed with HTTP ${response.status}`);
      }
      acceptPayload(body, group.key);
      setMessage((current) => ({
        ...current,
        [group.key]: body.restartRequired ? "Saved, but activation failed. Restart Sidecarr or check Docker logs." : "Saved and active."
      }));
    } catch (error) {
      setMessage((current) => ({ ...current, [group.key]: error instanceof Error ? error.message : "Unable to save settings" }));
    } finally {
      setSaving(null);
    }
  };

  if (loadError) return <section><div className="eyebrow">Configuration</div><h1>Settings</h1><article className="empty-state"><h2>Settings unavailable</h2><p>{loadError}</p><button className="primary-button" onClick={() => void load()}>Try again</button></article></section>;
  if (!payload) return <CenteredState title="Loading settings" message="Reading the effective Sidecarr configuration…" />;

  return (
    <section>
      <div className="eyebrow">Configuration</div>
      <h1>Settings</h1>
      <p className="lede">Environment values take priority and cannot be edited here. Empty fields use the shown default or remain disabled.</p>
      <div className="settings-list">
        {payload.groups.map((group) => (
          <SettingsSection
            key={group.key}
            group={group}
            issues={payload.issues.filter((issue) => issue.group === group.key)}
            drafts={drafts}
            secretActions={secretActions}
            saving={saving === group.key}
            message={message[group.key]}
            setDraft={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
            setSecretAction={(key, action) => setSecretActions((current) => ({ ...current, [key]: action }))}
            save={() => void save(group)}
          />
        ))}
      </div>
    </section>
  );
}

function SettingsSection({ group, issues, drafts, secretActions, saving, message, setDraft, setSecretAction, save }: {
  group: SettingsGroup;
  issues: SettingsPayload["issues"];
  drafts: Record<string, string>;
  secretActions: Record<string, "preserve" | "replace" | "remove">;
  saving: boolean;
  message?: string;
  setDraft: (key: string, value: string) => void;
  setSecretAction: (key: string, action: "preserve" | "replace" | "remove") => void;
  save: () => void;
}) {
  const info = groupLabels[group.key] ?? { title: group.key, description: "" };
  const basic = group.settings.filter((setting) => !setting.advanced);
  const advanced = group.settings.filter((setting) => setting.advanced);
  const configured = group.settings.some((setting) => ["environment", "database"].includes(setting.source));
  const content = (
    <form onSubmit={(event) => { event.preventDefault(); save(); }}>
      <div className="settings-fields">
        {basic.map((setting) => <SettingField key={setting.key} setting={setting} draft={drafts[setting.key] ?? ""} secretAction={secretActions[setting.key] ?? "preserve"} setDraft={setDraft} setSecretAction={setSecretAction} />)}
      </div>
      {advanced.length > 0 && <details className="advanced-settings"><summary>Advanced settings</summary><div className="settings-fields">{advanced.map((setting) => <SettingField key={setting.key} setting={setting} draft={drafts[setting.key] ?? ""} secretAction={secretActions[setting.key] ?? "preserve"} setDraft={setDraft} setSecretAction={setSecretAction} />)}</div></details>}
      {issues.length > 0 && <div className="settings-warning" role="status">{issues.map((issue) => <div key={`${issue.key}-${issue.message}`}>{settingLabel(issue.key)}: {issue.message}</div>)}</div>}
      <div className="settings-actions"><button className="primary-button" disabled={saving || !group.settings.some((setting) => setting.editable)}>{saving ? "Saving…" : "Save section"}</button>{message && <span className="save-message">{message}</span>}</div>
    </form>
  );
  if (info.optional) {
    return <details className="settings-section" defaultOpen={configured}><summary><span><strong>{info.title}</strong><small>{info.description}</small></span><span className={`integration-state ${configured ? "configured" : ""}`}>{configured ? "Configured" : "Not configured"}</span></summary>{content}</details>;
  }
  return <article className="settings-section fixed"><header><div><strong>{info.title}</strong><small>{info.description}</small></div></header>{content}</article>;
}

function SettingField({ setting, draft, secretAction, setDraft, setSecretAction }: {
  setting: SettingSnapshot;
  draft: string;
  secretAction: "preserve" | "replace" | "remove";
  setDraft: (key: string, value: string) => void;
  setSecretAction: (key: string, action: "preserve" | "replace" | "remove") => void;
}) {
  const placeholder = setting.secret
    ? setting.configured ? "Configured — leave blank to preserve" : "Not configured"
    : setting.defaultValue ? `Default: ${setting.defaultValue}` : "Not configured";
  const common = { id: setting.key, disabled: !setting.editable, value: draft, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { setDraft(setting.key, event.target.value); if (setting.secret) setSecretAction(setting.key, event.target.value ? "replace" : "preserve"); } };
  return (
    <label className="setting-field" htmlFor={setting.key}>
      <span><strong>{settingLabel(setting.key)}</strong><code>{setting.env}</code></span>
      {setting.input === "select" || setting.input === "boolean"
        ? <select {...common}><option value="">{placeholder}</option>{(setting.input === "boolean" ? ["true", "false"] : setting.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}</select>
        : <input {...common} type={setting.secret ? "password" : setting.input} placeholder={secretAction === "remove" ? "Will be removed when saved" : placeholder} />}
      <small>{setting.source === "environment" ? `Managed by ${setting.env}; remove it from .env to edit here.` : `Effective source: ${setting.source}`}</small>
      {setting.secret && setting.editable && setting.configured && <button type="button" className="text-button" onClick={() => { setDraft(setting.key, ""); setSecretAction(setting.key, secretAction === "remove" ? "preserve" : "remove"); }}>{secretAction === "remove" ? "Keep existing secret" : "Remove secret"}</button>}
      {setting.error && <small className="field-error">{setting.error}</small>}
    </label>
  );
}

function Login({ onAuthenticated, theme, setTheme }: { onAuthenticated: (token: string) => void; theme: Theme; setTheme: (theme: Theme) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const body: unknown = await response.json();
      if (!response.ok) setError(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Login failed");
      else if (body && typeof body === "object" && "token" in body && typeof body.token === "string") {
        setPassword("");
        onAuthenticated(body.token);
      } else setError("Scriberr returned an invalid login response");
    } catch {
      setError("Scriberr is unavailable. Try again shortly.");
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="login-page">
      <button className="theme-corner" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀ Light" : "☾ Dark"}</button>
      <div className="login-panel"><Brand /><div><h1>Welcome back</h1><p>Use your Scriberr account to open Sidecarr.</p></div>
        <form onSubmit={(event) => void submit(event)}>
          <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" disabled={working || !username.trim() || !password}>{working ? "Signing in…" : "Sign in"}</button>
        </form>
        <small>Your password is sent directly to Scriberr and is never stored by Sidecarr.</small>
      </div>
    </div>
  );
}

function Placeholder({ title, message }: { title: string; message: string }) {
  return <section><div className="eyebrow">Foundation</div><h1>{title}</h1><article className="empty-state"><span>◌</span><h2>Coming next</h2><p>{message}</p></article></section>;
}

function CenteredState({ title, message, action, onAction }: { title: string; message: string; action?: string; onAction?: () => void }) {
  return <div className="centered-state"><Brand /><div className="spinner" /><h1>{title}</h1><p>{message}</p>{action && <button className="primary-button" onClick={onAction}>{action}</button>}</div>;
}
