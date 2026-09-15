/** Small fetch helper: timeout, retries with backoff, and a captured trace. */

export const trace = [];

export async function getText(url, { timeoutMs = 25000, retries = 3, label = '' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { 'User-Agent': 'tp-surfcast2 (personal surf forecast; contact via GitHub)' },
      });
      const body = await res.text();
      trace.push({ label, url, status: res.status, ms: Date.now() - started, bytes: body.length, attempt });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${label || url}`);
      return body;
    } catch (err) {
      lastErr = err;
      trace.push({ label, url, error: String(err && err.message || err), ms: Date.now() - started, attempt });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function getJson(url, opts = {}) {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${opts.label || url}: ${text.slice(0, 200)}`);
  }
}

/** Run tasks in parallel; never let one bad source sink the whole build. */
export async function settleAll(tasks) {
  const entries = Object.entries(tasks);
  const results = await Promise.allSettled(entries.map(([, fn]) => fn()));
  const out = {};
  const errors = {};
  results.forEach((r, i) => {
    const key = entries[i][0];
    if (r.status === 'fulfilled') out[key] = r.value;
    else { out[key] = null; errors[key] = String(r.reason && r.reason.message || r.reason); }
  });
  return { out, errors };
}
