import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * Server-side CORS proxy for Aperture data providers.
 *
 * The browser-side WASM shell never reaches finance APIs directly:
 *   - Some providers (Yahoo, Binance, FRED) refuse cross-origin requests.
 *   - API keys (FRED_API_KEY, ALPHAVANTAGE_KEY, ...) must stay server-side
 *     and are read from `.env` here, never bundled into the WASM artifact.
 *
 * Phase A: a host allowlist is enforced; the route returns the upstream body
 * with the upstream content-type. Real provider routing (key injection per
 * host, rate-limit, response shaping) is wired in Phase C.
 */

const ALLOWED_HOSTS = new Set<string>([
	"query1.finance.yahoo.com",
	"query2.finance.yahoo.com",
	"api.coingecko.com",
	"api.binance.com",
	"api.stlouisfed.org",
	"data.sec.gov",
	"www.alphavantage.co",
]);

export const GET: RequestHandler = async ({ url, fetch }) => {
	const upstream = url.searchParams.get("u");
	if (!upstream) throw error(400, "missing ?u=<upstream-url>");

	let target: URL;
	try {
		target = new URL(upstream);
	} catch {
		throw error(400, "invalid upstream url");
	}
	if (!ALLOWED_HOSTS.has(target.host)) {
		throw error(403, `host not allowed: ${target.host}`);
	}

	const res = await fetch(target.toString(), {
		headers: { accept: "application/json" },
	});
	const body = await res.text();
	const contentType = res.headers.get("content-type") ?? "application/json";
	return new Response(body, {
		status: res.status,
		headers: {
			"content-type": contentType,
			"cache-control": "no-store",
		},
	});
};

export const POST: RequestHandler = async () => {
	return json({ error: "POST not yet supported by aperture proxy" }, { status: 405 });
};
