// Settings page: server health + in-app restart + curated cartograph.env editor.
//
// Fetches /api/health (refreshed every 30s) and /api/config on mount. The
// config form tracks dirty fields and POSTs {updates, removals} on Save;
// clearing a field sends a removal so the key reverts to its default. The
// Restart button POSTs /api/server/restart then polls /api/health until the
// pid changes (server came back). A restart cannot escape a network sandbox,
// so a timeout shows the terminal fallback.
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { timeAgo } from '~/lib/time';

type FieldType = 'string' | 'bool' | 'int' | 'enum' | 'flags' | 'secret' | 'readonly';

interface ConfigKey {
  key: string;
  group: string;
  label: string;
  help: string;
  type: FieldType;
  default: string;
  applies: 'immediate' | 'restart';
  required?: boolean;
  choices?: string[];
  value: string;
  source: 'file' | 'env' | 'default';
}

interface ConfigPayload {
  groups: string[];
  keys: ConfigKey[];
  config_path: string;
}

interface HealthPayload {
  ok: boolean;
  server: {
    pid: number;
    ppid: number;
    uptime_seconds: number;
    started_at: string;
    reload: boolean;
    python: string;
    cwd: string;
  };
  github: {
    reachable: boolean;
    configured_user: string;
    authed_user: string | null;
    user_mismatch: boolean;
    error: string | null;
  };
  doctor: { status: 'OK' | 'FAIL'; problems: string[]; warnings: string[] };
}

function fmtUptime(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export default function SettingsPanel() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigPayload | null>(null);
  const [configErr, setConfigErr] = useState<string | null>(null);

  // key -> current (possibly edited) value; initial -> last-saved baseline.
  const [values, setValues] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});

  async function loadHealth() {
    try {
      const r = await fetch('/api/health');
      if (!r.ok) throw new Error(`/api/health → ${r.status}`);
      setHealth(await r.json());
      setHealthErr(null);
    } catch (e) {
      setHealthErr(String(e));
    }
  }

  async function loadConfig() {
    try {
      const r = await fetch('/api/config');
      if (!r.ok) throw new Error(`/api/config → ${r.status}`);
      const j = (await r.json()) as ConfigPayload;
      setConfig(j);
      const base: Record<string, string> = {};
      for (const k of j.keys) base[k.key] = k.value ?? '';
      setValues(base);
      setInitial(base);
      setConfigErr(null);
    } catch (e) {
      setConfigErr(String(e));
    }
  }

  useEffect(() => {
    loadHealth();
    loadConfig();
    const id = setInterval(loadHealth, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-6">
      <ServerCard health={health} err={healthErr} onRefresh={loadHealth} />
      <ConfigForms
        config={config}
        err={configErr}
        values={values}
        initial={initial}
        setValues={setValues}
        onSaved={loadConfig}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Server card

type RestartPhase = 'idle' | 'confirm' | 'restarting' | 'timeout';

function ServerCard({
  health,
  err,
  onRefresh,
}: {
  health: HealthPayload | null;
  err: string | null;
  onRefresh: () => void;
}) {
  const [phase, setPhase] = useState<RestartPhase>('idle');
  const [copied, setCopied] = useState(false);

  // Auto-disarm the confirm state after a few seconds.
  useEffect(() => {
    if (phase !== 'confirm') return;
    const t = setTimeout(() => setPhase('idle'), 4000);
    return () => clearTimeout(t);
  }, [phase]);

  async function doRestart() {
    const oldPid = health?.server.pid ?? null;
    setPhase('restarting');
    try {
      await fetch('/api/server/restart', { method: 'POST' });
    } catch {
      /* the server is being torn down — the request often won't cleanly return */
    }
    // Poll until a NEW pid appears (the relaunched process), up to ~30s.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        if (r.ok) {
          const j = (await r.json()) as HealthPayload;
          if (oldPid === null || j.server.pid !== oldPid) {
            setPhase('idle');
            onRefresh();
            return;
          }
        }
      } catch {
        /* still down — keep polling */
      }
    }
    setPhase('timeout');
  }

  const fallbackCmd = `kill ${health?.server.pid ?? '<pid>'}; just serve`;

  return (
    <section className="brutal-card">
      <header className="flex items-end justify-between gap-3 border-b-2 border-border px-5 py-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted leading-none mb-1">
            server
          </div>
          <h3 className="text-xl font-bold tracking-tight leading-tight">Health &amp; status</h3>
        </div>
        <button type="button" onClick={onRefresh} className="font-mono text-xs text-muted hover:text-fg">
          refresh
        </button>
      </header>

      <div className="p-5 space-y-5">
        {err && !health && (
          <div className="font-mono text-sm">
            <div className="text-danger font-bold">/api/health unreachable</div>
            <div className="text-muted mt-1 text-xs">{err}</div>
            <div className="text-muted mt-1">
              start it: <code>just serve</code>
            </div>
          </div>
        )}

        {health && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 font-mono text-xs">
              <Field label="pid" value={String(health.server.pid)} />
              <Field label="parent pid" value={String(health.server.ppid)} />
              <Field label="uptime" value={fmtUptime(health.server.uptime_seconds)} />
              <Field label="reload" value={health.server.reload ? 'on' : 'off'} />
              <Field label="started" value={timeAgo(health.server.started_at)} />
              <Field label="python" value={health.server.python} mono title={health.server.python} />
            </div>

            <GithubRow github={health.github} />
            <DoctorRow doctor={health.doctor} />

            <div className="border-t-2 border-border pt-4">
              {phase === 'timeout' ? (
                <div className="space-y-2">
                  <div className="font-mono text-xs text-danger font-bold">
                    server didn&apos;t come back within 30s
                  </div>
                  <div className="font-mono text-xs text-muted">
                    A restart can&apos;t escape a network sandbox. Run this in a terminal:
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="px-2 py-1 border-2 border-border bg-muted-bg font-mono text-xs">
                      {fallbackCmd}
                    </code>
                    <button
                      type="button"
                      className="font-mono text-xs text-accent hover:underline"
                      onClick={() => {
                        navigator.clipboard?.writeText(fallbackCmd);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                    >
                      {copied ? 'copied' : 'copy'}
                    </button>
                    <button type="button" className="font-mono text-xs text-muted hover:text-fg" onClick={() => setPhase('idle')}>
                      dismiss
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 flex-wrap">
                  {phase === 'restarting' ? (
                    <span className="brutal-button font-mono text-sm opacity-70 cursor-default">
                      restarting…
                    </span>
                  ) : phase === 'confirm' ? (
                    <button type="button" onClick={doRestart} className="brutal-button font-mono text-sm" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
                      click again to confirm restart
                    </button>
                  ) : (
                    <button type="button" onClick={() => setPhase('confirm')} className="brutal-button font-mono text-sm">
                      Restart server
                    </button>
                  )}
                  <span className="font-mono text-[11px] text-muted max-w-md">
                    Relaunches the process. Can&apos;t escape a network sandbox — restart from a terminal if it doesn&apos;t recover.
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Field({ label, value, mono, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5 p-2.5 border-2 border-border bg-muted-bg min-w-0">
      <span className="text-muted uppercase tracking-widest text-[10px]">{label}</span>
      <span className={`text-fg ${mono ? 'truncate' : ''}`} title={title}>{value}</span>
    </div>
  );
}

function GithubRow({ github }: { github: HealthPayload['github'] }) {
  const ok = github.reachable;
  return (
    <div
      className="p-3 border-2 border-border font-mono text-xs"
      style={{ background: `color-mix(in srgb, ${ok ? 'var(--ok)' : 'var(--danger)'} 12%, var(--bg))` }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span style={{ color: ok ? 'var(--ok)' : 'var(--danger)' }} className="font-bold">
          {ok ? '✓ GitHub reachable' : '✗ GitHub unreachable'}
        </span>
        {github.authed_user && <span className="text-muted">authed as <span className="text-fg">{github.authed_user}</span></span>}
        {github.configured_user && <span className="text-muted">· configured <span className="text-fg">{github.configured_user}</span></span>}
      </div>
      {github.user_mismatch && (
        <div className="mt-1" style={{ color: 'var(--warn)' }}>
          ! authed user differs from configured CARTOGRAPH_GITHUB_USER — PR queries may be empty.
        </div>
      )}
      {github.error && <div className="mt-1 text-muted">{github.error}</div>}
    </div>
  );
}

function DoctorRow({ doctor }: { doctor: HealthPayload['doctor'] }) {
  const ok = doctor.status === 'OK';
  const issues = [...doctor.problems, ...doctor.warnings];
  return (
    <div className="p-3 border-2 border-border font-mono text-xs" style={ok ? undefined : { borderColor: 'var(--danger)' }}>
      <div className="flex items-center gap-2">
        <span className="text-muted uppercase tracking-widest text-[10px]">doctor</span>
        <span className="font-bold" style={{ color: ok ? 'var(--ok)' : 'var(--danger)' }}>{doctor.status}</span>
        <span className="text-muted">{doctor.problems.length} problem · {doctor.warnings.length} warning</span>
      </div>
      {issues.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {doctor.problems.map((p) => (
            <li key={p}><span style={{ color: 'var(--danger)' }}>✗</span> {p}</li>
          ))}
          {doctor.warnings.map((w) => (
            <li key={w} className="text-muted"><span style={{ color: 'var(--warn)' }}>!</span> {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --------------------------------------------------------------- Config forms

function ConfigForms({
  config,
  err,
  values,
  initial,
  setValues,
  onSaved,
}: {
  config: ConfigPayload | null;
  err: string | null;
  values: Record<string, string>;
  initial: Record<string, string>;
  setValues: Dispatch<SetStateAction<Record<string, string>>>;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [restartNote, setRestartNote] = useState(false);

  if (err && !config) {
    return (
      <section className="brutal-card p-5 font-mono text-sm">
        <div className="text-danger font-bold">/api/config unreachable</div>
        <div className="text-muted mt-1 text-xs">{err}</div>
      </section>
    );
  }
  if (!config) return <p className="font-mono text-sm text-muted">loading settings…</p>;

  const byKey = new Map(config.keys.map((k) => [k.key, k]));
  const dirty = config.keys.filter((k) => k.type !== 'readonly' && (values[k.key] ?? '') !== (initial[k.key] ?? ''));
  // Block save if a required field was cleared.
  const requiredEmpty = dirty.filter((k) => k.required && (values[k.key] ?? '').trim() === '');

  async function save() {
    setSaving(true);
    setSaveErr(null);
    const updates: Record<string, string> = {};
    const removals: string[] = [];
    for (const k of dirty) {
      const v = (values[k.key] ?? '').trim();
      if (v === '') removals.push(k.key);
      else updates[k.key] = v;
    }
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates, removals }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.detail || `HTTP ${r.status}`);
      setRestartNote(Boolean(j.restart_required));
      onSaved();
    } catch (e) {
      setSaveErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {config.groups.map((group) => {
        const keys = config.keys.filter((k) => k.group === group);
        if (keys.length === 0) return null;
        return (
          <section key={group} className="brutal-card">
            <header className="border-b-2 border-border px-5 py-3">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted leading-none mb-1">settings</div>
              <h3 className="text-xl font-bold tracking-tight leading-tight">{group}</h3>
            </header>
            <div className="divide-y divide-[var(--border-soft)]">
              {keys.map((k) => (
                <Row
                  key={k.key}
                  field={k}
                  value={values[k.key] ?? ''}
                  changed={k.type !== 'readonly' && (values[k.key] ?? '') !== (initial[k.key] ?? '')}
                  onChange={(v) => setValues((prev) => ({ ...prev, [k.key]: v }))}
                />
              ))}
            </div>
          </section>
        );
      })}

      <div className="sticky bottom-0 brutal-card p-4 flex items-center gap-3 flex-wrap bg-bg">
        <button
          type="button"
          onClick={save}
          disabled={saving || dirty.length === 0 || requiredEmpty.length > 0}
          className="brutal-button font-mono text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'saving…' : `Save${dirty.length ? ` (${dirty.length})` : ''}`}
        </button>
        {dirty.length === 0 && <span className="font-mono text-xs text-muted">no unsaved changes</span>}
        {requiredEmpty.length > 0 && (
          <span className="font-mono text-xs text-danger">
            required field empty: {requiredEmpty.map((k) => byKey.get(k.key)?.label).join(', ')}
          </span>
        )}
        {saveErr && <span className="font-mono text-xs text-danger">{saveErr}</span>}
        {restartNote && (
          <span className="font-mono text-xs" style={{ color: 'var(--warn)' }}>
            saved — some changes apply after a server restart (see Health &amp; status above).
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted">writes to <code>{config.config_path}</code></span>
      </div>
    </>
  );
}

function Row({
  field,
  value,
  changed,
  onChange,
}: {
  field: ConfigKey;
  value: string;
  changed: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className={`px-5 py-3 grid grid-cols-1 md:grid-cols-[18rem_1fr] gap-2 md:gap-4 ${changed ? 'bg-[var(--surface-1)]' : ''}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <label htmlFor={field.key} className="font-mono text-xs font-bold text-fg">{field.label}</label>
          {field.applies === 'restart' && (
            <span className="font-mono text-[9px] uppercase tracking-widest px-1 py-0.5 border border-border text-muted">restart</span>
          )}
          {changed && <span className="font-mono text-[9px] text-accent">●</span>}
        </div>
        <p className="font-mono text-[10px] text-muted mt-0.5 leading-snug">{field.help}</p>
        <code className="font-mono text-[9px] text-muted">{field.key}</code>
      </div>
      <div className="min-w-0">
        <Input field={field} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function Input({ field, value, onChange }: { field: ConfigKey; value: string; onChange: (v: string) => void }) {
  const base = 'w-full font-mono text-xs px-2 py-1.5 border-2 border-border bg-bg text-fg focus:outline-none focus:border-accent';

  if (field.type === 'readonly') {
    return (
      <div className="flex items-center gap-2">
        <input className={`${base} opacity-70 cursor-not-allowed`} value={value} readOnly disabled title={value} />
        <span className="font-mono text-[9px] uppercase tracking-widest text-muted whitespace-nowrap">runtime</span>
      </div>
    );
  }
  if (field.type === 'bool') {
    const on = value === '1';
    return (
      <button
        type="button"
        onClick={() => onChange(on ? '0' : '1')}
        className={`font-mono text-xs px-3 py-1.5 border-2 ${on ? 'bg-accent text-[var(--accent-fg)] border-accent' : 'border-border text-muted'}`}
        aria-pressed={on}
      >
        {on ? 'on (1)' : 'off (0)'}
      </button>
    );
  }
  if (field.type === 'int') {
    return <input id={field.key} type="number" className={base} value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.default} />;
  }
  if (field.type === 'enum') {
    return (
      <select id={field.key} className={base} value={value} onChange={(e) => onChange(e.target.value)}>
        {(field.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    );
  }
  if (field.type === 'flags') {
    return (
      <textarea
        id={field.key}
        className={`${base} resize-y`}
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.default || 'built-in default'}
      />
    );
  }
  // string / secret
  return (
    <input
      id={field.key}
      type={field.type === 'secret' ? 'password' : 'text'}
      className={base}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.default}
    />
  );
}
