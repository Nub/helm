import { EventEmitter } from 'node:events';

/**
 * Live updates pushed to browsers. Most messages are just "this project
 * changed, refetch it"; transcript events carry their row so an open agent
 * view can append without refetching.
 */
export type BusMessage =
  | { type: 'projects' }
  | { type: 'hosts' }
  | { type: 'toolbox' }
  | { type: 'disk' }
  | { type: 'project'; projectId: string }
  | { type: 'event'; projectId: string; agentId: string; event: unknown };

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

export const bus = {
  publish(msg: BusMessage) {
    emitter.emit('msg', msg);
  },
  subscribe(fn: (msg: BusMessage) => void) {
    emitter.on('msg', fn);
    return () => emitter.off('msg', fn);
  },
};
