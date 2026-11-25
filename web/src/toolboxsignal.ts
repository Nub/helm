/** The stream messages that change the Toolbox's counts (kept apart from toolbox.tsx so the page can load lazily). */
export const toolboxRefresh = (m: { type: string }) => m.type === 'toolbox' || m.type === 'projects' || m.type === 'reconnect';
