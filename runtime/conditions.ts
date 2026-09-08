import type { AudioEventContext, RuntimeAudioBinding, RuntimeConditionValue } from './types.ts';

export function contextValue(context: AudioEventContext, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function conditionMatches(
  actual: unknown,
  operator: RuntimeAudioBinding['conditions'][number]['operator'],
  expected: RuntimeConditionValue,
): boolean {
  switch (operator) {
    case 'eq': return actual === expected;
    case 'neq': return actual !== expected;
    case 'gt': return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt': return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'in': return Array.isArray(expected) && expected.some((item) => item === actual);
  }
}

export function bindingMatches(binding: RuntimeAudioBinding, context: AudioEventContext): boolean {
  return binding.conditions.every((condition) => (
    conditionMatches(contextValue(context, condition.field), condition.operator, condition.value)
  ));
}
