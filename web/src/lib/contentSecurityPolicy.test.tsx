import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, originOf } from "./contentSecurityPolicy";

function directive(policy: string, name: string): string[] {
  const found = policy.split("; ").find((d) => d.startsWith(`${name} `));
  if (!found) throw new Error(`missing ${name}`);
  return found.split(" ").slice(1);
}

describe("buildContentSecurityPolicy", () => {
  it("never allows inline or eval script", () => {
    const policy = buildContentSecurityPolicy({ apiBase: "https://api.example.com" });
    expect(directive(policy, "script-src")).toEqual(["'self'"]);
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("allows the configured API origin and the Stellar hosts in connect-src", () => {
    const policy = buildContentSecurityPolicy({ apiBase: "https://api.example.com/resources" });
    const connect = directive(policy, "connect-src");
    expect(connect).toContain("https://api.example.com");
    expect(connect).toContain("https://horizon.stellar.org");
    expect(connect).toContain("https://soroban-testnet.stellar.org");
    expect(connect).not.toContain("https://api.example.com/resources");
  });

  it("falls back to same-origin API when no base is configured", () => {
    const connect = directive(buildContentSecurityPolicy({}), "connect-src");
    expect(connect).toEqual([
      "'self'",
      "https://horizon.stellar.org",
      "https://horizon-testnet.stellar.org",
      "https://soroban.stellar.org",
      "https://soroban-testnet.stellar.org",
    ]);
  });

  it("adds the Sentry ingest origin only when a DSN is set", () => {
    const with_ = directive(
      buildContentSecurityPolicy({ sentryDsn: "https://key@o1.ingest.sentry.io/42" }),
      "connect-src",
    );
    expect(with_).toContain("https://o1.ingest.sentry.io");
    const without = directive(buildContentSecurityPolicy({}), "connect-src");
    expect(without.some((s) => s.includes("sentry"))).toBe(false);
  });

  it("blocks plugins and base-tag hijacking, and omits header-only directives", () => {
    const policy = buildContentSecurityPolicy({});
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(directive(policy, "base-uri")).toEqual(["'self'"]);
    expect(policy).not.toContain("frame-ancestors");
  });
});

describe("originOf", () => {
  it("rejects non-http schemes and malformed values", () => {
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("not a url")).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf("http://localhost:4021/x")).toBe("http://localhost:4021");
  });
});
