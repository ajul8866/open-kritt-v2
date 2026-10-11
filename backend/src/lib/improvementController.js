import { readFile } from 'node:fs/promises';

export function improvementControllerClient({
  url = process.env.SELF_IMPROVEMENT_CONTROLLER_URL || 'http://self-improvement:8091',
  tokenFile = process.env.SELF_IMPROVEMENT_TOKEN_FILE || '/self-improvement-auth/token',
  fetchImpl = fetch,
  readToken = () => readFile(tokenFile, 'utf8'),
} = {}) {
  return async (path, { method = 'GET', body } = {}) => {
    const token = (await readToken()).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Controller token is not ready.');
    const response = await fetchImpl(`${url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(35000),
    });
    return { status: response.status, body: await response.json() };
  };
}
