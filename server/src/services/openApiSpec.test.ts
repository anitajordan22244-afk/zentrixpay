import { describe, expect, it } from "vitest";
import {
  MAX_OPENAPI_SPEC_BYTES,
  MAX_OPENAPI_SPEC_DEPTH,
  OpenApiSpecError,
  OpenApiSpecTooLargeError,
  openApiSpecDepth,
  parseOpenApiSpec,
  publicOpenApiSpec,
} from "./openApiSpec";

const base = {
  openapi: "3.0.3",
  info: { title: "Weather", version: "1.0.0" },
  paths: { "/forecast": { get: { summary: "Forecast" } } },
};

describe("parseOpenApiSpec size and depth limits (#214)", () => {
  it("rejects a string document over the byte cap with a 413-typed error", () => {
    const huge = JSON.stringify({
      ...base,
      info: { title: "x".repeat(MAX_OPENAPI_SPEC_BYTES) },
    });
    let caught: unknown;
    try {
      parseOpenApiSpec(huge);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenApiSpecTooLargeError);
    expect((caught as OpenApiSpecTooLargeError).status).toBe(413);
  });

  it("rejects an object document whose serialized form is over the cap", () => {
    expect(() =>
      parseOpenApiSpec({ ...base, info: { title: "x".repeat(MAX_OPENAPI_SPEC_BYTES) } }),
    ).toThrow(OpenApiSpecTooLargeError);
  });

  it("rejects documents nested deeper than the depth limit (not a 413)", () => {
    let node: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < MAX_OPENAPI_SPEC_DEPTH + 5; i++) node = { next: node };
    const deep = { ...base, "x-deep": node };
    let caught: unknown;
    try {
      parseOpenApiSpec(deep);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenApiSpecError);
    expect(caught).not.toBeInstanceOf(OpenApiSpecTooLargeError);
  });

  it("accepts a document exactly at the depth limit", () => {
    let node: Record<string, unknown> = {};
    // base object (depth 1) + nested "x-deep" chain brings the total to the limit.
    for (let i = 0; i < MAX_OPENAPI_SPEC_DEPTH - 2; i++) node = { next: node };
    const atLimit = { ...base, "x-deep": node };
    expect(openApiSpecDepth(atLimit)).toBe(MAX_OPENAPI_SPEC_DEPTH);
    expect(() => parseOpenApiSpec(atLimit)).not.toThrow();
  });

  it("still rejects non-OpenAPI-3 documents", () => {
    expect(() => parseOpenApiSpec({ ...base, openapi: "2.0" })).toThrow(OpenApiSpecError);
  });
});

describe("publicOpenApiSpec never names the upstream (#214)", () => {
  const upstream = "https://internal.provider.example/v1";
  const stored = {
    ...base,
    servers: [{ url: upstream }],
    "x-upstream": upstream,
    info: { title: "Weather", version: "1.0.0", "x-origin": "https://internal.provider.example" },
    paths: {
      "/forecast": {
        "x-internal-host": "internal.provider.example",
        get: {
          summary: `Forecast via ${upstream}`,
          "x-debug-backend": "https://internal.provider.example/v1/debug",
          servers: [{ url: upstream }],
        },
      },
    },
  };

  it("points every server at the proxy and drops x- extensions", () => {
    const out = publicOpenApiSpec(stored, upstream, "https://gateway.example/api/7");
    const text = JSON.stringify(out);
    expect(text).not.toContain("internal.provider.example");
    expect(text).not.toContain("x-upstream");
    expect(text).not.toContain("x-internal-host");
    expect(text).not.toContain("x-debug-backend");
    expect(out.servers).toEqual([{ url: "https://gateway.example/api/7" }]);
  });

  it("keeps schema property names that happen to start with x-", () => {
    const withProp = {
      ...stored,
      components: {
        schemas: { Req: { type: "object", properties: { "x-request-id": { type: "string" } } } },
      },
    };
    const out = publicOpenApiSpec(withProp, upstream, "https://gateway.example/api/7");
    expect(out.components).toEqual(withProp.components);
  });
});
