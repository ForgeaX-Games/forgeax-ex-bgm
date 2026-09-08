import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import viteConfig from '../vite.config.ts';

type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => Promise<void> | void;

describe('standalone packaged audio tools', () => {
  test('dispatches remaining plugin tools through the Vite /api/tools/call shim', async () => {
    const config = viteConfig as {
      plugins?: Array<{
        name?: string;
        configureServer?: (server: unknown) => void;
      }>;
    };
    const plugin = config.plugins?.find((candidate) => candidate.name === 'packaged-audio-tools');

    expect(plugin).toBeDefined();

    if (typeof plugin?.configureServer !== 'function') {
      throw new Error('packaged-audio-tools must configure the Vite server');
    }
    const routes = new Map<string, Middleware>();
    plugin.configureServer({
      middlewares: {
        use(path: string | Middleware, handler?: Middleware) {
          if (typeof path === 'string' && handler) routes.set(path, handler);
        },
      },
    });

    expect(routes.has('/api/wb/bgm/cos-proxy')).toBe(false);
    const middleware = routes.get('/api/tools/call');
    expect(middleware).toBeDefined();

    const requestBody = JSON.stringify({
      toolId: 'get-audio-project',
      args: {},
      caller: { kind: 'user' },
    });
    const request = Readable.from([requestBody]) as unknown as IncomingMessage;
    Object.assign(request, { method: 'POST', url: '/' });

    let statusCode = 0;
    let responseBody = '';
    const response = {
      writeHead(code: number) {
        statusCode = code;
        return response;
      },
      end(chunk?: string | Buffer) {
        if (chunk) responseBody += chunk.toString();
        return response;
      },
    } as unknown as ServerResponse;

    await middleware!(request, response, () => {
      throw new Error('local tool route unexpectedly fell through');
    });

    expect(statusCode).toBe(200);
    expect(JSON.parse(responseBody)).toMatchObject({
      ok: false,
      code: 'slug-required',
    });
  });
});
