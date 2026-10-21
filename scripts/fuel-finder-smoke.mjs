import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

// Official specifications:
// https://www.developer.fuel-finder.service.gov.uk/fuel-finder/api/openapi/access-token.en.json
// https://www.developer.fuel-finder.service.gov.uk/fuel-finder/api/openapi/info-recipent.en.json
const base = 'https://www.fuel-finder.service.gov.uk';
const reportUrl = 'https://www.fuel-finder.service.gov.uk/motorist/price-report';
const licenceUrl = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/';

async function request(fetchImpl, path, options, stage) {
  let response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error(`${stage}: connection failed or timed out. No credentials or response bodies were logged.`);
  }
  if (!response.ok) {
    const hints = {
      400: 'Check the credential fields and Information Recipient application setup.',
      401: 'Credentials or token were rejected. Verify that these are production credentials.',
      403: 'Access was denied. Check application permissions or throttling; do not retry repeatedly.',
      429: 'The service is rate limiting requests. Wait for its retry window before testing again.',
    };
    throw new Error(`${stage}: HTTP ${response.status}. ${hints[response.status] ?? 'The upstream service did not complete the request.'}`);
  }
  try { return await response.json(); }
  catch { throw new Error(`${stage}: expected a JSON response.`); }
}

export function records(payload, stage) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${stage}: no station records returned in batch 1.`);
  return rows;
}

export async function smokeTest({ clientId, clientSecret, fetchImpl = fetch, log = console.log }) {
  if (!clientId || !clientSecret) throw new Error('Fill in FUEL_FINDER_CLIENT_ID and FUEL_FINDER_CLIENT_SECRET in .secrets.env.');
  const auth = await request(fetchImpl, '/api/v1/oauth/generate_access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  }, 'OAuth');
  const token = auth?.data?.access_token;
  if (auth?.success === false || typeof token !== 'string' || !token) throw new Error('OAuth: no usable access token was returned.');
  log('OAuth authentication succeeded. Token retained in memory only.');
  const options = { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
  // Reuse the same token; do not authenticate again for each GET.
  const prices = records(await request(fetchImpl, '/api/v1/pfs/fuel-prices?batch-number=1', options, 'Fuel prices'), 'Fuel prices');
  log(`Fuel prices: ${prices.length} station records returned in batch 1.`);
  if (!prices.some(row => typeof row?.node_id === 'string' && Array.isArray(row.fuel_prices)
    && row.fuel_prices.some(price => price?.price != null && price.price !== '' && Number.isFinite(Number(price.price)) && Number(price.price) > 0))) {
    throw new Error('Fuel prices: records were returned, but no usable price was found.');
  }
  const sites = records(await request(fetchImpl, '/api/v1/pfs?batch-number=1', options, 'Forecourt details'), 'Forecourt details');
  log(`Forecourt details: ${sites.length} station records returned in batch 1.`);
  const byId = new Map(sites.map(site => [site.node_id, site]));
  // A diagnostic sample in provider order, not a comparison or supplier ranking.
  const sample = prices.slice(0, 3).map(row => {
    const site = byId.get(row.node_id);
    return {
      station: row.trading_name,
      ...(site?.location ? { postcode: site.location.postcode } : {}),
      prices: (row.fuel_prices ?? []).map(price => ({
        fuel: price.fuel_type,
        price: price.price,
        price_last_updated: price.price_last_updated,
        price_change_effective_timestamp: price.price_change_effective_timestamp,
      })),
    };
  });
  log(JSON.stringify({ diagnosticSample: sample }, null, 2));
  log(`Source: Fuel Finder. Contains public sector information licensed under the Open Government Licence v3.0. ${licenceUrl}`);
  log(`Report a discrepancy: ${reportUrl}`);
  log('Read-only smoke test passed. Batch 1 only; this is not a complete ingestion or a running production poller.');
  return { priceRecords: prices.length, forecourtRecords: sites.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    let local;
    try { local = parseEnv(await readFile(new URL('../.secrets.env', import.meta.url), 'utf8')); }
    catch { throw new Error('Could not read .secrets.env. Create it from .secrets.env.example.'); }
    await smokeTest({
      clientId: process.env.FUEL_FINDER_CLIENT_ID || local.FUEL_FINDER_CLIENT_ID,
      clientSecret: process.env.FUEL_FINDER_CLIENT_SECRET || local.FUEL_FINDER_CLIENT_SECRET,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
