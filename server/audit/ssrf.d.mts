// Type declarations for ssrf.mjs (ported from nula-lead-finder, kept as plain JS so its tests stay intact).
import type { LookupFunction } from 'node:net';

export declare const FETCH_DEFAULTS: {
  maxUrlLength: number;
  maxRedirects: number;
  timeoutMs: number;
  maxBytes: number;
};

export declare const USER_AGENT: string;

export type GuardCode =
  | 'invalid_url'
  | 'url_too_long'
  | 'invalid_scheme'
  | 'credentials'
  | 'port'
  | 'private_address'
  | 'dns'
  | 'timeout'
  | 'network'
  | 'invalid_redirect'
  | 'too_many_redirects';

export declare class GuardError extends Error {
  constructor(code: GuardCode, message: string);
  code: GuardCode;
}

export declare function parseIPv4(value: string): number[] | null;
export declare function expandIPv6(value: string): number[] | null;
export declare function isBlockedIPv4(parts: number[]): boolean;
export declare function isBlockedIPv6(hextets: number[]): boolean;
export declare function isBlockedAddress(address: string): boolean;
export declare function normaliseTargetUrl(raw: unknown, options?: { maxUrlLength?: number }): URL;

export type DnsLookup = (
  host: string,
  options: { all: true; verbatim: boolean },
) => Promise<{ address: string; family: number }[]>;

export declare function assertPublicHost(
  hostname: string,
  lookup?: DnsLookup,
): Promise<{ address: string; family: number }[]>;

export declare function createGuardedLookup(baseLookup?: unknown): LookupFunction;

export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined> | Headers;
  stream: AsyncIterable<Uint8Array | string> & { pipe?: unknown; destroy?: () => void };
}

export type Transport = (
  url: URL,
  options: { signal: AbortSignal; lookup: LookupFunction; headers: Record<string, string> },
) => Promise<TransportResponse>;

export declare function nodeTransport(
  url: URL,
  options: { signal?: AbortSignal; lookup?: LookupFunction; headers?: Record<string, string> },
): Promise<TransportResponse>;

export interface SafeFetchOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** 'html' reads only text/html bodies, 'text' any non-binary text, 'none' no body. */
  accept?: 'html' | 'text' | 'none';
  transport?: Transport;
  dnsLookup?: DnsLookup;
  connectLookup?: LookupFunction;
}

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  redirects: string[];
  contentType: string;
  body: string | null;
  bytes: number;
  truncated: boolean;
  skipped?: 'content-type';
}

export declare function safeFetch(rawUrl: string | URL, options?: SafeFetchOptions): Promise<SafeFetchResult>;
