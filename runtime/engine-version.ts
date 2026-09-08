import type { RuntimeAudioProject } from './types.ts';

export const ENGINE_VERSION = '2.0.0-dev';

export class EngineVersionMismatchError extends Error {
  readonly code = 'engine_version_mismatch';

  constructor(expected: string, actual: string) {
    super(`audio bank engineVersion '${actual}' does not match runtime '${expected}'`);
    this.name = 'EngineVersionMismatchError';
  }
}

export function assertEngineVersion(project: RuntimeAudioProject, engineVersion = ENGINE_VERSION): void {
  // Banks without a stamp are treated as legacy v1 and allowed through.
  if (project.engineVersion === undefined || project.engineVersion === '') return;
  if (project.engineVersion !== engineVersion) {
    throw new EngineVersionMismatchError(engineVersion, project.engineVersion);
  }
}
