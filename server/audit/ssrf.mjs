// SSRF guard + bounded fetch for the website audit.
//
// Layers of protection:
//  1. URL validation: http/https only, max length, no credentials, default
//     ports only, no single-label / local hostnames. The WHATWG URL parser
//     normalises odd IP encodings (decimal, hex, octal, short forms) before
//     the IP check, so http://2130706433/ is treated as 127.0.0.1.
//  2. DNS check before every hop: all resolved addresses must be public.
//  3. Connect-time check: the socket's own DNS lookup goes through
//     createGuardedLookup(), so a DNS answer that changes between the check
//     and the connection (DNS rebinding) is still rejected.
//  4. Manual redirects (max 5), each hop validated again; overall timeout;
//     response body capped (after decompression); content-type filtering.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

export const FETCH_DEFAULTS = {
  maxUrlLength:2048,
  maxRedirects:5,
  timeoutMs:8000,
  maxBytes:2 * 1024 * 1024
};

export const USER_AGENT = 'Mozilla/5.0 (compatible; AIVisibilityChecker-Audit/1.0; +https://agencynula.com/)';

export class GuardError extends Error {
  constructor(code, message){
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

// --- IP classification -------------------------------------------------------

export function parseIPv4(value){
  if (!net.isIPv4(value)) return null;
  return value.split('.').map(Number);
}

/** Expand an IPv6 string (with optional zone id / embedded IPv4) to 8 hextets. */
export function expandIPv6(value){
  let str = String(value || '').replace(/^\[|\]$/g, '');
  str = str.split('%')[0];
  if (!net.isIPv6(str)) return null;
  const v4 = str.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4){
    const parts = parseIPv4(v4[1]);
    if (!parts) return null;
    str = str.slice(0, -v4[1].length) + ((parts[0] << 8) | parts[1]).toString(16) + ':' + ((parts[2] << 8) | parts[3]).toString(16);
  }
  const [head, tail] = str.includes('::') ? str.split('::') : [str, null];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === null && headParts.length !== 8) return null;
  if (missing < 0) return null;
  const all = [...headParts, ...Array(tail === null ? 0 : missing).fill('0'), ...tailParts];
  return all.map((h) => parseInt(h || '0', 16));
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([base, bits]) => [v4ToInt(parseIPv4(base)), bits]);

function v4ToInt(parts){
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function isBlockedIPv4(parts){
  const value = v4ToInt(parts);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function v6ToBig(hextets){
  return hextets.reduce((acc, h) => (acc << 16n) | BigInt(h), 0n);
}

const V6_BLOCKS = [
  ['::', 96],          // unspecified, loopback, deprecated IPv4-compatible
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64],       // discard-only
  ['2001::', 23],      // IETF protocol assignments (Teredo, benchmarking, ORCHID…)
  ['2001:db8::', 32],  // documentation
  ['fc00::', 7],       // unique local
  ['fe80::', 10],      // link-local
  ['fec0::', 10],      // deprecated site-local
  ['ff00::', 8]        // multicast
].map(([base, bits]) => [v6ToBig(expandIPv6(base)), bits]);

function inV6Block(big, base, bits){
  const shift = BigInt(128 - bits);
  return (big >> shift) === (base >> shift);
}

export function isBlockedIPv6(hextets){
  const big = v6ToBig(hextets);
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 well-known prefix (64:ff9b::/96): judge the embedded IPv4.
  const isMapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  const isNat64 = hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((h) => h === 0);
  if (isMapped || isNat64){
    return isBlockedIPv4([hextets[6] >> 8, hextets[6] & 255, hextets[7] >> 8, hextets[7] & 255]);
  }
  // 6to4 (2002::/16) embeds an IPv4 address in hextets 1–2.
  if (hextets[0] === 0x2002){
    return isBlockedIPv4([hextets[1] >> 8, hextets[1] & 255, hextets[2] >> 8, hextets[2] & 255]);
  }
  return V6_BLOCKS.some(([base, bits]) => inV6Block(big, base, bits));
}

/** true for anything that is not a public unicast address (invalid input included). */
export function isBlockedAddress(address){
  const v4 = parseIPv4(String(address || ''));
  if (v4) return isBlockedIPv4(v4);
  const v6 = expandIPv6(address);
  if (v6) return isBlockedIPv6(v6);
  return true;
}

// --- URL validation ------------------------------------------------------------

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp'];

export function normaliseTargetUrl(raw, {maxUrlLength = FETCH_DEFAULTS.maxUrlLength} = {}){
  if (typeof raw !== 'string') throw new GuardError('invalid_url', 'URL мора да биде текст.');
  let value = raw.trim();
  if (!value) throw new GuardError('invalid_url', 'Внеси URL.');
  if (value.length > maxUrlLength) throw new GuardError('url_too_long', `URL е подолг од ${maxUrlLength} знаци.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\]/.test(value)) throw new GuardError('invalid_url', 'URL содржи недозволени знаци.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try { url = new URL(value); } catch (_) { throw new GuardError('invalid_url', 'Невалиден URL.'); }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GuardError('invalid_scheme', 'Дозволени се само http и https адреси.');
  if (url.username || url.password) throw new GuardError('credentials', 'URL не смее да содржи корисничко име или лозинка.');
  if (url.port !== '') throw new GuardError('port', 'Дозволени се само стандардни портови (80/443).');
  if (url.href.length > maxUrlLength) throw new GuardError('url_too_long', `URL е подолг од ${maxUrlLength} знаци.`);

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new GuardError('invalid_url', 'Невалиден URL.');
  if (net.isIP(host)){
    if (isBlockedAddress(host)) throw new GuardError('private_address', 'Адресата е приватна или локална и не е дозволена.');
  } else {
    if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      throw new GuardError('private_address', 'Локални адреси не се дозволени.');
    }
    if (!host.includes('.')) throw new GuardError('invalid_url', 'Внеси целосен домен (пр. primer.mk).');
  }
  url.hash = '';
  return url;
}

// --- DNS checks ----------------------------------------------------------------

/** Resolve the hostname and require every address to be public. */
export async function assertPublicHost(hostname, lookup = dns.promises.lookup){
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (net.isIP(host)){
    if (isBlockedAddress(host)) throw new GuardError('private_address', 'Адресата е приватна или локална и не е дозволена.');
    return [{address:host, family:net.isIP(host)}];
  }
  let addresses;
  try {
    addresses = await lookup(host, {all:true, verbatim:true});
  } catch (_) {
    throw new GuardError('dns', 'Доменот не може да се пронајде (DNS).');
  }
  if (!Array.isArray(addresses) || !addresses.length) throw new GuardError('dns', 'Доменот не може да се пронајде (DNS).');
  if (addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new GuardError('private_address', 'Доменот покажува кон приватна или локална адреса.');
  }
  return addresses;
}

/** A net/http compatible lookup() that refuses private addresses at connect time. */
export function createGuardedLookup(baseLookup = dns.lookup){
  return function guardedLookup(hostname, options, callback){
    if (typeof options === 'function'){
      callback = options;
      options = {};
    }
    const opts = typeof options === 'number' ? {family:options} : (options || {});
    baseLookup(hostname, {...opts, all:true}, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{address:addresses, family:net.isIP(addresses)}];
      if (!list.length || list.some((entry) => isBlockedAddress(entry.address))){
        const err = new GuardError('private_address', 'Доменот покажува кон приватна или локална адреса.');
        return callback(err);
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

// --- transport -------------------------------------------------------------------

/** Default transport: node http/https with the guarded lookup and no keep-alive agent. */
export function nodeTransport(url, {signal, lookup, headers}){
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {method:'GET', headers, lookup, signal, agent:false}, (res) => {
      resolve({status:res.statusCode || 0, headers:res.headers, stream:res});
    });
    req.on('error', reject);
    req.end();
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function header(headers, name){
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : (value || '');
}

function destroy(stream){
  try { stream?.destroy?.(); } catch (_) { /* ignore */ }
}

function decompress(stream, encoding){
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return stream.pipe(zlib.createGunzip());
  if (enc === 'deflate') return stream.pipe(zlib.createInflate());
  if (enc === 'br') return stream.pipe(zlib.createBrotliDecompress());
  return stream;
}

async function readCapped(stream, maxBytes, signal){
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream){
    if (signal?.aborted) throw new GuardError('timeout', 'Истече времето за одговор.');
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (total + buf.length > maxBytes){
      chunks.push(buf.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  destroy(stream);
  return {buffer:Buffer.concat(chunks), bytes:total, truncated};
}

function decodeBody(buffer, contentType){
  const charset = (String(contentType).match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1] || 'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(buffer);
  } catch (_) {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

const ACCEPT_HEADERS = {
  html:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  text:'text/plain,application/xml,text/xml;q=0.9,*/*;q=0.5',
  none:'*/*'
};

/**
 * Fetch a public URL with SSRF protection.
 * options.accept: 'html' (only text/html bodies are read), 'text' (any non-binary text), 'none' (no body)
 * Returns {status, finalUrl, redirects[], contentType, body|null, bytes, truncated, skipped?}
 */
export async function safeFetch(rawUrl, options = {}){
  const {
    maxRedirects = FETCH_DEFAULTS.maxRedirects,
    timeoutMs = FETCH_DEFAULTS.timeoutMs,
    maxBytes = FETCH_DEFAULTS.maxBytes,
    accept = 'html',
    transport = nodeTransport,
    dnsLookup = dns.promises.lookup,
    connectLookup = createGuardedLookup()
  } = options;

  let url = rawUrl instanceof URL ? normaliseTargetUrl(rawUrl.href) : normaliseTargetUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const redirects = [url.href];

  try {
    for (let hop = 0; ; hop += 1){
      await assertPublicHost(url.hostname, dnsLookup);
      if (controller.signal.aborted) throw new GuardError('timeout', 'Истече времето за одговор.');
      const response = await transport(url, {
        signal:controller.signal,
        lookup:connectLookup,
        headers:{
          'User-Agent':USER_AGENT,
          'Accept':ACCEPT_HEADERS[accept] || ACCEPT_HEADERS.none,
          'Accept-Language':'mk,en;q=0.8',
          'Accept-Encoding':'gzip, deflate, br'
        }
      });

      const location = header(response.headers, 'location');
      if (REDIRECT_STATUSES.has(response.status) && location){
        destroy(response.stream);
        if (hop >= maxRedirects) throw new GuardError('too_many_redirects', `Повеќе од ${maxRedirects} пренасочувања.`);
        let next;
        try { next = new URL(location, url); } catch (_) { throw new GuardError('invalid_redirect', 'Невалидно пренасочување.'); }
        url = normaliseTargetUrl(next.href);
        redirects.push(url.href);
        continue;
      }

      const contentType = header(response.headers, 'content-type');
      const base = {status:response.status, finalUrl:url.href, redirects, contentType, body:null, bytes:0, truncated:false};
      if (accept === 'none'){
        destroy(response.stream);
        return base;
      }
      const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
      const isText = isHtml || /^text\/|xml|json/i.test(contentType) || !contentType;
      if ((accept === 'html' && !isHtml) || (accept === 'text' && !isText)){
        destroy(response.stream);
        return {...base, skipped:'content-type'};
      }
      const stream = decompress(response.stream, header(response.headers, 'content-encoding'));
      const {buffer, bytes, truncated} = await readCapped(stream, maxBytes, controller.signal);
      destroy(response.stream);
      return {...base, body:decodeBody(buffer, contentType), bytes, truncated};
    }
  } catch (error){
    if (error instanceof GuardError) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') throw new GuardError('timeout', 'Сајтот не одговори навреме.');
    if (error?.code === 'private_address') throw error;
    throw new GuardError('network', 'Сајтот не може да се вчита.');
  } finally {
    clearTimeout(timer);
  }
}
