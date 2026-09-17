import { z } from "zod";

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  );

export const createApplicationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
    domain: hostname,
    rootDomain: hostname,
    nodeId: z.string().uuid(),
    repository: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .optional(),
    branch: z.string().trim().min(1).default("main"),
    autoDeploy: z.boolean().default(true),
    environment: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(65535),
      )
      .default({}),
  })
  .refine((value) => !("PORT" in value.environment), {
    path: ["environment", "PORT"],
    message: "PORT is managed by Legacy Hosting",
  });
