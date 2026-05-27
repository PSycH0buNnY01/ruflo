/**
 * GAIA Tool: web_search — ADR-133-PR2 (iter 21 patch)
 *
 * Multi-backend web search that gracefully degrades through available
 * backends:
 *
 *   1. Wikipedia Search API  — no auth, highly reliable, excellent for GAIA's
 *      factual/encyclopedic questions, sub-second latency.
 *   2. Brave Search HTML     — scrapes Brave's HTML endpoint when not
 *      rate-limited (429).  Works well in low-traffic environments.
 *   3. DDG HTML (original)   — kept as final fallback; may be blocked at
 *      network level (TCP timeout) in some environments.
 *
 * Background: iter 15 failure analysis showed 79 % null returns attributed
 * to DDG's html.duckduckgo.com timing out with TCP-level block (the IP
 * 40.89.244.232 drops connections from certain network ranges).  Switching
 * to Wikipedia as primary resolves the ~40 % null gap for the majority of
 * GAIA L1 questions that reference Wikipedia-sourced facts.
 *
 * Refs: ADR-133, #2156, iter-15 failure decomposition
 */

import * as https from 'node:https';
import { GaiaTool, ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 5;
const REQUEST_TIMEOUT_MS = 12_000; // shorter timeout per backend so we fail-fast

/** User-Agent accepted by most services. */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** UA for Wikipedia (they prefer a descriptive bot UA). */
const WIKI_UA = 'GAIA-bench/1.0 (https://github.com/ruvnet/claude-flow; benchmark agent)';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Generic HTTP helper
// ---------------------------------------------------------------------------

function httpsGet(
  hostname: string,
  path: string,
  headers: Record<string, string | number>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = { hostname, path, method: 'GET', headers };
    const req = https.request(options, (res) => {
      if (
        res.statusCode !== undefined &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const loc = res.headers.location;
        res.resume();
        if (loc.startsWith('https://')) {
          https
            .get(loc, { headers }, (r2) => {
              const chunks: Buffer[] = [];
              r2.on('data', (c: Buffer) => chunks.push(c));
              r2.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
              r2.on('error', reject);
            })
            .on('error', reject);
        } else {
          reject(new Error(`Unexpected redirect: ${loc}`));
        }
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

function httpsPost(
  hostname: string,
  path: string,
  body: Buffer,
  headers: Record<string, string | number>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = { hostname, path, method: 'POST', headers };
    const req = https.request(options, (res) => {
      if (
        res.statusCode !== undefined &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const loc = res.headers.location;
        res.resume();
        if (loc.startsWith('https://')) {
          https
            .get(loc, { headers: { 'User-Agent': UA } }, (r2) => {
              const chunks: Buffer[] = [];
              r2.on('data', (c: Buffer) => chunks.push(c));
              r2.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
              r2.on('error', reject);
            })
            .on('error', reject);
        } else {
          reject(new Error(`Unexpected redirect: ${loc}`));
        }
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Backend 1: Wikipedia Search API
// ---------------------------------------------------------------------------

/**
 * Query the Wikipedia search API (MediaWiki action=query&list=search).
 * Returns up to maxResults page titles + snippets + full Wikipedia URLs.
 * No authentication required.  Typically responds in <500 ms.
 */
async function searchWikipedia(query: string, maxResults: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    format: 'json',
    srlimit: String(Math.min(maxResults * 2, 10)), // fetch extra, we may filter some
    srprop: 'snippet',
    utf8: '1',
  });
  const path = `/w/api.php?${params.toString()}`;
  const raw = await httpsGet(
    'en.wikipedia.org',
    path,
    { 'User-Agent': WIKI_UA, Accept: 'application/json' },
    REQUEST_TIMEOUT_MS,
  );

  const data = JSON.parse(raw) as {
    query?: { search?: Array<{ title: string; snippet: string }> };
  };

  const hits = data?.query?.search ?? [];
  return hits.slice(0, maxResults).map((h) => ({
    title: h.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
    snippet: stripHtml(h.snippet),
  }));
}

// ---------------------------------------------------------------------------
// Backend 2: Brave Search HTML scraper
// ---------------------------------------------------------------------------

/**
 * Scrape Brave's HTML search results page.  Brave allows HTML scraping at
 * moderate rates; returns 429 when rate-limited, in which case the caller
 * falls through to the next backend.
 */
async function searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  const path = `/search?q=${encodeURIComponent(query)}&source=web`;
  const html = await httpsGet(
    'search.brave.com',
    path,
    {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    REQUEST_TIMEOUT_MS,
  );
  return parseBraveHtml(html, maxResults);
}

function parseBraveHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Brave uses Svelte with hash-suffixed classes; we match the class prefix.
  // Structure: class="result-content <svelte-hash>"><a href="https://...">
  const blockRe =
    /class="result-content[^"]*">([\s\S]*?)(?=class="result-content|<\/section>|<\/main>)/g;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(html)) !== null && results.length < maxResults) {
    const block = m[1];

    // URL: first external https link in block (skip Brave's own domains)
    const urlMatch = block.match(
      /href="(https:\/\/(?!(?:cdn\.|imgs\.|search\.brave\.com))[^"]+)"/,
    );
    if (!urlMatch) continue;
    const url = urlMatch[1];

    // Title: heading or title-classed element inside block
    const headingMatch = block.match(
      /<(?:h2|h3|div|span)[^>]*class="[^"]*(?:header|heading|title)[^"]*"[^>]*>([\s\S]*?)<\/(?:h2|h3|div|span)>/,
    );
    let title = '';
    if (headingMatch) {
      title = stripHtml(headingMatch[1]).trim();
    }
    if (!title) {
      // Fallback: use domain as title
      try {
        title = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        title = url;
      }
    }

    // Snippet: look for snippet-class element
    const snippetMatch = block.match(
      /class="snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:p|span|div)>/,
    );
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : '';

    results.push({ title, url, snippet });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Backend 3: DDG HTML (original, kept as last resort)
// ---------------------------------------------------------------------------

async function searchDdg(query: string, maxResults: number): Promise<SearchResult[]> {
  const bodyStr = `q=${encodeURIComponent(query)}&b=&kl=&df=`;
  const bodyBytes = Buffer.from(bodyStr, 'utf-8');
  const html = await httpsPost(
    'html.duckduckgo.com',
    '/html/',
    bodyBytes,
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': bodyBytes.length,
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    REQUEST_TIMEOUT_MS,
  );
  return parseDdgHtml(html, maxResults);
}

function parseDdgHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = match[1] ?? '';
    const rawTitle = match[2] ?? '';
    const rawSnippet = match[3] ?? '';
    const url = decodeRawDdgUrl(rawUrl);
    const title = stripHtml(rawTitle).trim();
    const snippet = stripHtml(rawSnippet).trim();
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

function decodeRawDdgUrl(raw: string): string {
  if (raw.startsWith('//duckduckgo.com/l/')) {
    const idx = raw.indexOf('uddg=');
    if (idx !== -1) {
      const encoded = raw.slice(idx + 5).split('&')[0];
      try {
        return decodeURIComponent(encoded);
      } catch {
        return raw;
      }
    }
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  return raw;
}

// ---------------------------------------------------------------------------
// Shared HTML stripping
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function formatResults(results: SearchResult[], backend: string): string {
  if (results.length === 0) return 'No results found.';
  const header = `[source: ${backend}]`;
  const body = results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.url}${r.snippet ? '\n    ' + r.snippet : ''}`,
    )
    .join('\n\n');
  return `${header}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Multi-backend search with fallback chain
// ---------------------------------------------------------------------------

interface BackendResult {
  results: SearchResult[];
  backend: string;
}

async function searchWithFallback(query: string, maxResults: number): Promise<BackendResult> {
  // Backend 1: Wikipedia — best for GAIA factual questions
  try {
    const results = await searchWikipedia(query, maxResults);
    if (results.length > 0) return { results, backend: 'wikipedia' };
  } catch (_e) {
    // fall through to next backend
  }

  // Backend 2: Brave HTML — good general search
  try {
    const results = await searchBrave(query, maxResults);
    if (results.length > 0) return { results, backend: 'brave' };
  } catch (_e) {
    // fall through to next backend
  }

  // Backend 3: DDG HTML — original backend, may be network-blocked
  try {
    const results = await searchDdg(query, maxResults);
    if (results.length > 0) return { results, backend: 'ddg' };
  } catch (_e) {
    // all backends failed
  }

  return { results: [], backend: 'none' };
}

// ---------------------------------------------------------------------------
// GaiaTool implementation
// ---------------------------------------------------------------------------

export class WebSearchTool implements GaiaTool {
  readonly name = 'web_search';

  readonly definition: ToolDefinition = {
    name: 'web_search',
    description:
      'Search the web and return the top results (title, URL, snippet). ' +
      'Uses Wikipedia Search API as primary backend (best for factual/encyclopedic queries), ' +
      'with Brave Search and DuckDuckGo as fallbacks. ' +
      'Use this when you need current information, external facts, or to verify claims.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query string.',
        },
        max_results: {
          type: 'number',
          description: `Maximum number of results to return (default: ${DEFAULT_MAX_RESULTS}, max: 10).`,
        },
      },
      required: ['query'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<string> {
    const query = String(input['query'] ?? '').trim();
    if (!query) throw new Error('web_search: `query` input is required and must be non-empty.');

    const maxResults = Math.min(
      Math.max(1, Number(input['max_results'] ?? DEFAULT_MAX_RESULTS)),
      10,
    );

    const { results, backend } = await searchWithFallback(query, maxResults);
    return formatResults(results, backend);
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

export function createWebSearchTool(): WebSearchTool {
  return new WebSearchTool();
}
