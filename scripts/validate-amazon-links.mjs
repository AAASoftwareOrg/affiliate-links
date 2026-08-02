#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_FILE = 'affiliate-links.json';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 15_000;
const AMAZON_HOST = /(^|\.)(amazon\.[a-z.]+|amzn\.to)$/i;

export function findAmazonLinks(value, path = '$', found = new Map()) {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && AMAZON_HOST.test(url.hostname)) {
        const locations = found.get(value) ?? [];
        locations.push(path);
        found.set(value, locations);
      }
    } catch {
      // Non-URL strings are expected throughout the document.
    }
    return found;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => findAmazonLinks(item, `${path}[${index}]`, found));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      findAmazonLinks(item, `${path}.${key}`, found);
    });
  }
  return found;
}

export function classifyAmazonPage(response, html) {
  const finalUrl = response.url || '';
  let finalHost;
  try {
    finalHost = new URL(finalUrl).hostname;
  } catch {
    return { status: 'unverifiable', reason: 'redirected to an invalid URL' };
  }

  if (!AMAZON_HOST.test(finalHost)) {
    return { status: 'unverifiable', reason: `redirected outside Amazon (${finalHost})` };
  }
  if (!response.ok) {
    return { status: 'unverifiable', reason: `HTTP ${response.status}` };
  }

  const text = html.toLowerCase();
  if (/captcha|enter the characters you see below|sorry[^<]{0,80}automated requests|robot check/.test(text)) {
    return { status: 'unverifiable', reason: 'Amazon returned a bot/CAPTCHA page' };
  }
  if (/amazon dog page|page not found|the web address you entered is not a functioning page/.test(text)) {
    return { status: 'unavailable', reason: 'product page was not found' };
  }

  const hasPurchaseControl = /id=["'](?:add-to-cart-button|buy-now-button)["']|name=["']submit\.(?:add-to-cart|buy-now)["']/.test(text);
  // Amazon includes generic unavailable strings in scripts for every page. Only
  // consider them when rendered near the primary product availability element.
  const availabilityArea = text.match(/id=["']availability(?:insidebuybox)?["'][\s\S]{0,3000}/)?.[0] ?? '';
  const unavailable = [
    'currently unavailable',
    'temporarily out of stock',
    'no featured offers available',
    'this item is no longer available',
    'we don\'t know when or if this item will be back in stock',
  ].some((phrase) => availabilityArea.includes(phrase));

  if (hasPurchaseControl) return { status: 'purchasable', reason: 'purchase control is present' };
  if (unavailable) return { status: 'unavailable', reason: 'Amazon says it is unavailable or out of stock' };
  return { status: 'unverifiable', reason: 'page loaded, but no enabled purchase control was found' };
}

async function checkLink(url, { timeoutMs, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/127 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const html = await response.text();
    return { url, finalUrl: response.url, httpStatus: response.status, ...classifyAmazonPage(response, html) };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error.message;
    return { url, status: 'unverifiable', reason };
  } finally {
    clearTimeout(timer);
  }
}

async function mapConcurrent(items, concurrency, mapper, onResult) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
      onResult?.(results[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function parseArgs(argv) {
  const options = { file: DEFAULT_FILE, concurrency: DEFAULT_CONCURRENCY, timeoutMs: DEFAULT_TIMEOUT_MS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--file') options.file = argv[++i];
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.file) throw new Error('--file requires a path');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error('--timeout must be a positive number of milliseconds');
  return options;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: node scripts/validate-amazon-links.mjs [--file PATH] [--concurrency N] [--timeout MS] [--json]');
    return 0;
  }

  const document = JSON.parse(await readFile(options.file, 'utf8'));
  const links = findAmazonLinks(document);
  const entries = [...links].map(([url, locations]) => ({ url, locations }));
  let completed = 0;
  if (!options.json) console.log(`Checking ${entries.length} unique Amazon links...\n`);
  const printResult = options.json ? undefined : (result) => {
    completed++;
    const icon = result.status === 'purchasable' ? 'PASS' : result.status === 'unavailable' ? 'FAIL' : 'UNKNOWN';
    console.log(`[${completed}/${entries.length}] ${icon.padEnd(7)} ${result.url} — ${result.reason}`);
    if (result.status !== 'purchasable') console.log(`            ${result.locations.join(', ')}`);
  };
  const results = await mapConcurrent(
    entries,
    options.concurrency,
    async (entry) => ({ ...(await checkLink(entry.url, options)), locations: entry.locations }),
    printResult,
  );
  const counts = Object.fromEntries(['purchasable', 'unavailable', 'unverifiable'].map((status) => [status, results.filter((r) => r.status === status).length]));

  if (options.json) {
    console.log(JSON.stringify({ file: options.file, uniqueLinks: results.length, counts, results }, null, 2));
  } else {
    console.log(`\nChecked ${results.length} unique Amazon links: ${counts.purchasable} purchasable, ${counts.unavailable} unavailable, ${counts.unverifiable} unverifiable.`);
    const printSummary = (title, status) => {
      const matching = results.filter((result) => result.status === status);
      if (matching.length === 0) return;
      console.log(`\n${title} (${matching.length})`);
      matching.forEach((result, index) => {
        console.log(`${index + 1}. ${result.url}`);
        console.log(`   Reason: ${result.reason}`);
        console.log(`   JSON: ${result.locations.join(', ')}`);
      });
    };
    printSummary('Unavailable — replace these links', 'unavailable');
    printSummary('Unverifiable — review these links', 'unverifiable');
  }
  return counts.unavailable === 0 && counts.unverifiable === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(`Amazon link validation failed: ${error.message}`);
    process.exitCode = 2;
  }
}
