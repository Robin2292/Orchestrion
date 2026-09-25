import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { KeychainAdapter } from "../main/credentials/keychain";
import { StorageError, type SqliteFoundation, type SqliteUnit } from "../storage/sqlite/foundation";

const sha=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
const fail=(code:string):never=>{throw new StorageError(code);};
interface Envelope {v:1;n:string;c:string;t:string}

/** One host-only key for retained Direct context facts. Plaintext never reaches SQLite. */
export class DirectContextCrypto {
  constructor(private readonly store:SqliteFoundation,private readonly keychain:KeychainAdapter) {}
  private account(id:string) {return sha(JSON.stringify(["direct-context-v1",id]));}
  private check(id:string,key:Buffer) {
    return createHmac("sha256",key).update(JSON.stringify(["direct-context-key-check-v1",id])).digest();
  }
  private key():Buffer {
    const org=this.store.workspace.org_id;
    const existing=this.store.transaction(tx=>tx.get("SELECT key_id,key_check_hash FROM direct_context_keys WHERE org_id=?",org));
    if(existing) {
      const id=String(existing.key_id),key=this.keychain.read(this.account(id));
      if(!key||key.length!==32) {key?.fill(0);return fail("DIRECT_CONTEXT_KEY_UNAVAILABLE");}
      const expected=Buffer.from(String(existing.key_check_hash),"hex"),actual=this.check(id,key);
      if(expected.length!==32||!timingSafeEqual(expected,actual)) {key.fill(0);return fail("DIRECT_CONTEXT_KEY_UNAVAILABLE");}
      return key;
    }
    const retained=this.store.transaction(tx=>!!tx.get(`SELECT 1 FROM direct_context_facts WHERE org_id=? LIMIT 1`,org)
      ||!!tx.get(`SELECT 1 FROM direct_context_epochs WHERE org_id=? LIMIT 1`,org));
    if(retained)return fail("DIRECT_CONTEXT_KEY_UNAVAILABLE");
    const id=randomUUID(),account=this.account(id),generated=randomBytes(32);
    try {this.keychain.compareExchange(account,null,generated);}
    catch { /* Read back after uncertain CAS. */ }
    finally {generated.fill(0);}
    const key=this.keychain.read(account);
    if(!key||key.length!==32) {key?.fill(0);return fail("DIRECT_CONTEXT_KEY_UNAVAILABLE");}
    const check=this.check(id,key).toString("hex");
    const winner=this.store.transaction(tx=>{
      const row=tx.get("SELECT key_id,key_check_hash FROM direct_context_keys WHERE org_id=?",org);
      if(row)return {id:String(row.key_id),check:String(row.key_check_hash)};
      tx.run("INSERT INTO direct_context_keys VALUES (?,?,?)",org,id,check);
      return {id,check};
    });
    if(winner.id!==id) {key.fill(0);return this.key();}
    return key;
  }
  encrypt(text:string,aad:string):{cipher:string;hash:string} {
    const key=this.key(),nonce=randomBytes(12);
    try {
      const cipher=createCipheriv("aes-256-gcm",key,nonce);cipher.setAAD(Buffer.from(aad));
      const data=Buffer.concat([cipher.update(text,"utf8"),cipher.final()]);
      const envelope:Envelope={v:1,n:nonce.toString("base64"),c:data.toString("base64"),t:cipher.getAuthTag().toString("base64")};
      return {cipher:JSON.stringify(envelope),hash:sha(text)};
    } finally {key.fill(0);}
  }
  decrypt(cipherJson:string,aad:string,expectedHash:string):string {
    const key=this.key();
    try {
      const e=JSON.parse(cipherJson) as Envelope;
      if(e?.v!==1||typeof e.n!=="string"||typeof e.c!=="string"||typeof e.t!=="string"
        ||Object.keys(e).sort().join()!=="c,n,t,v")return fail("DIRECT_CONTEXT_CORRUPT");
      const nonce=Buffer.from(e.n,"base64"),tag=Buffer.from(e.t,"base64"),data=Buffer.from(e.c,"base64");
      if(nonce.length!==12||tag.length!==16||data.length>262144)return fail("DIRECT_CONTEXT_CORRUPT");
      const decipher=createDecipheriv("aes-256-gcm",key,nonce);decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(tag);
      const text=Buffer.concat([decipher.update(data),decipher.final()]).toString("utf8");
      if(sha(text)!==expectedHash)return fail("DIRECT_CONTEXT_CORRUPT");
      return text;
    } catch {return fail("DIRECT_CONTEXT_CORRUPT");}
    finally {key.fill(0);}
  }
}

export function contextFactAad(org:string,project:string,session:string,seq:number,kind:string,callId:string|null):string {
  return JSON.stringify(["direct-context-fact-v1",org,project,session,seq,kind,callId]);
}
export function contextEpochAad(org:string,project:string,session:string,epoch:number,sourceHash:string):string {
  return JSON.stringify(["direct-context-epoch-v1",org,project,session,epoch,sourceHash]);
}
export function contextKeyReady(tx:SqliteUnit,org:string):boolean {
  return !!tx.get("SELECT 1 FROM direct_context_keys WHERE org_id=?",org);
}
