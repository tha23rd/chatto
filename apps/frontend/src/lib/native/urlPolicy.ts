function parseUrl(value: string, message: string): URL {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.hash) throw new Error(message);
    return parsed;
  } catch {
    throw new Error(message);
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isAllowedHttpUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

/** Validate and canonicalize a user-entered Chatto server base URL. */
export function assertAllowedServerUrl(value: string): string {
  const message = 'Server URL is not allowed.';
  const url = parseUrl(value, message);
  if (!isAllowedHttpUrl(url) || url.pathname !== '/' || url.search) {
    throw new Error(message);
  }
  return url.origin;
}

/** Validate an absolute HTTP endpoint before it crosses the native boundary. */
export function assertAllowedHttpEndpoint(value: string): string {
  const message = 'HTTP endpoint is not allowed.';
  const url = parseUrl(value, message);
  if (!isAllowedHttpUrl(url)) throw new Error(message);
  return url.toString();
}

/** Validate an absolute realtime WebSocket URL before native connection. */
export function assertAllowedRealtimeUrl(value: string): string {
  const message = 'Realtime URL is not allowed.';
  const url = parseUrl(value, message);
  const allowed =
    url.protocol === 'wss:' || (url.protocol === 'ws:' && isLoopbackHost(url.hostname));
  if (!allowed) throw new Error(message);
  return url.toString();
}

/** Validate an external link before handing it to the operating system. */
export function assertAllowedExternalUrl(value: string): string {
  const message = 'External URL is not allowed.';
  const url = parseUrl(value, message);
  if (url.protocol !== 'https:') throw new Error(message);
  return url.toString();
}
