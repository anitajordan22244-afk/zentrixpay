import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { apis } from "../db/schema.js";
import { config } from "../config.js";
import { validateUpstreamUrl } from "../lib/upstreamGuard.js";
import { parseOpenApiSpec, previewOpenApiImport, type OpenApiImportGroup } from "./openApiSpec.js";

export interface ImportDefaults {
  price: string;
  walletAddress: string;
  description?: string;
}

export interface ImportResult {
  imported: Array<{
    group: string;
    apiId: string;
    name: string;
    operations: number;
    idempotent: boolean;
  }>;
  skipped: string[];
}

export function previewBulkOpenApi(input: string | Record<string, unknown>) {
  return previewOpenApiImport(input);
}

export async function importBulkOpenApi(
  publisherId: string,
  input: string | Record<string, unknown>,
  selectedGroups: string[] | undefined,
  defaults: ImportDefaults,
): Promise<ImportResult> {
  const spec = parseOpenApiSpec(input);
  const preview = previewOpenApiImport(spec);
  if (preview.errors.length > 0) throw new Error(preview.errors.join("; "));
  const groups = preview.groups.filter(
    (group) => !selectedGroups || selectedGroups.includes(group.key),
  );
  if (groups.length === 0) return { imported: [], skipped: [] };
  for (const group of groups)
    validateUpstreamUrl(group.serverUrl, {
      allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
      field: `groups.${group.key}.serverUrl`,
    });

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: apis.id, name: apis.name, upstreamUrl: apis.upstreamUrl })
      .from(apis)
      .where(
        and(
          eq(apis.publisherId, publisherId),
          inArray(
            apis.name,
            groups.map((group) => group.name),
          ),
        ),
      );
    const existingKeys = new Set(existing.map((row) => `${row.name}\u0000${row.upstreamUrl}`));
    const imported: ImportResult["imported"] = [];
    const skipped: string[] = [];
    for (const group of groups) {
      const key = `${group.name}\u0000${group.serverUrl}`;
      const duplicate = existing.find((row) => `${row.name}\u0000${row.upstreamUrl}` === key);
      if (duplicate || existingKeys.has(key)) {
        skipped.push(group.key);
        continue;
      }
      const [row] = await tx
        .insert(apis)
        .values({
          publisherId,
          name: group.name,
          description: defaults.description ?? null,
          upstreamUrl: group.serverUrl,
          price: defaults.price,
          priceRules: [],
          walletAddress: defaults.walletAddress,
          allowedMethods: [...new Set(group.operations.map((operation) => operation.method))],
          payerDenylist: [],
          openapiSpec: group.spec,
          tags: group.tags,
          ownershipToken: randomBytes(16).toString("hex"),
          listed: false,
        })
        .returning({ id: apis.id, name: apis.name });
      imported.push({
        group: group.key,
        apiId: row.id,
        name: row.name,
        operations: group.operations.length,
        idempotent: false,
      });
    }
    return { imported, skipped };
  });
}

export type { OpenApiImportGroup };
