function csrf() {
  const value = document.cookie.split('; ').find((entry) => entry.startsWith('oa_csrf='));
  return value ? decodeURIComponent(value.split('=').slice(1).join('=')) : '';
}

function errorMessages(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => errorMessages(item, depth + 1));
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const location = Array.isArray(record.location ?? record.loc)
    ? (record.location ?? record.loc) as unknown[] : [];
  const field = String(location.at(-1) ?? '');
  const direct = typeof record.message === 'string' ? record.message
    : typeof record.msg === 'string' ? record.msg : null;
  if (direct) return [field ? `${field}: ${direct}` : direct];
  for (const key of ['message', 'detail', 'error', 'errors']) {
    const nested = errorMessages(record[key], depth + 1);
    if (nested.length) return nested;
  }
  return [];
}

export function apiErrorMessage(payload: unknown, status: number) {
  const messages = errorMessages(payload);
  return messages.length
    ? [...new Set(messages)].join(' · ')
    : `No fue posible completar la solicitud (HTTP ${status}).`;
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('x-csrf-token', csrf());
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  const contentType = response.headers.get('content-type') ?? '';
  const result = contentType.includes('json') ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(apiErrorMessage(result, response.status));
  return result as T;
}

export const post = <T = any>(path: string, value: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(value) });
