import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { basename } from 'node:path';
import { get } from './db.ts';
import { checkAgentFile } from './attachments.ts';
import { getProject, touchProject } from './store.ts';
import { createCard, createFrame, findFrame, importImageCard, previewLater, renderBoard } from './ideas.ts';
import type { ToolAccess } from './tools.ts';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** The director's view of the Ideas board (ideas.ts): read it, and add notes, links or images, loose or in a frame. */
export function ideasTools(agentId: string, access: ToolAccess): any[] {
  if (!access.manager) return [];
  const pid = () => get('SELECT project_id FROM agents WHERE id = ?', agentId)!.project_id as string;
  return [
    tool(
      'list_ideas',
      "Read the project's Ideas board: its frames (named groups, and the discussion each started) with their cards, then cards in no frame. Each card: id, kind (note, link, image), position, text.",
      {},
      async () => ok(renderBoard(pid())),
    ),
    tool(
      'add_idea',
      'Add a card to the Ideas board: a note (markdown text), a link (url; Helm fetches its title and image) or an image (path to a file in the project). With frame, it goes into that frame (id or name; a new name makes a new frame below the board).',
      {
        kind: z.enum(['note', 'link', 'image']),
        text: z.string().max(20_000).optional().describe('A note\'s markdown; for a link or image, an optional title'),
        url: z.string().max(2000).optional().describe('For a link'),
        path: z.string().max(1000).optional().describe('For an image: the file, in the project'),
        frame: z.string().max(120).optional().describe('Frame id or name'),
      },
      async ({ kind, text, url, path, frame }) => {
        const projectId = pid();
        if (kind === 'note' && !text?.trim()) return fail('Give the note its text.');
        let made = '';
        if (frame && !findFrame(projectId, frame)) {
          if (/^if_[0-9a-f]+$/.test(frame)) return fail(`No frame ${frame} on the board (list_ideas).`);
          const f = createFrame(projectId, { name: frame });
          if ('error' in f) return fail(f.error);
          made = ` New frame "${f.name}" ${f.id}.`;
        }
        let c;
        if (kind === 'image') {
          if (!path) return fail('Give the image file: path.');
          const checked = checkAgentFile(getProject(projectId)!, path);
          if ('error' in checked) return fail(checked.error);
          c = importImageCard(projectId, checked.path, basename(checked.path), { kind, text, frame: frame ?? null, author: 'director' });
        } else c = createCard(projectId, { kind, text, url, frame: frame ?? null, author: 'director' });
        if ('error' in c) return fail(c.error);
        if (c.kind === 'link') previewLater(c.id, projectId);
        touchProject(projectId);
        return ok(`Added ${c.kind} ${c.id}${c.frame_id ? ` in frame ${c.frame_id}` : ''}.${made}`);
      },
    ),
  ];
}
