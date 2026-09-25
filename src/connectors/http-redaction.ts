import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ConnectorHttpError } from "./http-transport";
import type { ConnectorHttpCode } from "../shared/connector-http-contracts";

const fingerprintSchema = z.object({ kind:z.enum(["transient","credential"]),length:z.number().int().min(1).max(16384),
  mac:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const RedactionSchema = z.object({ version:z.literal("c1.redaction.v1"),key:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  fingerprints:z.array(fingerprintSchema).min(1).max(256),seal:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type Redaction = z.infer<typeof RedactionSchema>;
const mac = (key: string,value: string,domain = "fingerprint") => createHmac("sha256",Buffer.from(key,"base64url"))
  .update(`c1.redaction.${domain}.v1\0`).update(value).digest("hex");
const seal = (r: Omit<Redaction,"seal">) => mac(r.key,JSON.stringify([r.version,r.fingerprints]),"seal");
const forms = (s: string) => {
  const values = [s];
  // JSON parsing normalizes numbers (including exponent notation/rounding).
  // Remember that primitive spelling too, without retaining the source value.
  try {
    const parsed: unknown = JSON.parse(s);
    if (parsed === null || typeof parsed === "number" || typeof parsed === "boolean") values.push(String(parsed));
  } catch { /* Opaque non-JSON credential. */ }
  return [...new Set(values.flatMap(v => [v,Buffer.from(v).toString("base64"),Buffer.from(v).toString("base64url")]))];
};
const invalid = () => new ConnectorHttpError("CONNECTOR_AUTH_FAILED");

/** Only this versioned section, never source transient strings, joins the tokens
 * in F5's one atomic encrypted Keychain payload. The independent random key is
 * unrelated to access/refresh/PKCE material. The seal detects corrupt sections. */
export function extendRedaction(previous: Redaction | null,kind: "transient" | "credential",values: string[]): Redaction {
  if (previous) validateRedaction(previous);
  const key = previous?.key ?? randomBytes(32).toString("base64url");
  const fingerprints = [...(previous?.fingerprints ?? [])];
  for (const value of values) for (const form of forms(value)) {
    if (!form.length) throw invalid();
    const fp = { kind,length:form.length,mac:mac(key,form) };
    if (!fingerprints.some(f => f.kind === fp.kind && f.length === fp.length && f.mac === fp.mac)) fingerprints.push(fp);
  }
  const body = { version:"c1.redaction.v1" as const,key,fingerprints };
  try { return RedactionSchema.parse({ ...body,seal:seal(body) }); } catch { throw invalid(); }
}
export function validateRedaction(raw: unknown): Redaction {
  try {
    const r = RedactionSchema.parse(raw);
    if (Buffer.from(r.key,"base64url").toString("base64url") !== r.key || !timingSafeEqual(Buffer.from(seal(r),"hex"),Buffer.from(r.seal,"hex"))) throw invalid();
    return r;
  } catch { throw invalid(); }
}
export function coversCredential(r: Redaction,value: string): boolean {
  return r.fingerprints.some(f => f.kind === "credential" && f.length === value.length && f.mac === mac(r.key,value));
}

/** Inspect parsed primitive VALUES AND KEYS before DTO stripping. Never compare
 * serialized JSON with unescaped secrets. Fingerprint matching also detects an
 * embedded secret; the original code/verifier need not survive the exchange.
 * JSON escapes, URI percent encoding and base64/base64url are relevant provider
 * reflection encodings, not arbitrary transforms. Work/depth are bounded and
 * overflow fails closed rather than publishing unchecked content. */
export class RedactionMatcher {
  private readonly groups = new Map<number,Set<string>>();
  private readonly seen = new Set<string>();
  private work = 0;
  constructor(private readonly section: Redaction,kind?: "transient" | "credential",
    private readonly code: ConnectorHttpCode = "CONNECTOR_DISCOVERY_INVALID") {
    validateRedaction(section);
    const add = (length: number,digest: string) => { const set = this.groups.get(length) ?? new Set<string>(); set.add(digest); this.groups.set(length,set); };
    for (const fp of section.fingerprints) if (!kind || fp.kind === kind) add(fp.length,fp.mac);
    // Even the internal key, MACs and section seal are forbidden egress data.
    for (const secret of [section.key,section.seal,...section.fingerprints.map(f => f.mac)])
      for (const form of forms(secret)) add(form.length,mac(section.key,form));
  }
  private fail(): never { throw new ConnectorHttpError(this.code); }
  private string(value: string) {
    const queue: { text:string; depth:number }[] = [{ text:value,depth:0 }];
    while (queue.length) {
      const { text,depth } = queue.pop()!;
      if (this.seen.has(text)) continue;
      this.seen.add(text);
      if (this.seen.size > 20000 || text.length > 262144) this.fail();
      for (const [length,digests] of this.groups) for (let offset = 0; offset+length <= text.length; offset++) {
        this.work += length;
        if (this.work > 4 * 1024 * 1024) this.fail();
        if (digests.has(mac(this.section.key,text.slice(offset,offset+length)))) this.fail();
      }
      const enqueue = (decoded: string) => {
        if (decoded !== text && !this.seen.has(decoded)) {
          if (depth >= 4 || queue.length >= 64) this.fail();
          queue.push({ text:decoded,depth:depth+1 });
        }
      };
      enqueue(text.replace(/\\u[0-9a-f]{4}|\\["\\/bfnrt]/gi,escape => {
        try { return JSON.parse(`"${escape}"`) as string; } catch { return escape; }
      }));
      enqueue(text.replace(/(?:%[0-9a-f]{2})+/gi,encoded => {
        try { return decodeURIComponent(encoded); } catch { return encoded; }
      }));
      for (const match of text.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)) {
        const bytes = Buffer.from(match[0],"base64"), decoded = bytes.toString("utf8");
        if (bytes.toString("base64url") === match[0].replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_")
          && Buffer.from(decoded).equals(bytes)) enqueue(decoded);
      }
    }
  }
  inspect(value: unknown): void {
    const queue: { value:unknown; depth:number }[] = [{ value,depth:0 }]; let nodes = 0;
    while (queue.length) {
      const { value,depth } = queue.pop()!;
      if (++nodes > 20000 || depth > 128) this.fail();
      if (typeof value === "string") this.string(value);
      else if (value === null || typeof value === "number" || typeof value === "boolean") this.string(String(value));
      else if (Array.isArray(value)) for (const child of value) queue.push({ value:child,depth:depth+1 });
      else if (value && typeof value === "object") for (const [key,child] of Object.entries(value)) {
        this.string(key); queue.push({ value:child,depth:depth+1 });
      }
    }
  }
}
