import { Marked } from 'marked';
import type { Token } from 'marked';
import { esc, refsToHtml } from './refs.ts';
import type { ChipEnv } from './refs.ts';

// Agent and user text to HTML, with references ([[id]], bare ids) as chips. Code spans, code blocks and links
// keep their text as written: the lexer never makes text tokens inside code, and walkTokens marks everything inside
// a link so a chip is never nested in another link. Pure (no DOM), so refs.test.ts runs it under Node; the caller
// sanitises the result.

let env: ChipEnv | null = null;

const quiet = (t: Token) => {
  (t as any).noRefs = true;
  for (const c of (t as any).tokens ?? []) quiet(c);
};

const md = new Marked({
  async: false,
  breaks: true,
  gfm: true,
  walkTokens(t) {
    if (t.type === 'link') for (const c of t.tokens ?? []) quiet(c);
  },
  renderer: {
    text(t) {
      if ('tokens' in t && t.tokens) return this.parser.parseInline(t.tokens);
      const html = 'escaped' in t && t.escaped ? t.text : esc(t.text);
      return env && !(t as any).noRefs ? refsToHtml(html, env) : html;
    },
  },
});

export function renderMarkdown(text: string, chips: ChipEnv | null): string {
  env = chips;
  try {
    return md.parse(text ?? '') as string;
  } finally {
    env = null;
  }
}
