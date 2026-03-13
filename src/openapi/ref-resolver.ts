import type { OpenApiDocument, ReferenceObject } from "./types.js";
import { isReferenceObject } from "./types.js";

const JSON_POINTER_PREFIX = "#/";

export class OpenApiReferenceResolver {
  public constructor(private readonly document: OpenApiDocument) {}

  public resolve<T>(value: T | ReferenceObject | undefined): T | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!isReferenceObject(value)) {
      return value;
    }
    return this.resolveRef<T>(value.$ref);
  }

  public resolveRef<T>(ref: string): T {
    return this.resolveRefInternal<T>(ref, new Set<string>());
  }

  private resolveRefInternal<T>(ref: string, visited: Set<string>): T {
    if (visited.has(ref)) {
      throw new Error(`Circular OpenAPI reference detected: ${ref}`);
    }
    visited.add(ref);

    const target = this.resolveJsonPointer(ref);
    if (isReferenceObject(target)) {
      return this.resolveRefInternal<T>(target.$ref, visited);
    }
    return target as T;
  }

  private resolveJsonPointer(ref: string): unknown {
    if (!ref.startsWith(JSON_POINTER_PREFIX)) {
      throw new Error(
        `Unsupported OpenAPI reference "${ref}". Only local references are supported.`
      );
    }

    const pointerSegments = ref
      .slice(JSON_POINTER_PREFIX.length)
      .split("/")
      .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

    let current: unknown = this.document;
    for (const segment of pointerSegments) {
      if (typeof current !== "object" || current === null || !(segment in current)) {
        throw new Error(`Unable to resolve OpenAPI reference: ${ref}`);
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }
}

