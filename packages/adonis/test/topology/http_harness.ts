import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import type { ControlPlaneContext, ControlPlaneRouter } from '../../src/topology/control_plane.js';

type Handler = (ctx: ControlPlaneContext) => Promise<unknown>;

/**
 * A tiny router + HttpContext adapter over a real HTTP server: enough to run the media control
 * plane's handlers in-process. A JSON body is parsed for `body()`; any other body is left on the
 * raw request, as AdonisJS' bodyparser leaves an `application/octet-stream` upload.
 */
export function serveControlPlane(register: (router: ControlPlaneRouter) => void): Promise<Server> {
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  register({
    route(pattern, methods, handler) {
      for (const method of methods) routes.push({ method, pattern, handler });
    },
  });
  const match = (pattern: string, path: string) => {
    const names: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/:([A-Za-z]+)/g, (_, n) => {
        names.push(n);
        return '([^/]+)';
      })}$`,
    );
    const m = re.exec(path);
    return m ? Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) : null;
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://x');
    const route = routes.find((r) => r.method === req.method && match(r.pattern, url.pathname));
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const params = match(route.pattern, url.pathname)!;
    let body: unknown = {};
    if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString();
      body = raw ? JSON.parse(raw) : {};
    }
    let status = 200;
    const headers: Record<string, string> = {};
    let streamed = false;
    const response = {
      status(code: number) {
        status = code;
        return response;
      },
      header(name: string, value: string) {
        headers[name] = value;
        return response;
      },
      send(payload: unknown) {
        res.writeHead(status, headers);
        if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) res.end(payload);
        else res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      },
      json(payload: unknown) {
        headers['content-type'] = 'application/json';
        response.send(payload);
      },
      stream(stream: Readable) {
        streamed = true;
        res.writeHead(status, headers);
        stream.pipe(res);
      },
    };
    const ctx: ControlPlaneContext = {
      params,
      request: {
        header: (name) => (req.headers[name.toLowerCase()] as string | undefined) ?? undefined,
        qs: () => Object.fromEntries(url.searchParams),
        body: () => body,
        request: req,
      },
      response,
    };
    try {
      await route.handler(ctx);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
      return;
    }
    if (!streamed && !res.writableEnded) res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** The base URL of a listening server. */
export function addressOf(server: Server): string {
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('server is not listening');
  return `http://127.0.0.1:${address.port}`;
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
