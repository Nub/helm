/**
 * Prose that says the user must do or decide something. A director that only writes "you need to add the source"
 * in a reply, a thread post or a status summary has filed nothing: requests reach the user under Needs response,
 * and prose does not. Helm uses this to notice such sentences (runtime.ts: a note back to the director; tasks.ts:
 * the "says it needs you, but nothing was filed" flag). Pure and conservative: a missed sentence costs nothing new,
 * a false one costs the director a turn, so each pattern names the user and an obligation or a wait, and
 * negations ("nothing needed from you") and offers ("say if you want") do not count. The table in
 * userasks.test.ts is the specification; add to it when changing a pattern.
 */

const ACT =
  '(?:run|add|approve|restart|reboot|press|click|tap|merge|install|plug|connect|confirm|choose|pick|decide|review|test|try|play|send|upload|attach|set|enable|disable|open|update|sign|log ?in|grant|create|copy|paste|check|flash|power|unplug|switch|move|delete|remove|rename|share|export|answer|reply|accept|pair|enter|type|paste|configure|start|stop|pay|buy|order|register|verify|look at)';

/** Each: what it catches, in a comment. Case-insensitive; matched against one sentence at a time. */
const PATTERNS: RegExp[] = [
  // "it's waiting on you", "blocked on the user", "waits for your play test"
  /\b(?:waiting|waits|wait|blocked|stuck|held up|depends|depending)\s+(?:on|for)\s+(?:you|the user)\b/i,
  /\b(?:waiting|waits|wait|blocked|depends)\s+(?:on|for)\s+your\s+(?:\w+\s+)?(?:play ?test|review|approval|go-ahead|go ahead|decision|answer|input|ok|okay|sign-off|confirmation|reply|test|choice|check)\b/i,
  // "needed from you", "Needs from you:", "what I need from you", "need you to"
  /\b(?:need|needs|needed|required)\s+(?:from|of)\s+(?:you|the user)\b/i,
  /\bneed(?:s)?\s+(?:you|the user)\s+to\b/i,
  // "needs your approval", "needs your go-ahead"
  /\bneeds?\s+your\s+(?:\w+\s+)?(?:approval|approve|go-ahead|go ahead|decision|answer|input|ok|okay|sign-off|confirmation|review|play ?test|choice)\b/i,
  // "you need to", "you'll need to", "you will have to", "you must", "the user needs to"
  /\b(?:you|the user)(?:'ll| will| would| still| also| first)?\s+(?:need|needs|have|has)\s+to\s+(?:\w+\s+){0,2}?\w/i,
  /\b(?:you|the user)\s+must\b/i,
  /\b(?:you|the user)\s+should\s+(?:now\s+|first\s+)?(?:\w+\s+)?\b(?:run|add|approve|restart|reboot|press|merge|install|plug|connect|confirm|choose|decide|update|flash|enable|set)\b/i,
  // "please run ...", "Please approve ..."
  new RegExp(`\\bplease\\s+(?:\\w+\\s+)?${ACT}\\b`, 'i'),
  // "for you to do", "ready for you to choose from", "is for you to decide"
  new RegExp(`\\bfor (?:you|the user) to\\s+(?:do|${ACT})\\b`, 'i'),
  // "your turn", "over to you", "the ball is in your court", "your step", "on your end/side" with an action
  /\b(?:your turn|over to you|in your court|your step|your move)\b/i,
  new RegExp(`\\bon your (?:end|side)\\b`, 'i'),
  // "once you connect it, agents will ...", "after you approve, I'll ...": the user's action gates the work
  new RegExp(`\\b(?:once|after|until|as soon as) you(?:'ve| have)?\\s+(?:\\w+\\s+)?${ACT}(?:e?d|s|ing)?\\b.*\\b(?:I|we|agents?|it)(?:'ll| will| can| could| cannot| can't| won't)\\b`, 'i'),
  new RegExp(`\\b(?:I|we|agents?)(?:'ll| will| can)\\b.*\\b(?:once|after|until|as soon as) you(?:'ve| have)?\\s+(?:\\w+\\s+)?${ACT}(?:e?d|s|ing)?\\b`, 'i'),
];

/** A sentence that denies an obligation or only offers: "nothing needed from you", "you don't need to", "say if you want". */
const NEGATED =
  /\b(?:nothing|no action|no need|not needed|no longer|never|don't|do not|doesn't|does not|didn't|did not|won't|will not|without|isn't|is not|aren't|are not|no input)\b[^.]{0,40}\b(?:you|your|the user)\b|\b(?:you|the user)\b[^.]{0,20}\b(?:don't|do not|won't|will not|no longer|never|needn't|need not)\b/i;

/** Offers and past tense: the user may act, or already did. */
const NOT_AN_ASK = /^(?:if you|say if|tell me if|let me know|should you|in case you)\b|\b(?:you (?:asked|said|wanted|approved|chose|decided|answered|added|ran|merged)|(?<!(?:once|after|until|when|as soon as) )you've (?:already )?(?:approved|added|answered|chosen|decided|done))\b/i;

/** Split prose into sentences, without code blocks, quoted lines or headings. */
export function sentences(text: string): string[] {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^#+\s+/, ''))
    .join('\n');
  return prose
    .split(/(?<=[.!?])\s+(?=[A-Z0-9*_`"'(])|\n{1,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 3);
}

/** Whether one sentence says the user must do or decide something. */
export function isUserAsk(sentence: string): boolean {
  // Quoted words are someone else's ("a director that says 'you need to do X'"): not an ask by the writer.
  const s = sentence.replace(/`([^`]*)`/g, '$1').replace(/[*_]{1,2}/g, '').replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, '"…"');
  if (NOT_AN_ASK.test(s.trim())) return false;
  if (NEGATED.test(s)) return false;
  return PATTERNS.some((p) => p.test(s));
}

/** The sentences of `text` that ask the user to act or decide, as written (clipped), in order. */
export function findUserAsks(text: string): string[] {
  if (!text) return [];
  return sentences(text)
    .filter(isUserAsk)
    .map((s) => (s.length > 300 ? `${s.slice(0, 297)}...` : s));
}
