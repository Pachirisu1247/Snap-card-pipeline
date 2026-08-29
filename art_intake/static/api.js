export class ApiError extends Error {
  constructor(message, status = 0, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function decode(response) {
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) return response.json();
  return response.text();
}

export async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const data = await decode(response);
  if (!response.ok || (data && typeof data === 'object' && data.ok === false)) {
    const message = data?.error || data?.message || `${response.status} ${response.statusText}`;
    throw new ApiError(message, response.status, data);
  }
  return data;
}

export function getJson(path) {
  return request(path);
}

export function postJson(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
