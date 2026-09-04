function csrf() {
  const value = document.cookie.split('; ').find((entry) => entry.startsWith('oa_csrf='));
  return value ? decodeURIComponent(value.split('=').slice(1).join('=')) : '';
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('x-csrf-token', csrf());
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  const contentType = response.headers.get('content-type') ?? '';
  const result = contentType.includes('json') ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(result?.message ?? result?.detail ?? `Error ${response.status}`);
  return result as T;
}

export const post = <T = any>(path: string, value: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(value) });

