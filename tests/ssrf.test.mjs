import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {Readable} from 'node:stream';
import http from 'node:http';
import zlib from 'node:zlib';
import {
  isBlockedAddress, expandIPv6, normaliseTargetUrl, assertPublicHost,
  createGuardedLookup, safeFetch, nodeTransport, GuardError
} from '../server/audit/ssrf.mjs';

const PUBLIC_V4 = '93.184.215.14';

function fakeDns(map){
  return async (host) => {
    if (!(host in map)) throw Object.assign(new Error('ENOTFOUND'), {code:'ENOTFOUND'});
    return map[host].map((address) => ({address, family:address.includes(':') ? 6 : 4}));
  };
}

/** Transport mock: routes by URL href, returns a readable body. */
function fakeTransport(routes, calls = []){
  return async (url) => {
    calls.push(url.href);
    const route = routes[url.href];
    if (!route) throw new Error(`unexpected request ${url.href}`);
    const body = route.body ?? '';
    return {
      status:route.status ?? 200,
      headers:{'content-type':'text/html; charset=utf-8', ...(route.headers || {})},
      stream:Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)])
    };
  };
}

async function expectGuard(promise, code){
  await expect(promise).rejects.toBeInstanceOf(GuardError);
  await expect(promise).rejects.toMatchObject({code});
}

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '239.255.255.250',
    '255.255.255.255', '192.0.2.10', '198.18.0.1'
  ])('blocks private/special IPv4 %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '::1', '::', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2001:db8::1', '2001::1', '::127.0.0.1', '100::1'
  ])('blocks local/special IPv6 %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([PUBLIC_V4, '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2a00:1450:4017:80e::200e', '::ffff:8.8.8.8', '2002:0808:0808::1'])(
    'allows public %s', (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    });

  it('treats garbage as blocked', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });

  it('expands IPv6 forms', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIPv6('[2001:db8::]')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(expandIPv6('1.2.3.4')).toBeNull();
  });
});

describe('normaliseTargetUrl', () => {
  it('adds https:// to bare domains and drops the hash', () => {
    expect(normaliseTargetUrl('primer.mk/za-nas#tim').href).toBe('https://primer.mk/za-nas');
  });

  it.each([
    ['ftp://primer.mk/', 'invalid_scheme'],
    ['file:///etc/passwd', 'invalid_scheme'],
    ['javascript:alert(1)', 'invalid_url'],
    ['https://user:pass@primer.mk/', 'credentials'],
    ['https://primer.mk:8443/', 'port'],
    ['http://primer.mk:22/', 'port'],
    ['http://localhost/', 'private_address'],
    ['http://admin.localhost/', 'private_address'],
    ['http://printer.local/', 'private_address'],
    ['http://intranet/', 'invalid_url'],
    ['http://127.0.0.1/', 'private_address'],
    ['http://2130706433/', 'private_address'],     // decimal 127.0.0.1
    ['http://0x7f000001/', 'private_address'],     // hex
    ['http://0177.0.0.1/', 'private_address'],     // octal
    ['http://127.1/', 'private_address'],          // short form
    ['http://0/', 'private_address'],
    ['http://[::1]/', 'private_address'],
    ['http://[::ffff:127.0.0.1]/', 'private_address'],
    ['http://[fe80::1]/', 'private_address'],
    ['http://169.254.169.254/latest/meta-data/', 'private_address'],
    ['http://prim er.mk/', 'invalid_url'],
    ['http://primer.mk/\u0000', 'invalid_url'],
    ['', 'invalid_url']
  ])('rejects %s', (input, code) => {
    expect(() => normaliseTargetUrl(input)).toThrow(GuardError);
    try { normaliseTargetUrl(input); } catch (error){ expect(error.code).toBe(code); }
  });

  it('allows explicit default ports (normalised away)', () => {
    expect(normaliseTargetUrl('https://primer.mk:443/').href).toBe('https://primer.mk/');
    expect(normaliseTargetUrl('http://primer.mk:80/').href).toBe('http://primer.mk/');
  });

  it('rejects non-string and over-long input', () => {
    expect(() => normaliseTargetUrl(42)).toThrow(GuardError);
    expect(() => normaliseTargetUrl(`https://primer.mk/${'a'.repeat(2100)}`)).toThrow(/2048/);
  });
});

describe('assertPublicHost', () => {
  it('rejects hosts that resolve to a private address (any of them)', async () => {
    await expectGuard(assertPublicHost('rebind.example', fakeDns({'rebind.example':[PUBLIC_V4, '10.0.0.5']})), 'private_address');
    await expectGuard(assertPublicHost('v6.example', fakeDns({'v6.example':['::1']})), 'private_address');
  });

  it('rejects unknown hosts', async () => {
    await expectGuard(assertPublicHost('nope.example', fakeDns({})), 'dns');
  });

  it('accepts public hosts', async () => {
    await expect(assertPublicHost('ok.example', fakeDns({'ok.example':[PUBLIC_V4]}))).resolves.toHaveLength(1);
  });
});

describe('createGuardedLookup (connect-time check)', () => {
  const base = (answers) => (host, opts, cb) => cb(null, answers.map((address) => ({address, family:4})));

  it('refuses a private answer at connect time (DNS rebinding)', async () => {
    const lookup = createGuardedLookup(base(['127.0.0.1']));
    const error = await new Promise((resolve) => lookup('evil.example', {}, (err) => resolve(err)));
    expect(error).toBeInstanceOf(GuardError);
  });

  it('passes public answers through in both single and all modes', async () => {
    const lookup = createGuardedLookup(base([PUBLIC_V4]));
    const single = await new Promise((resolve) => lookup('ok.example', {}, (err, address, family) => resolve({err, address, family})));
    expect(single).toEqual({err:null, address:PUBLIC_V4, family:4});
    const all = await new Promise((resolve) => lookup('ok.example', {all:true}, (err, list) => resolve(list)));
    expect(all).toEqual([{address:PUBLIC_V4, family:4}]);
  });
});

describe('safeFetch', () => {
  const dnsLookup = fakeDns({'site.example':[PUBLIC_V4], 'www.site.example':[PUBLIC_V4], 'evil.example':['192.168.0.10']});

  it('follows redirects and returns the final HTML', async () => {
    const calls = [];
    const transport = fakeTransport({
      'http://site.example/':{status:301, headers:{location:'https://site.example/'}},
      'https://site.example/':{status:302, headers:{location:'/home'}},
      'https://site.example/home':{body:'<title>Здраво</title>'}
    }, calls);
    const result = await safeFetch('http://site.example/', {transport, dnsLookup});
    expect(result).toMatchObject({status:200, finalUrl:'https://site.example/home', body:'<title>Здраво</title>', truncated:false});
    expect(result.redirects).toEqual(['http://site.example/', 'https://site.example/', 'https://site.example/home']);
  });

  it('blocks a redirect to a private IP literal', async () => {
    const transport = fakeTransport({'https://site.example/':{status:302, headers:{location:'http://169.254.169.254/latest/meta-data/'}}});
    await expectGuard(safeFetch('https://site.example/', {transport, dnsLookup}), 'private_address');
  });

  it('blocks a redirect to a hostname that resolves privately', async () => {
    const calls = [];
    const transport = fakeTransport({'https://site.example/':{status:307, headers:{location:'https://evil.example/'}}}, calls);
    await expectGuard(safeFetch('https://site.example/', {transport, dnsLookup}), 'private_address');
    expect(calls).toEqual(['https://site.example/']);
  });

  it('blocks redirects to non-default ports, credentials and other schemes', async () => {
    for (const location of ['https://site.example:8080/', 'https://a:b@site.example/', 'file:///etc/passwd', 'gopher://site.example/']){
      const transport = fakeTransport({'https://site.example/':{status:301, headers:{location}}});
      await expect(safeFetch('https://site.example/', {transport, dnsLookup})).rejects.toBeInstanceOf(GuardError);
    }
  });

  it('stops after 5 redirects', async () => {
    const routes = {};
    for (let i = 0; i < 7; i += 1) routes[`https://site.example/${i}`] = {status:302, headers:{location:`/${i + 1}`}};
    await expectGuard(safeFetch('https://site.example/0', {transport:fakeTransport(routes), dnsLookup}), 'too_many_redirects');
  });

  it('caps the body size', async () => {
    const transport = fakeTransport({'https://site.example/':{body:'a'.repeat(5000)}});
    const result = await safeFetch('https://site.example/', {transport, dnsLookup, maxBytes:1000});
    expect(result).toMatchObject({bytes:1000, truncated:true});
    expect(result.body).toHaveLength(1000);
  });

  it('caps decompressed size (gzip bomb protection)', async () => {
    const gz = zlib.gzipSync(Buffer.alloc(200000, 'a'));
    const transport = fakeTransport({'https://site.example/':{body:gz, headers:{'content-encoding':'gzip'}}});
    const result = await safeFetch('https://site.example/', {transport, dnsLookup, maxBytes:4096});
    expect(result).toMatchObject({bytes:4096, truncated:true});
  });

  it('does not parse non-HTML responses in html mode', async () => {
    const transport = fakeTransport({'https://site.example/':{body:'%PDF', headers:{'content-type':'application/pdf'}}});
    const result = await safeFetch('https://site.example/', {transport, dnsLookup});
    expect(result).toMatchObject({body:null, skipped:'content-type'});
  });

  it('decodes windows-1251 pages', async () => {
    const body = Buffer.from([0xc7, 0xe4, 0xf0, 0xe0, 0xe2, 0xee]); // "Здраво" in cp1251
    const transport = fakeTransport({'https://site.example/':{body, headers:{'content-type':'text/html; charset=windows-1251'}}});
    const result = await safeFetch('https://site.example/', {transport, dnsLookup});
    expect(result.body).toBe('Здраво');
  });

  it('times out', async () => {
    const transport = (url, {signal}) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name:'AbortError'})));
    });
    await expectGuard(safeFetch('https://site.example/', {transport, dnsLookup, timeoutMs:30}), 'timeout');
  });

  it('maps transport failures to a generic network error without internals', async () => {
    const transport = async () => { throw new Error('connect ECONNREFUSED 93.184.215.14:443 secret-detail'); };
    const promise = safeFetch('https://site.example/', {transport, dnsLookup});
    await expectGuard(promise, 'network');
    await expect(promise).rejects.not.toThrow(/secret-detail/);
  });
});

describe('nodeTransport (real sockets against a local server)', () => {
  let server;
  let port;
  const base = (address) => (host, opts, cb) => cb(null, [{address, family:4}]);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect'){
        res.writeHead(302, {Location:'/gz'});
        return res.end();
      }
      if (req.url === '/gz'){
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Content-Encoding':'gzip'});
        return res.end(zlib.gzipSync('<title>Локален тест</title>'));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('the guarded lookup blocks the socket when DNS answers with loopback (rebinding)', async () => {
    const url = new URL(`http://rebind.example:${port}/gz`);
    await expect(nodeTransport(url, {lookup:createGuardedLookup(base('127.0.0.1')), headers:{}})).rejects.toBeInstanceOf(GuardError);
  });

  it('performs redirects and gzip decoding end-to-end over real HTTP', async () => {
    // Test-only plumbing: the public-looking host is mapped to the local server and the
    // random test port is re-applied, so the production guards stay unchanged.
    const transport = (url, opts) => {
      const local = new URL(url.href);
      local.port = String(port);
      return nodeTransport(local, {...opts, lookup:base('127.0.0.1')});
    };
    const result = await safeFetch('http://site.example/redirect', {
      transport,
      dnsLookup:fakeDns({'site.example':[PUBLIC_V4]})
    });
    expect(result).toMatchObject({status:200, finalUrl:'http://site.example/gz', body:'<title>Локален тест</title>'});
  });
});
