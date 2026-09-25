import { describe, expect, it } from "vitest";
import { ToolDefinitionSchema } from "../../shared/tool-registry-contracts";
import { ToolPlanningReviewSchema } from "../../shared/tool-invocation-contracts";
import { fileReadDynamicToolSpec, GOVERNED_FILE_READ_WIRE_NAME, governedRefusal, SessionGovernanceSchema } from "../../shared/governed-tool-contracts";
import { ToolRegistry, toolJson } from "../registry";
import { deterministicPlan } from "../../invocations/planning";
import { fileReadDefinition, fileReadImplementation, fileReadPlanner, normalizeFileReadPath, sensitiveContentReason, sensitivePathReason } from "./file-read";

const context = { org_id: "org", principal: { type: "user" as const, id: "u" }, project_id: "p" };

describe("EP1-B reviewed built-in file.read", () => {
  it.each([
    ["README.md", "README.md"], ["./src/index.ts", "src/index.ts"], ["././a/b.txt", "a/b.txt"], ["docs/guide.md", "docs/guide.md"],
    ["src/中文/文件.md", "src/中文/文件.md"],
  ])("normalizes %s to a logical /workspace claim", (raw, relative) => {
    expect(normalizeFileReadPath(raw)).toEqual({ ok: true, relative, segments: relative.split("/"), logical: `/workspace/${relative}` });
  });
  it.each(["", "/etc/passwd", "C:\\x", "C:/x", "~/x", "a\\b", "a/../b", "../a", "a/./b", "a//b", "a/", ".", "..", "a\0b", "a/b.", "a:b", "a?b", "a*b", "a%2e", "x".repeat(1025)])(
    "refuses invalid path %j", (raw) => { expect(normalizeFileReadPath(raw)).toEqual({ ok: false, code: "FILE_READ_PATH_INVALID" }); });
  it.each([".env", ".env.local", "config/.env.production", ".envrc", "src/.envrc", ".env_backup", ".environment", "deep/.ENVIRONMENT.md", ".netrc", ".pgpass", ".npmrc", ".pypirc", ".ssh/config", ".aws/credentials", ".gnupg/pubring.kbx",
    ".kube/config", ".docker/config.json", ".config/gh/hosts.yml", ".git/HEAD", ".git/objects/ab/cd", "certs/server.pem", "keys/id_rsa", "keys/id_ed25519.pub",
    "tls/site.crt", "tls/site.key", "store.p12", "store.pfx", "store.jks", "SECRETS.GPG", "backup.kdbx", "nested/.Git/config", ".ENV",
    "credentials", "config/credentials", "Credentials.json", ".git-credentials", "home/.pgpass_backup", ".htpasswd", ".boto", ".s3cfg", ".azure/config"])(
    "denies sensitive path %s", (raw) => { expect(normalizeFileReadPath(raw)).toEqual({ ok: false, code: "FILE_READ_SENSITIVE_PATH" }); });
  it.each(["environment.md", "env/config.yaml", ".config/other/file", "gh/hosts.yml", "keys.md", "src/git/helper.ts", "docs/.gitignore", "cert.md",
    "docs/credentials.md", "src/credentials-form.tsx", "deploy_key"])(
    "allows non-sensitive path %s", (raw) => { expect(normalizeFileReadPath(raw).ok).toBe(true); });
  it.each([
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n", "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
    "-----BEGIN EC PRIVATE KEY-----\n", "-----BEGIN DSA PRIVATE KEY-----\n", "-----BEGIN ENCRYPTED PRIVATE KEY-----\n",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\n", "# notes\n\nsome text\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n",
  ])("denies private-key content %j", (text) => { expect(sensitiveContentReason(text)).toBe("FILE_READ_SENSITIVE_PATH"); });
  it.each(["# hello\n", "", "-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    "ssh-ed25519 AAAAC3 user@host\n", "PRIVATE KEY handling is documented in docs/keys.md\n", "const marker = 'BEGIN PRIVATE KEY';\n"])(
    "allows non-key content %j", (text) => { expect(sensitiveContentReason(text)).toBeNull(); });
  // Review revision 6 (P1): common credential forms beyond private-key armour.
  it.each<[string, string]>([
    ["an AWS access key id", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n"],
    ["a bare AWS access key id in code", "const key = \"AKIAZZZZZZZZZZZZZZZZ\";\n"],
    ["a GitHub classic token", "export GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n"],
    ["a GitHub OAuth token", "token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n"],
    ["a GitHub fine-grained token", "GITHUB_TOKEN=github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijk\n"],
    ["a GitLab token", "GITLAB_TOKEN=glpat-ABCDEFGHIJKLMNOPQRST\n"],
    ["a JWT", "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c\n"],
    ["a PostgreSQL URI with a password", "DATABASE_URL=postgres://app:s3cr3t@db.internal:5432/app\n"],
    ["a MongoDB SRV URI with a password", "uri = \"mongodb+srv://reader:hunter2@cluster0.example.net/db\"\n"],
    ["a Redis URI with a password", "redis://default:p4ss@cache:6379/0\n"],
    ["an AMQP URI with a password", "broker: AMQP://guest:guest@rabbit/\n"],
    ["a secret buried in prose", "# Notes\n\nlots of text\n\n  key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij here\n"],
    // Review revision 7 (P1): password-only URIs and one bounded base64 rescan.
    ["a Redis URI with a password and no username", "REDIS_URL=redis://:p4ssw0rd@cache.internal:6379/0\n"],
    ["a PostgreSQL URI with a password and no username", "postgres://:hunter2@db/app\n"],
    ["a base64-wrapped OpenSSH private key", `TLS_PRIVATE_KEY_B64=${Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n").toString("base64")}\n`],
    ["a base64-wrapped RSA private key in YAML", `key: ${Buffer.from("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n").toString("base64")}\n`],
    ["a base64-wrapped connection URI", `DATABASE_URL_B64=${Buffer.from("postgres://app:s3cr3t@db.internal:5432/app").toString("base64")}\n`],
    ["a base64-wrapped GitHub token after ordinary base64", `${Buffer.from("just some ordinary configuration text here").toString("base64")}\n${Buffer.from("GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij").toString("base64")}\n`],
    // Review revision 8 (P1): a password containing ':' must still be a password.
    ["a Redis URI with no username and a colon in the password", "REDIS_URL=redis://:pa:ss@host\n"],
    ["a PostgreSQL URI with a colon in the password", "postgres://user:pa:ss@host/db\n"],
    ["a MongoDB SRV URI with several colons in the password", "uri = \"mongodb+srv://reader:a:b:c@cluster0.example.net/db\"\n"],
    ["an AMQP URI whose password ends in a colon", "broker: amqp://guest:p4ss:@rabbit:5672/\n"],
    ["a base64-wrapped URI with a colon in the password", `REDIS_URL_B64=${Buffer.from("redis://:pa:ss@cache.internal:6379/0").toString("base64")}\n`],
  ])("denies content carrying %s", (_label, text) => { expect(sensitiveContentReason(text)).toBe("FILE_READ_SENSITIVE_PATH"); });
  it.each<[string, string]>([
    ["a URL without credentials", "See https://example.com:8080/docs/path?x=1 and http://user@host/path\n"],
    ["a scp-style git remote", "origin git@github.com:org/repo.git\n"],
    ["a file URL", "open file:///Users/me/project/README.md\n"],
    ["a base64 blob without three segments", "data: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV\n"],
    ["a two-segment base64 pair", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0\n"],
    ["a dotted version-like string", "eyJ.eyJ.sig and 1.2.3 are not tokens\n"],
    ["an AWS-looking prefix of the wrong length", "AKIA1234 and AKIAIOSFODNN7EXAMPLE0 are not key ids\n"],
    ["a GitHub prefix with the wrong length", "ghp_short and github_pat_tooshort\n"],
    ["a GitLab prefix with the wrong length", "glpat-short\n"],
    ["prose mentioning the vendors", "Rotate the AWS access key, the GitHub token and the GitLab token monthly.\n"],
    ["ordinary source code", "export const answer = 42;\nconst url = new URL(\"https://api.example.com/v1\");\n"],
    ["an env example without values", "DATABASE_URL=\nGITHUB_TOKEN=\n"],
    // Review revision 7: the base64 rescan must not misfire on ordinary encoded text.
    ["a long base64 blob decoding to ordinary text", `payload: ${Buffer.from("The quick brown fox jumps over the lazy dog. ".repeat(6)).toString("base64")}\n`],
    ["a base64 blob decoding to a credential-free URL", `${Buffer.from("visit https://example.com:8080/docs?x=1 and http://user@host/path today").toString("base64")}\n`],
    ["a base64 blob that is not UTF-8 when decoded", `${Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x28, 0x8c, 0x28, 0xff, 0xff, 0xfe, 0xfe, 0xc0, 0xaf, 0xe0, 0x80, 0xaf, 0xf8, 0x88, 0x80, 0x80, 0x80, 0xff, 0xff, 0xc1, 0xbf]).toString("base64")}\n`],
    ["a sha256 hex digest", "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n"],
    ["a scheme with an empty password", "postgres://app:@db/app and redis://:@cache/0\n"],
    ["a very long base64 run of ordinary text with a stray marker word", `${Buffer.from("PRIVATE KEY rotation is documented in docs/keys.md; the -----BEGIN CERTIFICATE----- block is public.").toString("base64")}\n`],
    // Review revision 8: the wider password class must not misfire on ports or IPv6 hosts without credentials.
    ["a URL with a port, a colon-bearing path and no credentials", "http://host:8080/a:b/c?ref=x:y\n"],
    ["an IPv6 URL with a port and no credentials", "listen on http://[::1]:8080/path and redis://[fe80::1]:6379/0\n"],
    ["a port followed by an unrelated mailto address on the same line", "http://host:8080 then mailto:ops@example.com\n"],
    // Review revision 9: the password class must not run across a query string or fragment.
    ["a URL with a port and a query string carrying a time and an e-mail address", "http://host:8080?at=12:30&email=ops@example.com\n"],
    ["a URL with a port and a fragment carrying a colon and an e-mail address", "https://host:8443#note:ops@example.com\n"],
    ["a URL with a query string carrying a mailto address and no credentials", "https://example.com?next=mailto:ops@example.com\n"],
    ["a URL with a fragment carrying a colon-bearing address and no credentials", "https://example.com/docs#contact:ops@example.com\n"],
    ["a base64 blob decoding to a URL with a query string carrying an e-mail address", `${Buffer.from("http://host:8080?at=12:30&email=ops@example.com").toString("base64")}\n`],
  ])("allows %s", (_label, text) => { expect(sensitiveContentReason(text)).toBeNull(); });
  it("bounds the base64 rescan to the first candidates so a pathological file costs linear time", () => {
    const filler = `${Buffer.from("ordinary text that is long enough to be a base64 candidate here").toString("base64")}\n`;
    const secret = `${Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n").toString("base64")}\n`;
    expect(sensitiveContentReason(filler.repeat(10) + secret)).toBe("FILE_READ_SENSITIVE_PATH");
    // Beyond the bound the rescan stops: a documented v1 limitation, not a promise of completeness.
    expect(sensitiveContentReason(filler.repeat(200) + secret)).toBeNull();
    const started = performance.now();
    expect(sensitiveContentReason(filler.repeat(4000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });
  it("evaluates sensitivity on every segment", () => {
    expect(sensitivePathReason(["src", "index.ts"])).toBeNull();
    expect(sensitivePathReason(["src", ".ssh", "x"])).toBe("FILE_READ_SENSITIVE_PATH");
    expect(sensitivePathReason([".config", "gh"])).toBe("FILE_READ_SENSITIVE_PATH");
    expect(sensitivePathReason([".config", "other"])).toBeNull();
  });
  it("plans deterministically through the T2 planner guard and refuses bad arguments", () => {
    const plan = deterministicPlan(fileReadPlanner, { arguments: { path: "./src/a.ts" }, scope: { workspace_dir: "/workspace" } });
    expect(plan).toEqual({ arguments: { path: "src/a.ts" }, claims: [{ type: "workspace_path", value: "/workspace/src/a.ts", mode: "read" }] });
    for (const args of [{}, { path: 1 }, { path: "a", extra: true }, { path: "../x" }, { path: ".env" }])
      expect(() => deterministicPlan(fileReadPlanner, { arguments: args as Record<string, unknown>, scope: {} })).toThrow("TOOL_PLAN_INVALID");
    expect(() => fileReadPlanner({ arguments: { path: ".env" }, scope: {} })).toThrow("FILE_READ_SENSITIVE_PATH");
    expect(() => fileReadPlanner({ arguments: { path: "/abs" }, scope: {} })).toThrow("FILE_READ_PATH_INVALID");
    expect(() => fileReadPlanner({ arguments: {}, scope: {} })).toThrow("FILE_READ_ARGUMENTS_INVALID");
  });
  it("declares a valid T1 definition, review and wire spec without a dot in the Codex name", () => {
    const definition = fileReadDefinition(context, "toolset-1");
    expect(ToolDefinitionSchema.parse(definition)).toEqual(definition);
    expect(definition.name).toBe("file.read");
    const implementation = fileReadImplementation(context, "toolset-1", () => { throw new Error("adapter must not run here"); });
    expect(ToolPlanningReviewSchema.parse(implementation.planningReview)).toEqual({ version: "file-read-plan-v1", effect: "read_only", resourceKind: "logical_workspace_path" });
    const registry = new ToolRegistry(); registry.register(implementation);
    expect(toolJson(registry.get(context, definition.connectorId, definition.connectionId, "file.read"))).toBe(toolJson(definition));
    const spec = fileReadDynamicToolSpec();
    expect(spec.name).toBe(GOVERNED_FILE_READ_WIRE_NAME);
    expect(spec.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(spec.inputSchema).toEqual(definition.parameters);
  });
  it("redacts refusals to a closed code and fixed text", () => {
    expect(governedRefusal("FILE_READ_SENSITIVE_PATH")).toEqual({ success: false, contentItems: [{ type: "inputText", text: expect.stringMatching(/^FILE_READ_SENSITIVE_PATH: /) }] });
    expect(governedRefusal("EXECUTION_OWNER_STALE").contentItems[0].text).toContain("start a new session");
    expect(() => governedRefusal("/Users/robin/secret")).toThrow();
    expect(() => governedRefusal("lower_case")).toThrow();
    expect(SessionGovernanceSchema.safeParse({ attemptId: "a", threadId: "t", tools: ["file.read"], declaredAt: "2026-09-15T00:00:00.000Z" }).success).toBe(true);
    expect(SessionGovernanceSchema.safeParse({ attemptId: "a", threadId: "t", tools: ["bash"], declaredAt: "2026-09-15T00:00:00.000Z" }).success).toBe(false);
  });
});
