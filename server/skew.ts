/**
 * The web service may run a newer build than the runner (server/runner.ts): an update that leaves the runner's code
 * alone (its hash, server/closure.ts) restarts only the dashboard, and repeated ones can leave the runner many builds
 * behind. That is safe only while both read and write the shared tables the same way.
 *
 * Bump SKEW_EPOCH in any change to what a shared table or column means, or to how the dashboard writes rows the runner
 * reads (or the other way round). This file is in the runner's closure, so the bump changes the runner's hash and the
 * update restarts the runner too. Example: the nested Spec sections (6f9eff6) changed how section rows are parented;
 * the API (web side) writes them and tools the runner serves read them, so a dashboard on the new layout beside a runner
 * on the old one would have shown agents a flattened, wrong Spec until the runner restarted.
 */
export const SKEW_EPOCH = 5;
