/** Minimal ForgeaX host-sdk bridge for the BGM & SFX Studio iframe. */
export interface AppState {
  status: 'ready' | 'loading' | 'idle' | 'error';
}

export interface PlatformMessage {
  type: 'refresh' | 'search';
  query?: string;
}

type MessageHandler = (msg: PlatformMessage) => void;

const PLUGIN_ID = '@forgeax-extension/bgm';

export class PlatformBridge {
  private readonly handlers = new Set<MessageHandler>();
  private readonly parent = window.parent;
  private readonly isEmbedded = this.parent !== window;
  private sequence = 0;

  constructor() {
    if (this.isEmbedded) window.addEventListener('message', this.handleMessage);
  }

  sendReady(): void {
    this.send({ kind: 'handshake.request', protocols: [1] });
  }

  sendStateChange(state: Partial<AppState>): void {
    this.send({
      kind: 'surface.expose',
      surfaceId: 'bgm.status',
      actions: [],
      snapshot: state,
    });
  }

  postChat(text: string): void {
    const normalized = text.trim();
    if (normalized) this.send({ kind: 'chat.post', text: normalized });
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.add(handler);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (event.source !== this.parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return;
    if (data.kind === 'theme.changed') {
      if (data.theme === 'light' || data.theme === 'dark') {
        document.documentElement.dataset.theme = data.theme;
      }
      return;
    }
    // Legacy host actions are accepted only from the actual parent. We never
    // send legacy envelopes back, so the current host validator stays quiet.
    if (data.type !== 'refresh' && data.type !== 'search') return;
    const message: PlatformMessage = {
      type: data.type,
      ...(typeof data.query === 'string' ? { query: data.query } : {}),
    };
    for (const handler of this.handlers) handler(message);
  };

  private send(body: Record<string, unknown>): void {
    if (!this.isEmbedded) return;
    this.sequence += 1;
    this.parent.postMessage({
      v: 1,
      id: `BGM & SFX-${Date.now().toString(36)}-${this.sequence.toString(36)}`,
      from: { kind: 'plugin', pluginId: PLUGIN_ID },
      ts: new Date().toISOString(),
      ...body,
    }, '*');
  }
}
