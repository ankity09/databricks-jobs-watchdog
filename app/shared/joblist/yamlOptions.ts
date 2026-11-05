import { isScalar, type ParseOptions, type Tags } from "yaml";
import { PyFloat } from "./pyrepr";

const FLOAT_TAG = "tag:yaml.org,2002:float";

/**
 * Parse options that match PyYAML for the job list: YAML 1.1 (so `yes` is true), merge keys,
 * big integers as bigint, and floats with no fraction (60.0) marked as PyFloat.
 */
export const pythonYamlOptions = {
  version: "1.1",
  merge: true,
  intAsBigInt: true,
  customTags: (tags: Tags): Tags =>
    tags.map((tag) => {
      if (typeof tag === "string" || tag.tag !== FLOAT_TAG || tag.collection) return tag;
      const original = tag.resolve.bind(tag);
      return {
        ...tag,
        resolve: (value: string, onError: (message: string) => void, options: ParseOptions) => {
          const resolved: unknown = original(value, onError, options);
          if (typeof resolved === "number" && Number.isInteger(resolved)) return new PyFloat(resolved);
          // the float tags return a node whose value is the number
          if (isScalar(resolved) && typeof resolved.value === "number" && Number.isInteger(resolved.value)) {
            resolved.value = new PyFloat(resolved.value);
          }
          return resolved;
        },
      };
    }),
} as const;
