#!/usr/bin/env node
/**
 * Standalone H-E-B reachability diagnostic — NOT part of the app, imports
 * nothing from src/, registers no routes, adds no dependencies. Its only
 * job is answering one question: can THIS process's outbound network
 * reach www.heb.com at all?
 *
 * Why this exists: a sandboxed dev environment used earlier in this
 * investigation was conclusively blocked at the network/IP-reputation
 * level by an Imperva/Incapsula WAF — confirmed via plain curl, a real
 * non-headless Chrome browser, AND headless Playwright all getting the
 * identical static block page (a bare iframe, zero interactive elements,
 * "Additional security check is required"). That's different from a
 * solvable per-request challenge or an automation-fingerprint check — it
 * happens before any page content renders at all, for every client type
 * tried. This script exists to find out whether Render's own outbound IP
 * gets the same treatment, or whether it's only this sandbox's IP that's
 * flagged.
 *
 * Every URL below is a REAL, previously-documented H-E-B endpoint found
 * via public prior-art research (not guessed):
 *   - Store locator:   billcobbler/heb-to-go (Go client),
 *                       pkg/heb-api/v1/heb.go
 *       POST https://www.heb.com/commerce-api/v1/store/locator/address
 *       body: {"address": zip, "curbsideOnly": false, "radius": N}
 *   - Timeslots:        a public gist (sjenning) — plain bash curl script
 *       GET https://www.heb.com/commerce-api/v1/timeslot/timeslots?store_id=N
 *   - GraphQL:          mgwalkerjr95/texas-grocery-mcp (Python MCP server)'s
 *                       own config default
 *                       (src/texas_grocery_mcp/utils/config.py)
 *       https://www.heb.com/graphql
 *   - SSR search page:  same repo's clients/graphql.py
 *       https://www.heb.com/search?q={query}
 * Homepage and robots.txt are the simplest possible reachability baseline.
 *
 * This makes GET/POST requests only, to real, publicly-documented
 * endpoints, with normal browser-like headers — no CAPTCHA solving, no
 * Incapsula challenge-token computation, no proxying, no credential use.
 * If the response is a block page, this just reports that and stops.
 *
 * Run with: node scripts/heb-diagnostic.js
 * (Node 18+ for built-in fetch — this project targets Node 22, which has
 * it; no npm install needed, no dependency on anything in package.json.)
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * `fetch`'s own `redirect: 'manual'` mode is used here (rather than the
 * default `'follow'`) specifically so the *actual* redirect chain — every
 * hop, its own status and Location header — can be logged. With
 * `'follow'`, only the final response is ever visible, which would hide
 * exactly the kind of "redirected to a block/challenge page" behavior
 * this diagnostic needs to see.
 */
async function fetchFollowingRedirects(url, init, maxHops = 5) {
  const chain = [];
  let currentUrl = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await withTimeout(
      fetch(currentUrl, {
        ...init,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
          ...(init && init.headers),
        },
        redirect: 'manual',
      }),
      TIMEOUT_MS,
    );
    chain.push({ url: currentUrl, status: res.status, location: res.headers.get('location') });

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!isRedirect || hop === maxHops) {
      return { finalRes: res, chain };
    }
    currentUrl = new URL(res.headers.get('location'), currentUrl).toString();
    // A redirect response body is never the payload we want — drain it so
    // the connection can close cleanly before following the next hop.
    await res.text().catch(() => undefined);
  }
  throw new Error('unreachable');
}

function classify(text) {
  if (/incapsula|additional security check|_incapsula_resource/i.test(text)) return 'IMPERVA/INCAPSULA BLOCK PAGE';
  if (/captcha|are you a human|verify you are human/i.test(text)) return 'CAPTCHA / bot-verification page';
  if (text.length === 0) return 'empty response';
  return 'looks like real content (not a recognized block/challenge pattern)';
}

async function probe(label, url, init = {}) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`PROBE: ${label}`);
  console.log(`${init.method || 'GET'} ${url}`);
  if (init.body) console.log(`body: ${init.body}`);

  const start = Date.now();
  try {
    const { finalRes, chain } = await fetchFollowingRedirects(url, init);
    const elapsedMs = Date.now() - start;
    const text = await finalRes.text().catch(() => '');

    console.log(`\nredirect chain (${chain.length} hop${chain.length === 1 ? '' : 's'}):`);
    for (const hop of chain) {
      console.log(`  ${hop.status}  ${hop.url}${hop.location ? `  -> ${hop.location}` : ''}`);
    }

    console.log(`\nfinal status: ${finalRes.status} ${finalRes.statusText}`);
    console.log(`content-type: ${finalRes.headers.get('content-type')}`);
    console.log(`response length: ${text.length} chars`);
    console.log(`elapsed: ${elapsedMs}ms`);
    console.log('\nresponse headers:');
    finalRes.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));
    console.log('\nfirst ~300 chars of body:');
    console.log(text.slice(0, 300));
    console.log(`\nCLASSIFICATION: ${classify(text)}`);
  } catch (err) {
    console.log(`\nFAILED (network error / timeout, not an HTTP response): ${err instanceof Error ? err.message : String(err)}`);
    console.log('CLASSIFICATION: request never completed');
  }
}

async function main() {
  console.log('H-E-B reachability diagnostic');
  console.log(`Node: ${process.version}`);
  console.log(`Process outbound requests will use whatever IP this host actually has.`);

  await probe('Homepage', 'https://www.heb.com/');
  await probe('robots.txt', 'https://www.heb.com/robots.txt');
  await probe('Store locator (zip 75035)', 'https://www.heb.com/commerce-api/v1/store/locator/address', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://www.heb.com', Referer: 'https://www.heb.com/' },
    body: JSON.stringify({ address: '75035', curbsideOnly: false, radius: 25 }),
  });
  await probe(
    'Timeslots (store 31 — a known-real store id from prior art)',
    'https://www.heb.com/commerce-api/v1/timeslot/timeslots?store_id=31&fulfillment_type=pickup',
  );
  await probe('GraphQL endpoint (bare GET — reachability only, not a real query)', 'https://www.heb.com/graphql');
  await probe('SSR search page (query=milk)', 'https://www.heb.com/search?q=milk', {
    headers: { Referer: 'https://www.heb.com/' },
  });

  console.log(`\n${'='.repeat(70)}`);
  console.log('Done. Copy this entire output back.');
}

main();
