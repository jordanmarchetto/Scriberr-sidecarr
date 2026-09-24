import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Page = "overview" | "jobs" | "settings";
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

const basePath = document.querySelector<HTMLMetaElement>('meta[name="sidecarr-base"]')?.content.replace(/\/$/, "") || "/sidecarr";
const scriberrLinkHint = "Open Scriberr. You may need to sign in again.";

function pageFromPath(): Page {
  const route = window.location.pathname.slice(basePath.length).replace(/^\/+|\/+$/g, "");
  return route === "jobs" || route === "settings" ? route : "overview";
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
  const [page, setPage] = useState<Page>(pageFromPath);
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
    const update = () => setPage(pageFromPath());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  const navigate = (next: Page) => {
    window.history.pushState({}, "", `${basePath}${next === "overview" ? "" : `/${next}`}`);
    setPage(next);
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
          <NavButton active={page === "overview"} label="Overview" icon="◫" onClick={() => navigate("overview")} />
          <NavButton active={page === "jobs"} label="Jobs" icon="≡" onClick={() => navigate("jobs")} />
          <NavButton active={page === "settings"} label="Settings" icon="⚙" onClick={() => navigate("settings")} />
        </nav>
        <div className="sidebar-footer">
          <a className="nav-button" href={session?.scriberrUrl ?? "/"} title={scriberrLinkHint}><span>↗</span>Open Scriberr</a>
          <button className="nav-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><span>{theme === "dark" ? "☀" : "☾"}</span>{theme === "dark" ? "Light mode" : "Dark mode"}</button>
          <button className="nav-button" onClick={() => void logout()}><span>⇥</span>Sign out</button>
        </div>
      </aside>
      <main>
        <header className="mobile-header"><Brand /><div className="header-actions"><a className="icon-button" aria-label={scriberrLinkHint} title={scriberrLinkHint} href={session?.scriberrUrl ?? "/"}>↗</a><button className="icon-button" aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "☾"}</button><button className="icon-button" aria-label="Sign out" onClick={() => void logout()}>⇥</button></div></header>
        <div className="content">
          {page === "overview" && <Overview session={session!} token={token!} reload={() => loadSession(token)} />}
          {page === "jobs" && <Placeholder title="Jobs" message="Job history and processing details arrive in the operations checkpoint." />}
          {page === "settings" && <Settings token={token!} />}
        </div>
      </main>
      <nav className="bottom-nav" aria-label="Mobile navigation">
        <NavButton active={page === "overview"} label="Overview" icon="◫" onClick={() => navigate("overview")} />
        <NavButton active={page === "jobs"} label="Jobs" icon="≡" onClick={() => navigate("jobs")} />
        <NavButton active={page === "settings"} label="Settings" icon="⚙" onClick={() => navigate("settings")} />
        <a className="nav-button" href={session?.scriberrUrl ?? "/"} title={scriberrLinkHint}><span>↗</span>Scriberr</a>
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

function Overview({ session, token, reload }: { session: Session; token: string; reload: () => void }) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const setupText = useMemo(() => {
    if (session.setup.credentialStatus === "unavailable") return "The worker credential could not be checked.";
    if (session.setup.credentialStatus === "invalid") return "The worker credential was rejected by Scriberr.";
    return "Sidecarr needs a dedicated API key for unattended processing.";
  }, [session]);

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
      <div className="eyebrow">Control center</div>
      <h1>Overview</h1>
      <p className="lede">Sidecarr is connected to your Scriberr workspace.</p>
      {session.setup.required && (
        <article className="setup-card">
          <div><span className="status-dot warning" /><strong>Background connection needed</strong><p>{setupText}</p></div>
          {session.setup.manageable
            ? <button className="primary-button" disabled={working} onClick={() => void connect()}>{working ? "Connecting…" : "Connect to Scriberr"}</button>
            : <p className="inline-note">Update <code>SIDECARR_SCRIBERR_API_KEY</code> in your environment, then restart Sidecarr.</p>}
          {message && <p className="form-message">{message}</p>}
        </article>
      )}
      <div className="card-grid">
        <StatusCard label="UI status" value="Ready" detail="Your Scriberr session is authenticated." />
        <StatusCard label="Worker connection" value={session.setup.credentialStatus === "valid" ? "Connected" : "Needs attention"} detail={`Source: ${session.setup.source}`} warning={session.setup.credentialStatus !== "valid"} />
        <article className="card"><span className="card-label">Next checkpoint</span><strong>Settings</strong><p>Manage behavioral configuration without editing the environment.</p></article>
      </div>
    </section>
  );
}

function StatusCard({ label, value, detail, warning = false }: { label: string; value: string; detail: string; warning?: boolean }) {
  return <article className="card"><span className="card-label">{label}</span><strong><span className={`status-dot${warning ? " warning" : ""}`} />{value}</strong><p>{detail}</p></article>;
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
