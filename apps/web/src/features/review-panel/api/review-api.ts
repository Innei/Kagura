import type {
  ReviewDiffResponse,
  ReviewFileResponse,
  ReviewSession,
  ReviewTreeEntry,
  ReviewTreeResponse,
} from '../types';
import { getJson } from './http';

export async function loadInitialReviewData(reviewExecutionId: string, apiBasePath = '') {
  const session = await getJson<ReviewSession>(
    apiUrl(apiBasePath, `/api/reviews/${encodeURIComponent(reviewExecutionId)}`),
  );
  return { session };
}

export async function loadDiff(
  reviewExecutionId: string,
  filePath?: string | undefined,
  apiBasePath = '',
  options?: { limit?: number | undefined; offset?: number | undefined } | undefined,
): Promise<ReviewDiffResponse> {
  const params = new URLSearchParams();
  if (filePath) params.set('path', filePath);
  if (!filePath && options?.limit !== undefined) params.set('limit', String(options.limit));
  if (!filePath && options?.offset !== undefined) params.set('offset', String(options.offset));
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const payload = await getJson<ReviewDiffResponse>(
    apiUrl(apiBasePath, `/api/reviews/${encodeURIComponent(reviewExecutionId)}/diff${suffix}`),
  );
  return payload;
}

export async function loadTree(
  reviewExecutionId: string,
  apiBasePath = '',
): Promise<ReviewTreeEntry[]> {
  const payload = await getJson<ReviewTreeResponse>(
    apiUrl(apiBasePath, `/api/reviews/${encodeURIComponent(reviewExecutionId)}/tree`),
  );
  return payload.entries;
}

export async function loadFile(
  reviewExecutionId: string,
  filePath: string,
  apiBasePath = '',
  ref: 'base' | 'head' = 'head',
): Promise<ReviewFileResponse | undefined> {
  const refSuffix = ref === 'base' ? '&ref=base' : '';
  try {
    const payload = await getJson<ReviewFileResponse>(
      apiUrl(
        apiBasePath,
        `/api/reviews/${encodeURIComponent(reviewExecutionId)}/file?path=${encodeURIComponent(filePath)}${refSuffix}`,
      ),
    );
    return payload;
  } catch {
    return undefined;
  }
}

function apiUrl(apiBasePath: string, path: string): string {
  return `${apiBasePath}${path}`;
}
