import {
  HUMAN_SEARCH_SCHEMA,
  type AudioStudioMessage,
} from './humanSearchTypes.ts';

type Listener = (message: AudioStudioMessage) => void;

const LOCAL_EVENT = 'forgeax:bgm:local-message';

function channelIdentity(): { projectId: string; instanceId: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    projectId: params.get('slug') || 'default',
    instanceId: params.get('fxv') || 'standalone',
  };
}

/** Stable across left/center iframes. Do not include `fxv` — each pane embeds a
 *  cache-busting fxv that must not partition the bus (otherwise workspace
 *  clicks in the left iframe never reach the center editor). */
const AUDIO_STUDIO_CHANNEL = 'forgeax:bgm:audio-studio';

export class AudioStudioChannel {
  readonly projectId: string;
  readonly instanceId: string;
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<Listener>();

  constructor() {
    const identity = channelIdentity();
    this.projectId = identity.projectId;
    this.instanceId = identity.instanceId;
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel(AUDIO_STUDIO_CHANNEL);
      this.channel.addEventListener('message', (event: MessageEvent<unknown>) => {
        this.receive(event.data);
      });
    }
    window.addEventListener(LOCAL_EVENT, this.onLocalMessage as EventListener);
  }

  post(message: AudioStudioMessage): void {
    if (message.schemaVersion !== HUMAN_SEARCH_SCHEMA) return;
    // Allow delivery when one pane still bootstraps with slug=default while the
    // sibling already has the pinned game slug.
    if (
      message.projectId !== this.projectId
      && message.projectId !== 'default'
      && this.projectId !== 'default'
    ) return;
    this.channel?.postMessage(message);
    window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: message }));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.channel?.close();
    window.removeEventListener(LOCAL_EVENT, this.onLocalMessage as EventListener);
    this.listeners.clear();
  }

  private onLocalMessage = (event: CustomEvent<unknown>): void => {
    this.receive(event.detail);
  };

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as Partial<AudioStudioMessage>;
    if (message.schemaVersion !== HUMAN_SEARCH_SCHEMA) return;
    if (
      typeof message.projectId === 'string'
      && message.projectId !== this.projectId
      && message.projectId !== 'default'
      && this.projectId !== 'default'
    ) return;
    for (const listener of this.listeners) listener(message as AudioStudioMessage);
  }
}
