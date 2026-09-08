import type {
  CreativeRequest,
} from './creativeAudioStudio.ts';
import type { DesignWorkspace } from './audioDesignEntities.ts';

export const HUMAN_SEARCH_SCHEMA = 'human-audio-search/1' as const;

export type PlayerAudioStudioMode = 'voice' | 'generate';

export type AudioStudioMessage =
  | {
      schemaVersion: typeof HUMAN_SEARCH_SCHEMA;
      type: 'view.mode';
      requestId: string;
      projectId: string;
      mode: PlayerAudioStudioMode;
    }
  | {
      schemaVersion: typeof HUMAN_SEARCH_SCHEMA;
      type: 'creative.request';
      requestId: string;
      projectId: string;
      payload: CreativeRequest;
    }
  | {
      schemaVersion: typeof HUMAN_SEARCH_SCHEMA;
      type: 'creative.reset';
      requestId: string;
      projectId: string;
      mode: PlayerAudioStudioMode;
    }
  | {
      schemaVersion: typeof HUMAN_SEARCH_SCHEMA;
      type: 'creative.status';
      requestId: string;
      projectId: string;
      status: 'loading' | 'done' | 'error';
      count?: number;
      error?: string;
    }
  | {
      schemaVersion: typeof HUMAN_SEARCH_SCHEMA;
      type: 'bindings.state';
      requestId: string;
      projectId: string;
      slug: string;
      revisionLabel: string;
      bindingCount: number;
      busy: boolean;
      workspace?: DesignWorkspace;
    }
  | {
      schemaVersion: typeof HUMAN_SEARCH_SCHEMA;
      type: 'bindings.state.request' | 'bindings.scan';
      requestId: string;
      projectId: string;
    }
  | {
      schemaVersion: typeof HUMAN_SEARCH_SCHEMA;
      type: 'bindings.select';
      requestId: string;
      projectId: string;
      slug: string;
    }
  | {
      schemaVersion: typeof HUMAN_SEARCH_SCHEMA;
      type: 'bindings.workspace';
      requestId: string;
      projectId: string;
      workspace: DesignWorkspace;
    };
