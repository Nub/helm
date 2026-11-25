// The Quieter system's rule for buttons and chips (task_5c39a0ebe5): they are styled only inside the shared block of
// web/src/styles.css (between "shared:start" and "shared:end"). Outside it, a rule whose subject is a button or a chip
// may only place it. Used by styles.test.ts; kept apart so a one-off fixer script can share the definition.

/** The shared pieces, and bespoke button/chip class names (any class ending in -btn, -chip, -tag, -badge or -pill). */
export const SHARED = ['btn', 'icon-btn', 'badge', 'tag', 'chip', 'chips', 'chip-count', 'chip-sep', 'media-label', 'mode-chip'];
export const isButtonOrChip = (cls: string) => SHARED.includes(cls) || /-(btn|chip|tag|badge|pill)$/.test(cls);

/** Properties that place an element without changing how it looks. */
export const LAYOUT = /^(margin(-[a-z-]+)?|flex(-[a-z]+)?|order|align-self|justify-self|place-self|align-items|align-content|justify-items|justify-content|place-items|place-content|gap|row-gap|column-gap|grid(-[a-z-]+)?|width|min-width|max-width|display|position|top|right|bottom|left|inset|z-index|visibility|overflow(-[xy])?|white-space|text-overflow|vertical-align|box-sizing|transform|pointer-events|content|cursor|text-align|contain|transition)$/;

export type Rule = { line: number; selector: string; decls: { prop: string; text: string }[]; start: number; end: number; inShared: boolean };

/** The subject (last compound) of each selector in a list names a button or chip class. */
export function subjectIsButtonOrChip(selector: string): boolean {
  return selector.split(',').some((s) => {
    const parts = s.trim().split(/\s*[\s>+~]\s*/);
    const subject = parts[parts.length - 1].replace(/::?[a-z-]+(\([^)]*\))?/g, '');
    return [...subject.matchAll(/\.([a-zA-Z0-9_-]+)/g)].some((m) => isButtonOrChip(m[1]));
  });
}

/** Every plain rule (innermost) with its declarations and place. */
export function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const blank = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const a = css.indexOf('shared:start');
  const b = css.indexOf('shared:end');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blank))) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (!selector || selector.startsWith('@')) continue;
    const selStart = m.index + m[1].length - m[1].trimStart().length;
    const decls = m[2].split(';').map((d) => d.trim()).filter(Boolean).map((text) => ({ prop: text.split(':')[0].trim(), text }));
    const line = blank.slice(0, selStart).split('\n').length;
    out.push({ line, selector, decls, start: selStart, end: m.index + m[0].length, inShared: a >= 0 && selStart > a && selStart < b });
  }
  return out;
}

/** Rules outside the shared block that style a button or chip beyond placing it. */
export function strays(css: string) {
  return rules(css)
    .filter((r) => !r.inShared && subjectIsButtonOrChip(r.selector))
    .map((r) => ({ ...r, visual: r.decls.filter((d) => !LAYOUT.test(d.prop)) }))
    .filter((r) => r.visual.length);
}
