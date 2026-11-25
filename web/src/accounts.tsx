import { useEffect, useState } from 'react';
import { api } from './api';
import type { ProjectState } from './api';
import { useAction } from './ui';
import { copy } from './share';
import { when } from './time';
import { tokensText } from './usage';

/**
 * Setup › Claude accounts (server/accounts.ts): every account with its state and this week's tokens, adding an extra
 * one (signed in from a terminal with the command shown), and this project's primary and ordered fallbacks.
 */

type Account = {
  name: string;
  main: boolean;
  command: string | null;
  signedIn: boolean;
  limitedUntil: number | null;
  tokensWeek: number;
  primaryOf: { id: string; name: string }[];
  fallbackOf: { id: string; name: string }[];
};
type Accounts = { accounts: Account[] };
type ProjectAccounts = { primary: string; fallbacks: string[]; current: string };

const label = (a: { name: string; main?: boolean }) => (a.main || a.name === 'main' ? 'Main account' : a.name);

function AccountState({ a }: { a: Account }) {
  const st = !a.signedIn ? { text: 'Not signed in', cls: 'hs-login' } : a.limitedUntil ? { text: `Limited until ${when(a.limitedUntil)}`, cls: 'hs-offline' } : { text: 'OK', cls: 'hs-online' };
  return (
    <span className={`host-state ${st.cls}`}>
      <span className="status-dot" />
      {st.text}
    </span>
  );
}

function SignInCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="account-signin">
      <span className="muted small">Run this in a terminal on Helm's machine, then type /login:</span>
      <div className="row">
        <code className="grow">{command}</code>
        <button
          className="btn small quiet"
          onClick={async () => {
            if (await copy(command)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/** System › Accounts: every account with its state and week's tokens, adding one with its sign-in command, removing one. */
export function AccountsList() {
  const [data, setData] = useState<Accounts | null>(null);
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  const load = () => api<Accounts>('/api/accounts').then(setData, () => {});
  // Every minute: a limit is set and cleared by the agents' runner.
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!data) return null;
  const usedBy = (a: Account) => [a.primaryOf.length ? `primary of ${a.primaryOf.map((p) => p.name).join(', ')}` : '', a.fallbackOf.length ? `fallback of ${a.fallbackOf.map((p) => p.name).join(', ')}` : ''].filter(Boolean).join(' · ');
  return (
    <>
      <div className="card">
        <ul className="setup-hosts">
          {data.accounts.map((a) => (
            <li key={a.name} className="row wrap account-row">
              <span className="grow">
                <strong>{label(a)}</strong>
                <span className="muted small">{[tokensText(a.tokensWeek) ? `${tokensText(a.tokensWeek)} this week` : 'No use this week', usedBy(a)].filter(Boolean).join(' · ')}</span>
              </span>
              <AccountState a={a} />
              {!a.main && (
                <button
                  className="btn small quiet"
                  disabled={busy}
                  onClick={() => confirm(`Remove the ${a.name} account? Projects on it go back to the main account.`) && run(async () => {
                      await api(`/api/accounts/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
                      load();
                    })}
                >
                  Remove
                </button>
              )}
              {!a.signedIn && a.command && <SignInCommand command={a.command} />}
            </li>
          ))}
        </ul>
        <form
          className="row wrap setup-hosts-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void run(async () => setData(await api<Accounts>('/api/accounts', { body: { name: name.trim() } }))).then((ok) => ok && setName(''));
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New account name" aria-label="New account name" autoCapitalize="none" />
          <button className="btn" disabled={busy || !name.trim()}>
            Add
          </button>
        </form>
      </div>

      {error && <p className="error-text">{error}</p>}
    </>
  );
}

export function AccountsSetup({ s }: { s: ProjectState }) {
  const pid = s.project.id;
  const [data, setData] = useState<Accounts | null>(null);
  const [mine, setMine] = useState<ProjectAccounts | null>(null);
  const [pick, setPick] = useState('');
  const { busy, error, run } = useAction();

  const load = () => {
    api<Accounts>('/api/accounts').then(setData, () => {});
    api<ProjectAccounts>(`/api/projects/${pid}/accounts`).then(setMine, () => {});
  };
  // Again when the project changes, and every minute: a limit is set and cleared by the agents' runner.
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [pid, s.project.updated_at]);
  if (!data || !mine) return null;

  const save = (body: Partial<ProjectAccounts>) => run(async () => setMine(await api<ProjectAccounts>(`/api/projects/${pid}/accounts`, { method: 'PUT', body })));
  const others = data.accounts.filter((a) => a.name !== mine.primary && !mine.fallbacks.includes(a.name));
  const move = (i: number) => {
    const f = [...mine.fallbacks];
    [f[i - 1], f[i]] = [f[i], f[i - 1]];
    return save({ fallbacks: f });
  };
  return (
    <>
      <h2 id="accounts">Claude account</h2>
      <div className="card form account-project">
        <label>
          This project's account
          <select value={mine.primary} disabled={busy} onChange={(e) => save({ primary: e.target.value })}>
            {data.accounts.map((a) => (
              <option key={a.name} value={a.name}>
                {label(a)}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">At its usage limit, the project moves to these in order, and back once it resets:</span>
        {mine.fallbacks.length ? (
          <ol className="account-fallbacks">
            {mine.fallbacks.map((f, i) => (
              <li key={f} className="row">
                <span className="grow">{label({ name: f })}</span>
                {i > 0 && (
                  <button className="btn small quiet" disabled={busy} onClick={() => move(i)} aria-label={`Move ${f} up`}>
                    Up
                  </button>
                )}
                <button className="btn small quiet" disabled={busy} onClick={() => save({ fallbacks: mine.fallbacks.filter((x) => x !== f) })}>
                  Remove
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <span className="small">No fallback: the project waits for the reset.</span>
        )}
        {others.length > 0 && (
          <select value={pick} disabled={busy} aria-label="Add a fallback" onChange={(e) => e.target.value && void save({ fallbacks: [...mine.fallbacks, e.target.value] }).then(() => setPick(''))}>
            <option value="">Add a fallback…</option>
            {others.map((a) => (
              <option key={a.name} value={a.name}>
                {label(a)}
              </option>
            ))}
          </select>
        )}
        {mine.current !== mine.primary && <p className="small">Running on {label({ name: mine.current })} now, while {label({ name: mine.primary })} is limited.</p>}
        {error && <p className="error-text">{error}</p>}
        <a className="small" href="#/system/accounts">Add or remove accounts in System</a>
      </div>
    </>
  );
}
