/**
 * Which half of Helm this process is (server/runner.ts): 'all' (one process), 'runner' (the agents and every timer)
 * or 'web' (the dashboard). Kept apart from runner.ts so modules with process-local state can check it without
 * importing the runner link.
 */
export type Role = 'all' | 'runner' | 'web';

let role: Role = 'all';
export const processRole = () => role;
export function setProcessRole(r: Role) {
  role = r;
}

/**
 * State that lives only in the process that runs agents: the permission waiters and the director's notices and outbox
 * (triage.ts), the push groups (notify.ts), the live sessions (runtime.ts). Reached from the web service it would act
 * on an empty copy and silently do nothing; such a call is a bug. Under test (NODE_ENV=test, as the checks and scratch
 * servers run) it throws, so a check that drives the API in split mode finds it; in production it is logged.
 */
export function runnerOnly(what: string) {
  if (role !== 'web') return;
  const message = `runner-only: ${what} was reached in the web service, where it has no effect (server/role.ts)`;
  if (process.env.NODE_ENV === 'test') throw new Error(message);
  console.error(new Error(message).stack);
}
