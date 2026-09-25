import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { ConnectorHttpCode } from "../shared/connector-http-contracts";

export class ConnectorHttpError extends Error {
  constructor(readonly code: ConnectorHttpCode) { super(code); }
}
const denied = () => new ConnectorHttpError("CONNECTOR_HTTP_DENIED");
/** Deliberately narrow public-address policy: IPv6 is denied until a reviewed
 * IPv6 route policy exists. No mapped IPv4, NAT64, link-local or DNS fallback. */
export function publicAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split(".").map(Number);
  return address !== "168.63.129.16" && !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export function endpointUrl(value: string): URL {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password || u.search || u.hash
      || value.length > 1000 || /[?#\s\\]/.test(value) || u.href !== value) throw denied();
    return u;
  } catch { throw denied(); }
}
export interface HttpResponse { status:number; headers:Record<string,string | string[] | undefined>; rawHeaders:string[]; body:string }
/** JSON-only C1 profile: no sniffing HTML, SSE or missing/ambiguous media types.
 * Parameters are restricted to UTF-8, which is also the actual body decoder. */
export function requireJson(response: HttpResponse): void {
  // IncomingMessage.headers discards duplicate Content-Type fields by default.
  // Validate the original field occurrences, never that lossy projection.
  const types: string[] = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2)
    if (response.rawHeaders[i].toLowerCase() === "content-type") types.push(response.rawHeaders[i+1]);
  // HTTP OWS is SP/HTAB only. Parameter name=value admits no whitespace
  // around '='; reject non-ASCII (including NBSP) before case-insensitive parsing.
  if (types.length !== 1 || /[^\t\x20-\x7e]/.test(types[0])
    || !/^[ \t]*application\/(?:json|json-rpc)(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?[ \t]*$/i.test(types[0]))
    throw new ConnectorHttpError("CONNECTOR_HTTP_FAILED");
}
/** Dependency injection is host construction only; no renderer controls DNS,
 * TLS, request options, allowlists or transport implementation. */
export interface HostHttpDependencies {
  resolve(host: string): Promise<{ address:string; family:number }[]>;
  request: typeof request;
}
const defaults: HostHttpDependencies = { resolve:(host) => lookup(host,{ all:true,verbatim:true }),request };
export class HostHttpTransport {
  constructor(private readonly io: HostHttpDependencies = defaults) {}
  async validate(value: string, allowed: readonly string[], signal: AbortSignal) {
    const url = endpointUrl(value);
    if (!allowed.includes(url.href)) throw denied();
    let rows;
    try {
      rows = await new Promise<{ address:string; family:number }[]>((resolve,reject) => {
        const abort = () => reject(new ConnectorHttpError("CONNECTOR_HTTP_TIMEOUT"));
        signal.addEventListener("abort",abort,{ once:true });
        if (signal.aborted) { abort(); return; }
        this.io.resolve(url.hostname).then(resolve,reject).finally(() => signal.removeEventListener("abort",abort));
      });
    } catch (e) { if (e instanceof ConnectorHttpError) throw e; throw denied(); }
    if (!rows.length || rows.some((r) => r.family !== 4 || !publicAddress(r.address))) throw denied();
    return { url,address:rows[0].address };
  }
  async post(value: string, allowed: readonly string[], body: string, headers: Record<string,string>, signal: AbortSignal,
    redirectHosts: readonly string[] = [],inspect?: (response: HttpResponse) => void): Promise<HttpResponse> {
    const origin = endpointUrl(value);
    let next = value;
    for (let hop = 0; hop <= 3; hop++) {
      const { url,address } = await this.validate(next,allowed,signal);
      if (url.origin !== origin.origin && !redirectHosts.includes(url.hostname)) throw denied();
      const response = await this.send(url,address,body,headers,signal);
      inspect?.(response);
      if ([301,302,303,307,308].includes(response.status)) {
        // Never rewrite a token POST to GET or forward secrets to an unreviewed URL.
        if (![307,308].includes(response.status) || typeof response.headers.location !== "string") throw denied();
        try { next = new URL(response.headers.location,url).href; } catch { throw denied(); }
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new ConnectorHttpError("CONNECTOR_HTTP_FAILED");
      return response;
    }
    throw denied();
  }
  /** Exact, static, read-only profile. DNS is pinned into TLS; redirects never
   * receive credentials. The caller's synchronous admission runs after DNS and
   * immediately before the first request dispatch. */
  async get(value:string,allowed:readonly string[],authorization:string|null,signal:AbortSignal,
    maxBytes:number,beforeDispatch:()=>void):Promise<HttpResponse> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>262144) throw denied();
    const {url,address}=await this.validate(value,allowed,signal);
    if (signal.aborted) throw new ConnectorHttpError("CONNECTOR_HTTP_TIMEOUT");
    beforeDispatch();
    if (signal.aborted) throw new ConnectorHttpError("CONNECTOR_HTTP_TIMEOUT");
    const response=await this.send(url,address,"",{
      accept:"application/json",...(authorization ? {authorization:`Bearer ${authorization}`} : {}),
    },signal,"GET",maxBytes);
    if (response.status<200 || response.status>=300) throw new ConnectorHttpError("CONNECTOR_HTTP_FAILED");
    requireJson(response);
    return response;
  }
  private send(url: URL,address: string,body: string,headers: Record<string,string>,signal: AbortSignal,
    method:"GET"|"POST"="POST",maxBytes=262144): Promise<HttpResponse> {
    return new Promise((resolve,reject) => {
      let done = false;
      const fail = () => { if (!done) { done = true; reject(new ConnectorHttpError(signal.aborted ? "CONNECTOR_HTTP_TIMEOUT" : "CONNECTOR_HTTP_FAILED")); } };
      try {
        const options: RequestOptions & { autoSelectFamily:boolean } = { method,agent:false,family:4,autoSelectFamily:false,
          rejectUnauthorized:true,signal,headers:{ ...headers,"content-length":Buffer.byteLength(body) },
          // Pin the validated address into the actual TLS dial; retain URL host for
          // certificate verification/SNI. Never perform a second unguarded lookup.
          lookup:(_host,_options,callback) => callback(null,address,4) };
        const req = this.io.request(url,options,(res) => {
          const chunks: Buffer[] = []; let size = 0;
          res.on("data",(chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { req.destroy(); fail(); } else chunks.push(chunk); });
          res.on("error",fail); res.on("aborted",fail);
          res.on("end",() => { if (!done) { done = true; resolve({ status:res.statusCode ?? 0,headers:res.headers,rawHeaders:[...res.rawHeaders],body:Buffer.concat(chunks).toString("utf8") }); } });
        });
        req.on("error",fail); req.end(body);
      } catch { fail(); }
    });
  }
}
