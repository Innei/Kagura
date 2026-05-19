import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

import type { AppLogger } from '~/logger/index.js';
import type { GitReviewService } from '~/review/git-review-service.js';

export interface ReviewPanelServerOptions {
  assetsDir: string;
  baseUrl: string;
  host: string;
  logger: AppLogger;
  port: number;
  reviewService: GitReviewService;
}

export interface ReviewPanelServer {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createReviewPanelServer(options: ReviewPanelServerOptions): ReviewPanelServer {
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, options).catch((error) => {
      options.logger.warn('Review panel request failed: %s', String(error));
      sendJson(response, 500, { error: 'Internal Server Error' });
    });
  });

  return {
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
          server.off('error', reject);
          const listenUrl = `http://${options.host}:${options.port}`;
          options.logger.info('Review panel API listening on %s', listenUrl);
          options.logger.info('Review panel UI links will use %s', options.baseUrl);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: ReviewPanelServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', options.baseUrl);
  const pathname = stripBasePath(url.pathname, options.baseUrl);
  const apiMatch = pathname.match(/^\/api\/reviews\/([^/]+)(?:\/([^/]+))?$/);

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method Not Allowed' });
    return;
  }

  if (apiMatch?.[1]) {
    await handleApiRequest(response, options.reviewService, apiMatch[1], apiMatch[2], url);
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'Not Found' });
    return;
  }

  await serveReviewPanelAsset(response, options.assetsDir, pathname);
}

function stripBasePath(pathname: string, baseUrl: string): string {
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length) || '/';
  return pathname;
}

async function handleApiRequest(
  response: http.ServerResponse,
  reviewService: GitReviewService,
  executionId: string,
  resource: string | undefined,
  url: URL,
): Promise<void> {
  const apiResource = resource ?? 'session';

  if (apiResource === 'session') {
    const session = reviewService.getSession(executionId);
    if (!session) {
      sendJson(response, 404, { error: 'Review session not found.' });
      return;
    }
    sendJson(response, 200, session);
    return;
  }

  if (apiResource === 'tree') {
    const tree = reviewService.listTree(executionId);
    if (!tree) {
      sendJson(response, 404, { error: 'Review session not found.' });
      return;
    }
    sendJson(response, 200, { entries: tree });
    return;
  }

  if (apiResource === 'diff') {
    try {
      const filePath = url.searchParams.get('path') ?? undefined;
      const limit = parsePositiveInt(url.searchParams.get('limit'));
      const offset = parseNonNegativeInt(url.searchParams.get('offset')) ?? 0;
      if (!filePath && limit !== undefined) {
        const page = reviewService.getDiffPage(executionId, offset, limit);
        if (page === undefined) {
          sendJson(response, 404, { error: 'Review session not found.' });
          return;
        }
        sendJson(response, 200, page);
        return;
      }

      const diff = reviewService.getDiff(executionId, filePath);
      if (diff === undefined) {
        sendJson(response, 404, { error: 'Review session not found.' });
        return;
      }
      sendJson(response, 200, { diff });
    } catch {
      sendJson(response, 400, { error: 'Invalid file path.' });
    }
    return;
  }

  if (apiResource === 'file') {
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      sendJson(response, 400, { error: 'Missing path.' });
      return;
    }
    const refParam = url.searchParams.get('ref');
    const ref: 'base' | 'head' = refParam === 'base' ? 'base' : 'head';
    try {
      const file = await reviewService.getFile(executionId, filePath, ref);
      if (!file) {
        sendJson(response, 404, { error: 'File not found at requested ref.' });
        return;
      }
      sendJson(response, 200, file);
    } catch {
      sendJson(response, 400, { error: 'Invalid file path.' });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not Found' });
}

function parsePositiveInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, 100);
}

function parseNonNegativeInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

async function serveReviewPanelAsset(
  response: http.ServerResponse,
  assetsDir: string,
  urlPathname: string,
): Promise<void> {
  const filePath = resolveAssetPath(assetsDir, decodeAssetPathname(urlPathname));
  if (!filePath) {
    sendJson(response, 404, { error: 'Not Found' });
    return;
  }

  try {
    await sendAssetFile(response, filePath);
  } catch {
    if (urlPathname.startsWith('/assets/')) {
      sendJson(response, 404, { error: 'Not Found' });
      return;
    }
    await sendAssetFile(response, resolveSpaRouteEntry(assetsDir));
  }
}

function resolveAssetPath(assetsDir: string, urlPathname: string): string | undefined {
  const relativePath = urlPathname === '/' ? 'index.html' : urlPathname.replace(/^\/+/, '');
  const absoluteAssetsDir = path.resolve(assetsDir);
  const absoluteTarget = path.resolve(absoluteAssetsDir, relativePath);
  const relative = path.relative(absoluteAssetsDir, absoluteTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return absoluteTarget;
}

function resolveSpaRouteEntry(assetsDir: string): string {
  return path.resolve(assetsDir, 'index.html');
}

function decodeAssetPathname(urlPathname: string): string {
  try {
    return decodeURIComponent(urlPathname);
  } catch {
    return urlPathname;
  }
}

async function sendAssetFile(response: http.ServerResponse, filePath: string): Promise<void> {
  const content = await fs.readFile(filePath);
  const contentType = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
  response.writeHead(200, {
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000',
    'content-type': contentType,
  });
  response.end(content);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}
