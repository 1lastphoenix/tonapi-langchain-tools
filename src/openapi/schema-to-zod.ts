import { z } from "zod";

import { OpenApiReferenceResolver } from "./ref-resolver.js";
import type { OpenApiSchema, ReferenceObject } from "./types.js";
import { isReferenceObject } from "./types.js";

export class OpenApiSchemaToZodConverter {
  private readonly resolvingRefs = new Set<string>();

  public constructor(private readonly resolver: OpenApiReferenceResolver) {}

  public toZod(schemaLike: OpenApiSchema | ReferenceObject | undefined): z.ZodTypeAny {
    if (schemaLike === undefined) {
      return z.any();
    }
    const schema = this.resolveSchema(schemaLike);
    return this.withMetadata(this.mapSchema(schema), schema);
  }

  private resolveSchema(schemaLike: OpenApiSchema | ReferenceObject): OpenApiSchema {
    if (!isReferenceObject(schemaLike)) {
      return schemaLike;
    }

    if (this.resolvingRefs.has(schemaLike.$ref)) {
      return {
        type: "object",
        additionalProperties: true,
        description: `Recursive OpenAPI reference ${schemaLike.$ref}`
      };
    }

    this.resolvingRefs.add(schemaLike.$ref);
    const resolved = this.resolver.resolveRef<OpenApiSchema | ReferenceObject>(schemaLike.$ref);
    const schema = this.resolveSchema(resolved);
    this.resolvingRefs.delete(schemaLike.$ref);
    return schema;
  }

  private mapSchema(schema: OpenApiSchema): z.ZodTypeAny {
    if (schema.oneOf && schema.oneOf.length > 0) {
      return this.unionFrom(schema.oneOf.map((entry) => this.toZod(entry)));
    }
    if (schema.anyOf && schema.anyOf.length > 0) {
      return this.unionFrom(schema.anyOf.map((entry) => this.toZod(entry)));
    }
    if (schema.allOf && schema.allOf.length > 0) {
      return this.intersectionFrom(schema.allOf.map((entry) => this.toZod(entry)));
    }
    if (schema.enum && schema.enum.length > 0) {
      return this.literalUnion(schema.enum);
    }

    const inferredType = schema.type ?? inferSchemaType(schema);
    switch (inferredType) {
      case "string":
        return this.mapString(schema);
      case "number":
        return this.mapNumber(schema);
      case "integer":
        return this.mapInteger(schema);
      case "boolean":
        return z.boolean();
      case "array":
        return this.mapArray(schema);
      case "object":
        return this.mapObject(schema);
      case "null":
        return z.null();
      default:
        return z.any();
    }
  }

  private mapString(schema: OpenApiSchema): z.ZodTypeAny {
    let stringSchema = z.string();
    if (typeof schema.minLength === "number") {
      stringSchema = stringSchema.min(schema.minLength);
    }
    if (typeof schema.maxLength === "number") {
      stringSchema = stringSchema.max(schema.maxLength);
    }
    if (schema.pattern) {
      try {
        stringSchema = stringSchema.regex(new RegExp(schema.pattern));
      } catch {
        // Ignore invalid regex patterns in spec and keep schema usable.
      }
    }
    return stringSchema;
  }

  private mapNumber(schema: OpenApiSchema): z.ZodTypeAny {
    let numberSchema = z.number();
    if (typeof schema.minimum === "number") {
      numberSchema = numberSchema.min(schema.minimum);
    }
    if (typeof schema.maximum === "number") {
      numberSchema = numberSchema.max(schema.maximum);
    }
    return numberSchema;
  }

  private mapInteger(schema: OpenApiSchema): z.ZodTypeAny {
    const isBigIntLike = schema.format === "int64" || schema["x-js-format"] === "bigint";
    if (isBigIntLike) {
      return z.union([z.number().int(), z.string(), z.bigint()]);
    }

    let integerSchema = z.number().int();
    if (typeof schema.minimum === "number") {
      integerSchema = integerSchema.min(schema.minimum);
    }
    if (typeof schema.maximum === "number") {
      integerSchema = integerSchema.max(schema.maximum);
    }
    return integerSchema;
  }

  private mapArray(schema: OpenApiSchema): z.ZodTypeAny {
    let arraySchema = z.array(this.toZod(schema.items));
    if (typeof schema.minItems === "number") {
      arraySchema = arraySchema.min(schema.minItems);
    }
    if (typeof schema.maxItems === "number") {
      arraySchema = arraySchema.max(schema.maxItems);
    }
    return arraySchema;
  }

  private mapObject(schema: OpenApiSchema): z.ZodTypeAny {
    const requiredKeys = new Set(schema.required ?? []);
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      let mapped = this.toZod(propertySchema);
      if (!requiredKeys.has(key)) {
        mapped = mapped.optional();
      }
      shape[key] = mapped;
    }

    let objectSchema = z.object(shape);
    if (schema.additionalProperties === true) {
      objectSchema = objectSchema.catchall(z.any());
    } else if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      objectSchema = objectSchema.catchall(this.toZod(schema.additionalProperties));
    } else {
      objectSchema = objectSchema.strict();
    }
    return objectSchema;
  }

  private unionFrom(parts: z.ZodTypeAny[]): z.ZodTypeAny {
    if (parts.length === 0) {
      return z.never();
    }
    if (parts.length === 1) {
      return parts[0]!;
    }
    const first = parts[0]!;
    const second = parts[1]!;
    const rest = parts.slice(2);
    return z.union([first, second, ...rest]);
  }

  private intersectionFrom(parts: z.ZodTypeAny[]): z.ZodTypeAny {
    if (parts.length === 0) {
      return z.any();
    }
    const [first, ...rest] = parts;
    let result = first!;
    for (const current of rest) {
      result = z.intersection(result, current);
    }
    return result;
  }

  private literalUnion(values: Array<string | number | boolean | null>): z.ZodTypeAny {
    const literals = values.map((value) => z.literal(value));
    if (literals.length === 1) {
      return literals[0]!;
    }
    const first = literals[0]!;
    const second = literals[1]!;
    const rest = literals.slice(2);
    return z.union([first, second, ...rest]);
  }

  private withMetadata(schema: z.ZodTypeAny, source: OpenApiSchema): z.ZodTypeAny {
    let enrichedSchema = schema;
    if (source.description) {
      enrichedSchema = enrichedSchema.describe(source.description);
    }
    if (source.nullable) {
      enrichedSchema = enrichedSchema.nullable();
    }
    return enrichedSchema;
  }
}

function inferSchemaType(schema: OpenApiSchema): OpenApiSchema["type"] | undefined {
  if (schema.properties || schema.additionalProperties) {
    return "object";
  }
  if (schema.items) {
    return "array";
  }
  if (schema.enum && schema.enum.length > 0) {
    const first = schema.enum[0];
    if (first === undefined) {
      return undefined;
    }
    if (typeof first === "string") {
      return "string";
    }
    if (typeof first === "number") {
      return Number.isInteger(first) ? "integer" : "number";
    }
    if (typeof first === "boolean") {
      return "boolean";
    }
    if (first === null) {
      return "null";
    }
  }
  return undefined;
}
