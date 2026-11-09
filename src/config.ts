import { z } from "zod";

const booleanEnv = z.enum(["true", "false"]).default("false").transform(value => value === "true");
const environmentSchema = z.object({
  SUPERMEMORY_API_KEY: z.string().trim().min(1).optional(),
  PI_SUPERMEMORY_NAMESPACE: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  PI_SUPERMEMORY_AUTO_RECALL: booleanEnv,
  PI_SUPERMEMORY_AUTO_CAPTURE: z.enum(["true", "false"]).default("true").transform(value => value === "true"),
  PI_SUPERMEMORY_ALLOW_WRITES: booleanEnv,
});

export interface Config {
  apiKey: string | undefined;
  namespace: string | undefined;
  autoRecall: boolean;
  autoCapture: boolean;
  allowWrites: boolean;
}

export function loadConfig(environment: unknown = process.env): Config {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    // Never include input values in errors: they may contain credentials.
    throw new Error(`Invalid Supermemory settings: ${result.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  }
  return {
    apiKey: result.data.SUPERMEMORY_API_KEY,
    namespace: result.data.PI_SUPERMEMORY_NAMESPACE,
    autoRecall: result.data.PI_SUPERMEMORY_AUTO_RECALL,
    autoCapture: result.data.PI_SUPERMEMORY_AUTO_CAPTURE,
    allowWrites: result.data.PI_SUPERMEMORY_ALLOW_WRITES,
  };
}
