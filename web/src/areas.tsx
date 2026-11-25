import { useState } from "react";
import { api, useLive } from "./api";
import type { ProjectState } from "./api";

/**
 * Setup › Team (server: settings.ts builders_at_once and builder_subagents, tiers.ts): how many builders Helm runs at
 * once (one fresh builder per task, dispatch.ts), how many subagents each may run, and the four work tiers. The
 * settings are per project and the tiers install-wide; each is saved as soon as it changes.
 */

type Tier = { id: string; name: string; model: string; effort: string };
type TiersView = {
  tiers: Tier[];
  models: { id: string; label: string }[];
  efforts: string[];
  by_tier: Record<string, number>;
};
type Setting = { key: string; label: string; value: string | boolean; choices?: { value: string; label: string }[] };

const TEAM_KEYS = ["builders_at_once", "builder_subagents"];

export function AreasTeam({ s }: { s: ProjectState }) {
  const pid = s.project.id;
  const settings = useLive<{ groups: { settings: Setting[] }[] }>(
    `/api/projects/${pid}/settings?all=1`,
    (m) => m.type === "project" && m.projectId === pid,
  );
  const [error, setError] = useState("");
  const all = settings.data?.groups.flatMap((g) => g.settings) ?? [];
  const knobs = TEAM_KEYS.map((k) => all.find((x) => x.key === k)).filter(
    (x): x is Setting => !!x?.choices,
  );
  const set = (key: string, v: string) =>
    api(`/api/projects/${pid}/settings`, {
      method: "PATCH",
      body: { [key]: v },
    }).then(
      () => settings.reload(),
      (e) => setError(e.message),
    );
  return (
    <>
      <h2>Team</h2>
      <div className="card settings-card team-knobs">
        {knobs.map((k) => (
          <div key={k.key} className="setting-item">
            <label className="switch-row setting-choice">
              <span className="switch-text">{k.label}</span>
              <select
                value={String(k.value)}
                onChange={(e) => void set(k.key, e.target.value)}
              >
                {k.choices!.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
        {error && <p className="error-text small">{error}</p>}
      </div>

      <h2>Tiers</h2>
      <TiersCard />
    </>
  );
}

/** The four tiers, install-wide: model and effort, saved as soon as one is changed. */
function TiersCard() {
  const { data } = useLive<TiersView>(
    "/api/tiers",
    (m) => m.type === "projects",
  );
  const [error, setError] = useState("");
  const [local, setLocal] = useState<Record<string, Tier>>({});
  if (!data) return <div className="loading">Loading…</div>;
  const save = (t: Tier) => {
    setLocal((l) => ({ ...l, [t.id]: t }));
    setError("");
    api(`/api/tiers/${t.id}`, {
      method: "PUT",
      body: { model: t.model, effort: t.effort },
    }).catch((e) => {
      setError(e.message);
      setLocal((l) => {
        const { [t.id]: _, ...rest } = l;
        return rest;
      });
    });
  };
  return (
    <div className="card tiers">
      {data.tiers.map((t0) => {
        const t = local[t0.id] ?? t0;
        return (
          <div key={t.id} className="tier-row">
            <b>{t.name}</b>
            <select
              aria-label={`${t.name} model`}
              value={t.model}
              onChange={(e) => save({ ...t, model: e.target.value })}
            >
              {data.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <select
              aria-label={`${t.name} effort`}
              value={t.effort}
              onChange={(e) => save({ ...t, effort: e.target.value })}
            >
              {data.efforts.map((e) => (
                <option key={e} value={e}>
                  {e || "Default"}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      <p className="muted small">For every project.</p>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
