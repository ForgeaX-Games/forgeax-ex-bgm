import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import tools from './server/tool-handlers.ts';

const pluginDir = dirname(fileURLToPath(import.meta.url));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function packagedAudioToolsPlugin(): Plugin {
  return {
    name: 'packaged-audio-tools',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method === 'OPTIONS' && req.url?.startsWith('/api/')) {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          });
          res.end();
          return;
        }
        next();
      });

      // POST /api/tools/call — standalone-dev shim. Embedded in Audio Studio this
      // hits the host ToolRegistry; here we call the same handlers directly.
      server.middlewares.use('/api/tools/call', async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return;
        const sendJson = (status: number, obj: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(obj));
        };
        try {
          const body = JSON.parse(await readBody(req));
          const toolId = String(body.toolId ?? '');
          const handler = (tools as Record<string, (args: unknown, ctx: unknown) => Promise<unknown>>)[toolId];
          if (!handler) {
            sendJson(200, { ok: false, error: `unknown tool: ${toolId}`, code: 'not_supported' });
            return;
          }
          const result = await handler(body.args ?? {}, {
            caller: body.caller ?? { kind: 'user' },
            toolId,
            env: process.env,
            cwd: pluginDir,
            projectRoot: process.env.FORGEAX_PROJECT_ROOT,
          });
          sendJson(200, { ok: true, result });
        } catch (e) {
          const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : 'invoke_error';
          sendJson(200, { ok: false, error: String(e), code });
        }
      });
    },
  };
}

export default defineConfig({
  base: '/extensions/bgm/',
  plugins: [packagedAudioToolsPlugin()],
  server: {
    // Not vite's default 5173: instances offset plugin ports by slot * 10000, so
    // 5173 lands on the editor play-runtime's own dev server (5173 + offset).
    port: 15178,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    assetsDir: 'assets',
  },
});
