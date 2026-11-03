import { useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowLeft, ArrowUpRight, Box, Check, ChevronDown, CircleHelp,
  Clipboard, Code2, Copy, Database, ExternalLink, FileJson2, Globe2,
  LoaderCircle, LogOut, Plus, Radio, RefreshCw, Search, Server, Settings2,
  ShieldCheck, SquareTerminal, Trash2, X, Zap, FolderGit2, KeyRound,
} from "lucide-react";

type Template = { id: string; name: string; provider: string; description: string; routeCount: number };
type MockResponse = { uuid: string; statusCode: number; label?: string; body?: string; latency?: number; rules?: unknown[]; default?: boolean };
type MockRoute = { uuid: string; method: string; endpoint: string; responses: MockResponse[] };
type EnvironmentData = { uuid: string; name: string; routes: MockRoute[]; [key: string]: any };
type Environment = {
  id: string; name: string; slug: string; provider: string; status: "stopped" | "running" | "error";
  url: string; internalPort?: number; data?: EnvironmentData; projectId?: string | null; testInstance?: boolean;
};
type AuthState = { authenticated: boolean; email: string };
type Project = { id: string; name: string; slug: string; status: "active" | "inactive"; environments: Environment[]; createdAt: string };
type ProjectCredential = { project: Pick<Project, "id" | "name" | "slug">; token: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload as T;
}

function methodColor(method: string) {
  return method === "get" ? "get" : method === "post" ? "post" : method === "put" ? "put" : method === "delete" ? "delete" : "other";
}

function routeCount(environment: Environment) { return environment.data?.routes?.length ?? 0; }

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [modal, setModal] = useState<"create" | "route" | "project" | null>(null);
  const [projectCredential, setProjectCredential] = useState<ProjectCredential | null>(null);
  const [createTemplate, setCreateTemplate] = useState("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"environments" | "providers" | "projects">("environments");

  const selected = environments.find((environment) => environment.id === selectedId) ?? null;
  const runningCount = environments.filter((environment) => environment.status === "running").length;
  const totalRoutes = environments.reduce((sum, environment) => sum + routeCount(environment), 0);
  const filtered = useMemo(() => environments.filter((environment) =>
    `${environment.name} ${environment.provider}`.toLowerCase().includes(query.toLowerCase())), [environments, query]);

  async function loadData() {
    setLoading(true);
    try {
      const status = await request<AuthState>("/api/auth/status");
      setAuth(status);
      if (status.authenticated) {
        const [nextTemplates, nextEnvironments, nextProjects] = await Promise.all([
          request<Template[]>("/api/templates"), request<Environment[]>("/api/environments"), request<Project[]>("/api/projects"),
        ]);
        setTemplates(nextTemplates);
        setEnvironments(nextEnvironments);
        setProjects(nextProjects);
        setSelectedId((current) => current && nextEnvironments.some((item) => item.id === current) ? current : null);
      }
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Could not reach the mock server.");
    } finally { setLoading(false); }
  }

  function notify(type: "success" | "error", text: string) {
    setNotice({ type, text });
    window.setTimeout(() => setNotice(null), 3800);
  }

  useEffect(() => { void loadData(); }, []);

  useEffect(() => {
    if (!auth?.authenticated || view !== "projects") return;
    let disposed = false;
    const refreshProjects = async () => {
      try {
        const next = await request<Project[]>("/api/projects");
        if (!disposed) setProjects(next);
      } catch { /* Keep the last dashboard state while the service is unreachable. */ }
    };
    const timer = window.setInterval(() => void refreshProjects(), 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [auth?.authenticated, view]);

  async function createEnvironment(name: string, templateId: string) {
    try {
      const created = await request<Environment>("/api/environments", { method: "POST", body: JSON.stringify({ name, templateId }) });
      await loadData();
      setSelectedId(created.id);
      setView("environments");
      setModal(null);
      notify("success", "Mock environment created.");
    } catch (error) { notify("error", error instanceof Error ? error.message : "Could not create environment."); }
  }

  async function createProject(name: string) {
    try {
      const created = await request<ProjectCredential>("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
      setProjectCredential(created);
      setModal(null);
      setView("projects");
      await loadData();
      setProjectCredential(created);
      notify("success", "Project token created. Copy it now; it is shown only once.");
    } catch (error) { notify("error", error instanceof Error ? error.message : "Could not create project."); }
  }

  async function rotateProjectToken(project: Project) {
    try {
      const rotated = await request<ProjectCredential>(`/api/projects/${encodeURIComponent(project.id)}/token`, { method: "POST" });
      setProjectCredential(rotated);
      await loadData();
      setProjectCredential(rotated);
      notify("success", "Project token rotated. The previous token has been revoked.");
    } catch (error) { notify("error", error instanceof Error ? error.message : "Could not rotate project token."); }
  }

  async function deploy(environment: Environment) {
    setBusyId(environment.id);
    try {
      await request(`/api/environments/${environment.id}/deploy`, { method: "POST" });
      await loadData();
      notify("success", `${environment.name} is serving requests.`);
    } catch (error) { notify("error", error instanceof Error ? error.message : "Could not deploy environment."); }
    finally { setBusyId(null); }
  }

  async function stop(environment: Environment) {
    setBusyId(environment.id);
    try {
      await request(`/api/environments/${environment.id}/stop`, { method: "POST" });
      await loadData();
      notify("success", `${environment.name} is stopped.`);
    } catch (error) { notify("error", error instanceof Error ? error.message : "Could not stop environment."); }
    finally { setBusyId(null); }
  }

  async function deleteEnvironment(environment: Environment) {
    if (!window.confirm(`Delete ${environment.name}? Its mock URL will stop responding.`)) return;
    try {
      await request(`/api/environments/${environment.id}`, { method: "DELETE" });
      setSelectedId(null);
      await loadData();
      notify("success", "Environment deleted.");
    } catch (error) { notify("error", error instanceof Error ? error.message : "Could not delete environment."); }
  }

  async function addRoute(input: { method: string; path: string; statusCode: number; body: string; headers: Record<string, string>; latency: number }) {
    if (!selected) return;
    try {
      await request(`/api/environments/${selected.id}/routes`, { method: "POST", body: JSON.stringify(input) });
      await loadData();
      setModal(null);
      notify("success", "Route added.");
    } catch (error) { notify("error", error instanceof Error ? error.message : "Could not add route."); }
  }

  async function deleteRoute(route: MockRoute) {
    if (!selected || !window.confirm(`Delete ${route.method.toUpperCase()} /${route.endpoint}?`)) return;
    try {
      await request(`/api/environments/${selected.id}/routes/${route.uuid}`, { method: "DELETE" });
      await loadData();
      notify("success", "Route removed.");
    } catch (error) { notify("error", error instanceof Error ? error.message : "Could not remove route."); }
  }

  async function saveDocument(data: EnvironmentData) {
    if (!selected) return;
    try {
      await request(`/api/environments/${selected.id}`, { method: "PUT", body: JSON.stringify({ data }) });
      await loadData();
      notify("success", selected.status === "running" ? "Changes saved and redeployed." : "Changes saved.");
    } catch (error) { notify("error", error instanceof Error ? error.message : "Could not save environment."); }
  }

  async function logout() {
    await request("/api/auth/logout", { method: "POST" });
    setAuth({ authenticated: false, email: auth?.email ?? "" });
  }

  if (loading && !auth) return <div className="boot"><div className="boot-mark">M</div><LoaderCircle className="spin" size={18} /><span>Connecting to runtime</span></div>;
  if (!auth?.authenticated) return <Login email={auth?.email ?? "admin@example.test"} onSuccess={() => void loadData()} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><span>M</span></div><div><strong>mock server</strong><small>API workspace</small></div></div>
        <div className="workspace-switcher"><div className="workspace-icon">L</div><span>Launchpad workspace</span><ChevronDown size={15} /></div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Workspace navigation">
          <button className={`nav-item ${view === "environments" && !selected ? "selected" : ""}`} onClick={() => { setSelectedId(null); setView("environments"); }}><Server size={17} /> Mock environments <span className="nav-count">{environments.length}</span></button>
          <button className={`nav-item ${view === "projects" ? "selected" : ""}`} onClick={() => { setSelectedId(null); setView("projects"); }}><FolderGit2 size={17} /> Projects <span className="nav-count">{projects.length}</span></button>
          <button className={`nav-item ${view === "providers" ? "selected" : ""}`} onClick={() => { setSelectedId(null); setView("providers"); }}><Box size={17} /> Provider catalog</button>
        </nav>
        <div className="side-divider" />
        <div className="nav-label side-label-row"><span>MOCK APIS</span><button className="icon-button tiny" aria-label="Create mock API" onClick={() => setModal("create")}><Plus size={15} /></button></div>
        <nav className="side-nav env-nav" aria-label="Mock APIs">
          {environments.slice(0, 8).map((environment) => <button key={environment.id} className={`nav-item env-nav-item ${selectedId === environment.id ? "selected" : ""}`} onClick={() => { setSelectedId(environment.id); setView("environments"); }}>
            <span className={`status-mark ${environment.status}`} /><span className="nav-env-name">{environment.name}</span>
          </button>)}
          {environments.length > 8 && <span className="more-envs">+{environments.length - 8} more in workspace</span>}
          {!environments.length && <p className="nav-empty">Your environments will appear here.</p>}
        </nav>
        <div className="sidebar-bottom">
          <div className="runtime-chip"><span className="runtime-dot" /> Runtime available <span className="runtime-port">:{window.location.port || "4310"}</span></div>
          <button className="nav-item footer-nav" onClick={() => void logout()}><LogOut size={16} /> Sign out</button>
          <div className="user-row"><div className="avatar">{auth.email.slice(0, 1).toUpperCase()}</div><div className="user-info"><strong>{auth.email}</strong><span>Workspace admin</span></div><Settings2 size={16} className="user-settings" /></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{selected ? selected.name : view === "providers" ? "Provider catalog" : view === "projects" ? "Projects" : "Mock environments"}</strong></div>
          <div className="topbar-actions"><div className="runtime-pill"><span className="runtime-dot" /> Runtime healthy</div><button className="help-button" aria-label="Help"><CircleHelp size={17} /></button><button className="avatar top-avatar" aria-label="Account menu">{auth.email.slice(0, 1).toUpperCase()}</button></div>
        </header>

        <div className="content-wrap">
          {selected ? <EnvironmentDetail
            environment={selected} busy={busyId === selected.id} onBack={() => setSelectedId(null)}
            onDeploy={() => void deploy(selected)} onStop={() => void stop(selected)} onDelete={() => void deleteEnvironment(selected)}
            onAddRoute={() => setModal("route")} onDeleteRoute={deleteRoute} onSaveDocument={saveDocument}
          /> : view === "providers" ? <ProviderCatalog templates={templates} onCreate={(template) => { setModal("create"); setCreateTemplate(template.id); }} /> : view === "projects" ? <ProjectsPage projects={projects} onCreate={() => setModal("project")} onRotate={(project) => void rotateProjectToken(project)} onRefresh={() => void loadData()} /> : <>
            <section className="page-heading">
              <div><div className="eyebrow"><span className="eyebrow-line" /> DEVELOPMENT WORKSPACE</div><h1>Mock environments</h1><p>Stable API endpoints for development, integration tests, and demos.</p></div>
              <button className="button primary" onClick={() => { setCreateTemplate(""); setModal("create"); }}><Plus size={16} /> New mock API</button>
            </section>
            <section className="stat-grid" aria-label="Workspace overview">
              <Stat label="Environments" value={String(environments.length).padStart(2, "0")} detail="Saved in this workspace" icon={<Database size={17} />} />
              <Stat label="Deployed" value={String(runningCount).padStart(2, "0")} detail={runningCount ? "Serving requests now" : "No active runtimes"} icon={<Radio size={17} />} tone="green" />
              <Stat label="Routes" value={String(totalRoutes).padStart(2, "0")} detail="Across all environments" icon={<Activity size={17} />} />
              <Stat label="Provider templates" value={String(templates.length).padStart(2, "0")} detail="Ready to add" icon={<Box size={17} />} />
            </section>
            <section className="panel service-panel">
              <div className="panel-heading"><div><h2>Mock APIs</h2><p>Deploy an environment to start serving requests at its stable URL.</p></div><div className="panel-actions"><label className="search-box"><Search size={15} /><input aria-label="Search environments" placeholder="Find an environment" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘ K</kbd></label><button className="button secondary small" onClick={() => void loadData()} aria-label="Refresh environments"><RefreshCw size={14} /> Refresh</button></div></div>
              {filtered.length ? <EnvironmentTable environments={filtered} onOpen={(item) => setSelectedId(item.id)} onDeploy={deploy} onStop={stop} busyId={busyId} /> : <EmptyState query={query} onCreate={() => { setCreateTemplate(""); setModal("create"); }} />}
              <div className="table-foot"><span>Showing {filtered.length} of {environments.length} environments</span><a href="#providers" onClick={(event) => { event.preventDefault(); setView("providers"); }}>Browse provider templates <ArrowUpRight size={13} /></a></div>
            </section>
            <div className="bottom-grid">
              <section className="quickstart panel"><div className="quickstart-icon"><SquareTerminal size={19} /></div><div><div className="panel-kicker">QUICK START</div><h3>Connect a project</h3><p>Create a project token, add a <code>mock-server.config.json</code> file, then run the CLI from your project directory.</p><button className="text-button" onClick={() => setView("projects")}>View project setup <ArrowUpRight size={14} /></button></div></section>
              <section className="runtime-card panel"><div className="runtime-card-head"><div><div className="panel-kicker">RUNTIME</div><h3>Mockoon engine</h3></div><span className="health-badge"><span className="runtime-dot" /> Healthy</span></div><div className="runtime-detail"><span>Control plane</span><code>{window.location.host}</code></div><div className="runtime-detail"><span>Hosted APIs</span><code>*.{window.location.host.split(":")[0]}</code></div></section>
            </div>
          </>}
          <footer className="page-footer"><span>Mock Server <span className="footer-sep">·</span> API workspace</span><span>Mockoon runtime <span className="footer-sep">·</span> Local development</span></footer>
        </div>
      </main>
      {modal === "create" && <CreateModal templates={templates} initialTemplate={createTemplate} onClose={() => setModal(null)} onCreate={createEnvironment} />}
      {modal === "route" && selected && <RouteModal onClose={() => setModal(null)} onAdd={addRoute} />}
      {modal === "project" && <ProjectModal onClose={() => setModal(null)} onCreate={createProject} />}
      {projectCredential && <ProjectCredentialModal credential={projectCredential} onClose={() => setProjectCredential(null)} />}
      {notice && <div className={`toast ${notice.type}`} role="status"><span className="toast-icon">{notice.type === "success" ? <Check size={16} /> : <X size={16} />}</span>{notice.text}</div>}
    </div>
  );
}

function Login({ email, onSuccess }: { email: string; onSuccess: () => void }) {
  const [address, setAddress] = useState(email);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: address, password }) }); onSuccess(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : "Sign in failed."); }
    finally { setBusy(false); }
  }
  return <main className="login-shell"><div className="login-card"><div className="login-brand"><div className="brand-mark"><span>M</span></div><div><strong>mock server</strong><small>API workspace</small></div></div><div className="login-copy"><div className="eyebrow"><span className="eyebrow-line" /> PRIVATE WORKSPACE</div><h1>Sign in to your mocks.</h1><p>Manage provider environments, routes, and stable API URLs from one place.</p></div><form onSubmit={submit} className="login-form"><label>Email address<input type="email" autoComplete="username" required value={address} onChange={(event) => setAddress(event.target.value)} /></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <div className="field-error" role="alert">{error}</div>}<button className="button primary full" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />} Sign in <ArrowUpRight size={15} /></button></form><div className="login-hint"><ShieldCheck size={15} /><span>For local setup, use the admin credentials in your <code>.env</code> file.</span></div></div><div className="login-foot">Mock Server <span>·</span> Private developer workspace</div></main>;
}

function Stat({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: React.ReactNode; tone?: string }) {
  return <div className="stat-card"><div className={`stat-icon ${tone ?? ""}`}>{icon}</div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-detail">{detail}</div></div>;
}

function EnvironmentTable({ environments, onOpen, onDeploy, onStop, busyId }: { environments: Environment[]; onOpen: (value: Environment) => void; onDeploy: (value: Environment) => void; onStop: (value: Environment) => void; busyId: string | null }) {
  return <div className="table-scroll"><table className="environment-table"><thead><tr><th>Environment</th><th>Provider</th><th>Routes</th><th>Endpoint URL</th><th>Status</th><th aria-label="Actions" /></tr></thead><tbody>
    {environments.map((environment) => <tr key={environment.id}>
      <td><button className="env-title-cell" onClick={() => onOpen(environment)}><span className="env-symbol"><Globe2 size={17} /></span><span><strong>{environment.name}</strong><small>{environment.slug}</small></span></button></td>
      <td><span className="provider-name">{environment.provider}</span></td><td><span className="route-count">{String(routeCount(environment)).padStart(2, "0")}</span></td>
      <td><div className="endpoint-cell"><a className="endpoint-url" href={environment.url} target="_blank" rel="noreferrer">{environment.url.replace(/^https?:\/\//, "")}</a><button className="copy-mini" aria-label={`Copy ${environment.name} URL`} title="Copy URL" onClick={() => void navigator.clipboard.writeText(environment.url)}><Copy size={13} /></button></div></td>
      <td><span className={`status-pill ${environment.status}`}><span className="status-mark" />{environment.status === "running" ? "Live" : environment.status === "error" ? "Error" : "Stopped"}</span></td>
      <td><div className="row-actions">{environment.projectId ? <span className="managed-label">CLI managed</span> : environment.status === "running" ? <button className="text-button stop-action" disabled={busyId === environment.id} onClick={() => onStop(environment)}>{busyId === environment.id ? <LoaderCircle size={14} className="spin" /> : <span className="stop-square" />} Stop</button> : <button className="text-button deploy-action" disabled={busyId === environment.id} onClick={() => onDeploy(environment)}>{busyId === environment.id ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />} Deploy</button>}<button className="icon-button row-open" aria-label={`Open ${environment.name}`} onClick={() => onOpen(environment)}><ArrowUpRight size={15} /></button></div></td>
    </tr>)}
  </tbody></table></div>;
}

function EmptyState({ query, onCreate }: { query: string; onCreate: () => void }) {
  return <div className="empty-state"><div className="empty-icon"><Server size={21} /></div><h3>{query ? "No environments match" : "Start with a provider template"}</h3><p>{query ? "Try another name or provider." : "Create a mock API and get a stable URL for your app."}</p>{!query && <button className="button secondary" onClick={onCreate}><Plus size={15} /> Create an environment</button>}</div>;
}

function ProviderCatalog({ templates, onCreate }: { templates: Template[]; onCreate: (template: Template) => void }) {
  const groups = ["AI APIs", "Marketing integrations"];
  const aiProviders = new Set(["OpenAI", "Anthropic"]);
  return <>
    <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> PROVIDER STARTERS</div><h1>Provider catalog</h1><p>Start from a tested environment, then adjust routes and responses for your app.</p></div></section>
    {groups.map((group) => {
      const items = templates.filter((template) => group === "AI APIs" ? aiProviders.has(template.provider) : !aiProviders.has(template.provider));
      return <section className="provider-section" key={group}><div className="section-title"><h2>{group}</h2><span>{items.length} templates</span></div><div className="provider-grid">{items.map((template) => <article key={template.id} className="provider-card"><div className={`provider-icon provider-${template.id}`}><Code2 size={18} /></div><div className="provider-card-info"><h3>{template.name}</h3><p>{template.description}</p></div><div className="provider-meta"><span><FileJson2 size={13} /> {template.routeCount} routes</span><span><ShieldCheck size={13} /> Auth examples</span></div><button className="button secondary small full" onClick={() => onCreate(template)}><Plus size={14} /> Create environment</button></article>)}</div></section>;
    })}
    <div className="catalog-note"><CircleHelp size={16} /><span>Each starter is a normal Mockoon environment. You can edit routes, rules, response bodies, latency, and headers after creating it.</span></div>
  </>;
}

function ProjectsPage({ projects, onCreate, onRotate, onRefresh }: { projects: Project[]; onCreate: () => void; onRotate: (project: Project) => void; onRefresh: () => void }) {
  return <>
    <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> PROJECT RUNNERS</div><h1>Projects</h1><p>Start a project from its config file. Its API URLs accept requests while the CLI is connected.</p></div><button className="button primary" onClick={onCreate}><Plus size={16} /> Connect project</button></section>
    <section className="stat-grid project-stat-grid" aria-label="Project overview">
      <Stat label="Projects" value={String(projects.length).padStart(2, "0")} detail="Configured in this workspace" icon={<FolderGit2 size={17} />} />
      <Stat label="Active" value={String(projects.filter((project) => project.status === "active").length).padStart(2, "0")} detail="CLI connected and ready" icon={<Radio size={17} />} tone="green" />
      <Stat label="Hosted URLs" value={String(projects.reduce((sum, project) => sum + project.environments.length, 0)).padStart(2, "0")} detail="Across connected projects" icon={<Globe2 size={17} />} />
      <Stat label="Command" value="CLI" detail="Run from a project directory" icon={<SquareTerminal size={17} />} />
    </section>
    <section className="panel project-panel">
      <div className="panel-heading"><div><h2>Connected projects</h2><p>Active status follows the project runner heartbeat.</p></div><button className="button secondary small" onClick={onRefresh}><RefreshCw size={14} /> Refresh</button></div>
      {projects.length ? <div className="project-list">{projects.map((project) => <article className="project-row" key={project.id}>
        <div className="project-main"><span className={`project-icon ${project.status}`}><FolderGit2 size={18} /></span><div><h3>{project.name}</h3><p><code>{project.slug}</code> · {project.environments.length} hosted {project.environments.length === 1 ? "URL" : "URLs"}</p></div></div>
        <div className="project-actions"><span className={`status-pill ${project.status === "active" ? "running" : "stopped"}`}><span className="status-mark" />{project.status === "active" ? "Active · ready" : "Waiting for CLI"}</span><button className="button secondary small" onClick={() => onRotate(project)}><KeyRound size={13} /> Rotate token</button></div>
        <div className="project-endpoints">{project.environments.length ? project.environments.map((environment) => <a key={environment.id} href={environment.url} target="_blank" rel="noreferrer"><span>{environment.name}</span><code>{environment.url.replace(/^https?:\/\//, "")}</code><ArrowUpRight size={13} /></a>) : <p>URLs will appear after the CLI starts.</p>}</div>
      </article>)}</div> : <div className="empty-state"><div className="empty-icon"><FolderGit2 size={21} /></div><h3>Connect a project</h3><p>Create a project token, add the config file to your project, then start the CLI to register its URLs.</p><button className="button secondary" onClick={onCreate}><Plus size={15} /> Connect a project</button></div>}
      <div className="project-panel-foot"><span>Project URLs become unavailable if its CLI stops sending heartbeats.</span><code>mock-server start --project .</code></div>
    </section>
  </>;
}

function EnvironmentDetail({ environment, busy, onBack, onDeploy, onStop, onDelete, onAddRoute, onDeleteRoute, onSaveDocument }: {
  environment: Environment; busy: boolean; onBack: () => void; onDeploy: () => void; onStop: () => void; onDelete: () => void;
  onAddRoute: () => void; onDeleteRoute: (route: MockRoute) => void; onSaveDocument: (data: EnvironmentData) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (environment.data) setDraft(JSON.stringify(environment.data, null, 2)); }, [environment.id, environment.data]);
  const routes = environment.data?.routes ?? [];
  async function copyUrl() {
    await navigator.clipboard.writeText(environment.url); setCopied(true); window.setTimeout(() => setCopied(false), 1400);
  }
  function saveAdvanced() {
    try { onSaveDocument(JSON.parse(draft)); }
    catch { window.alert("Check the JSON syntax and try again."); }
  }
  return <>
    <div className="detail-back"><button className="back-button" onClick={onBack}><ArrowLeft size={15} /> All environments</button><span className="breadcrumb-slash">/</span><span>{environment.provider}</span></div>
    <section className="detail-heading"><div><div className="detail-title-row"><span className="env-symbol large"><Globe2 size={19} /></span><div><div className="eyebrow"><span className="eyebrow-line" /> {environment.provider.toUpperCase()}</div><h1>{environment.name}</h1></div></div><p className="detail-subtitle">Edit routes and deploy this environment to your workspace.</p></div><div className="detail-actions"><button className="button danger-quiet" onClick={onDelete}><Trash2 size={15} /> Delete</button>{environment.status === "running" ? <button className="button secondary" onClick={onStop} disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <span className="stop-square" />} Stop</button> : <button className="button primary" onClick={onDeploy} disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Zap size={15} />} Deploy mock</button>}</div></section>
    <section className="endpoint-banner"><div className="endpoint-banner-icon"><Globe2 size={17} /></div><div className="endpoint-banner-main"><span>BASE URL</span><code>{environment.url}</code></div><span className={`status-pill ${environment.status}`}><span className="status-mark" />{environment.status === "running" ? "Live" : environment.status === "error" ? "Error" : "Stopped"}</span><button className="button secondary small" onClick={() => void copyUrl()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy URL"}</button><a className="icon-button endpoint-open" href={environment.url} target="_blank" rel="noreferrer" aria-label="Open mock API"><ExternalLink size={15} /></a></section>
    <section className="panel route-panel"><div className="panel-heading route-heading"><div><h2>Routes</h2><p>{routes.length} endpoints configured in this environment</p></div><div className="route-heading-actions"><button className="button secondary small" onClick={() => setAdvanced((value) => !value)}><FileJson2 size={14} /> {advanced ? "Hide JSON" : "Edit JSON"}</button><button className="button primary small" onClick={onAddRoute}><Plus size={14} /> Add route</button></div></div>
      {advanced ? <div className="json-editor"><div className="json-editor-head"><span><Code2 size={14} /> Mockoon environment document</span><button className="button primary small" onClick={saveAdvanced}>Save document</button></div><textarea aria-label="Mockoon environment JSON" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} /></div> : routes.length ? <div className="route-list"><div className="route-list-head"><span>METHOD</span><span>PATH</span><span>DEFAULT RESPONSE</span><span>LATENCY</span><span /></div>{routes.map((route) => {
        const defaultResponse = route.responses?.find((response) => response.default) ?? route.responses?.[0];
        return <div className="route-row" key={route.uuid}><span className={`method-badge ${methodColor(route.method)}`}>{route.method.toUpperCase()}</span><code className="route-path">/{route.endpoint}</code><span className={`response-code ${defaultResponse?.statusCode && defaultResponse.statusCode >= 400 ? "failed" : ""}`}>{defaultResponse?.statusCode ?? "—"}</span><span className="route-latency">{defaultResponse?.latency ?? 0} ms</span><button className="icon-button route-delete" aria-label={`Delete ${route.method} ${route.endpoint}`} onClick={() => onDeleteRoute(route)}><Trash2 size={14} /></button></div>;
      })}</div> : <div className="empty-routes"><p>No routes yet. Add an endpoint to this environment.</p><button className="button secondary small" onClick={onAddRoute}><Plus size={14} /> Add first route</button></div>}
      <div className="route-panel-foot"><span><ShieldCheck size={14} /> Requests are served by an isolated Mockoon runtime.</span><button className="text-button" onClick={() => setAdvanced(true)}>Advanced configuration <ArrowUpRight size={14} /></button></div>
    </section>
    <div className="detail-lower-grid"><section className="panel usage-panel"><div className="panel-kicker">CONNECT YOUR APP</div><h3>Use this environment</h3><p>Set this as the provider’s API base URL in your project environment.</p><pre><code><span className="code-string">{environment.url}</span></code></pre></section><section className="panel info-panel"><div className="panel-kicker">ENVIRONMENT INFO</div><div className="info-row"><span>Provider</span><strong>{environment.provider}</strong></div><div className="info-row"><span>Environment ID</span><code>{environment.id.slice(0, 12)}</code></div><div className="info-row"><span>Routes</span><strong>{routes.length}</strong></div></section></div>
  </>;
}

function CreateModal({ templates, initialTemplate, onClose, onCreate }: { templates: Template[]; initialTemplate: string; onClose: () => void; onCreate: (name: string, templateId: string) => void }) {
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(initialTemplate || templates[0]?.id || "");
  const [error, setError] = useState("");
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !templateId) { setError("Enter an environment name and choose a provider."); return; }
    onCreate(name.trim(), templateId);
  }
  return <Modal title="Create mock environment" onClose={onClose}><form className="modal-form" onSubmit={submit}><p className="modal-description">Start from a provider template. You can update routes and responses after creation.</p><label>Environment name<input autoFocus required maxLength={64} placeholder="e.g. OpenAI staging" value={name} onChange={(event) => setName(event.target.value)} /></label><label>Provider template<select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{templates.map((template) => <option value={template.id} key={template.id}>{template.name} · {template.routeCount} routes</option>)}</select></label>{error && <div className="field-error" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary"><Plus size={15} /> Create environment</button></div></form></Modal>;
}

function ProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim().length < 2) { setError("Enter a project name with at least two characters."); return; }
    onCreate(name.trim());
  }
  return <Modal title="Connect a project" onClose={onClose}><form className="modal-form" onSubmit={submit}><p className="modal-description">Create a scoped CLI token for one project. The token will be shown once, then the CLI reads the project config and registers its hosted URLs.</p><label>Project name<input autoFocus required maxLength={64} placeholder="e.g. marketing-app" value={name} onChange={(event) => setName(event.target.value)} /></label>{error && <div className="field-error" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary"><FolderGit2 size={15} /> Create project token</button></div></form></Modal>;
}

function ProjectCredentialModal({ credential, onClose }: { credential: ProjectCredential; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(credential.token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return <Modal title={`${credential.project.name} token`} onClose={onClose}><div className="project-token-content"><p className="modal-description">Save this token in your shell or secret manager. It will not be shown again.</p><label>Project token<div className="token-value"><code>{credential.token}</code><button className="button secondary small" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button></div></label><div className="token-note"><ShieldCheck size={15} /><span>Keep the token out of source control. Set <code>MOCK_SERVER_TOKEN</code> before running the CLI.</span></div><div className="modal-actions"><button className="button primary" onClick={onClose}>Done</button></div></div></Modal>;
}

function RouteModal({ onClose, onAdd }: { onClose: () => void; onAdd: (input: { method: string; path: string; statusCode: number; body: string; headers: Record<string, string>; latency: number }) => void }) {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("");
  const [statusCode, setStatusCode] = useState(200);
  const [body, setBody] = useState('{\n  "ok": true\n}');
  const [headers, setHeaders] = useState('{\n  "Content-Type": "application/json"\n}');
  const [latency, setLatency] = useState(0);
  const [error, setError] = useState("");
  function submit(event: React.FormEvent) {
    event.preventDefault();
    let parsedHeaders: unknown;
    try { parsedHeaders = JSON.parse(headers); } catch { setError("Response headers must be a valid JSON object."); return; }
    if (!parsedHeaders || typeof parsedHeaders !== "object" || Array.isArray(parsedHeaders) || Object.values(parsedHeaders).some((value) => typeof value !== "string")) {
      setError("Response headers must be an object with text values."); return;
    }
    if (!path.trim()) { setError("Add a path such as /v1/models."); return; }
    onAdd({ method, path, statusCode: Number(statusCode), body, headers: parsedHeaders as Record<string, string>, latency: Number(latency) });
  }
  return <Modal title="Add route" onClose={onClose}><form className="modal-form route-form" onSubmit={submit}><p className="modal-description">Define the request and the response your app should receive.</p><div className="field-row"><label>Method<select value={method} onChange={(event) => setMethod(event.target.value)}>{["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].map((value) => <option key={value}>{value}</option>)}</select></label><label>Path<input autoFocus placeholder="/v1/models" value={path} onChange={(event) => setPath(event.target.value)} /></label></div><div className="field-row"><label>Status code<input type="number" min={100} max={599} value={statusCode} onChange={(event) => setStatusCode(Number(event.target.value))} /></label><label>Delay (ms)<input type="number" min={0} max={10000} value={latency} onChange={(event) => setLatency(Number(event.target.value))} /></label></div><label>Response headers <span className="field-hint">JSON object with text values</span><textarea className="body-input header-input" spellCheck={false} value={headers} onChange={(event) => setHeaders(event.target.value)} /></label><label>Response body<textarea className="body-input" spellCheck={false} value={body} onChange={(event) => setBody(event.target.value)} /></label>{error && <div className="field-error" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary"><Plus size={15} /> Add route</button></div></form></Modal>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={17} /></button></header>{children}</section></div>;
}
