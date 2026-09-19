import { z } from "zod";

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  );

const processEnvironment = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(65535),
);

const applicationProcessFields = {
  name: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  type: z.enum(["web", "api", "bot", "worker", "custom"]),
  workingDirectory: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        !value.startsWith("\\") &&
        !value.split(/[\\/]+/).includes(".."),
      "Working directory must stay inside the repository",
    )
    .default("."),
  executable: z.enum(["npm", "pnpm", "yarn", "bun", "node"]),
  args: z.array(z.string().min(1).max(500)).max(30),
  primary: z.boolean().default(false),
  public: z.boolean().default(false),
  routes: z
    .array(z.string().trim().min(1).max(255).regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/))
    .max(20)
    .default([]),
  hostname: hostname.optional(),
  enabled: z.boolean().default(true),
  startOrder: z.number().int().min(0).max(1000).default(0),
  instances: z.number().int().min(1).max(32).default(1),
  restartDelayMs: z.number().int().min(0).max(300000).default(1000),
  inheritEnvironment: z.boolean().default(true),
  healthPath: z
    .string()
    .trim()
    .max(512)
    .regex(/^\/(?!\/)/)
    .optional(),
  hostVariable: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  portVariable: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
};

const applicationProcess = z.object({
  ...applicationProcessFields,
  environment: processEnvironment.default({}),
});

const updatedApplicationProcess = z.object({
  ...applicationProcessFields,
  id: z.string().uuid().optional(),
  environment: processEnvironment.optional(),
});

function validateProcesses(
  processes: Array<
    | z.infer<typeof applicationProcess>
    | z.infer<typeof updatedApplicationProcess>
  >,
  context: z.RefinementCtx,
) {
  if (!processes.length) return;
  const names = new Set<string>();
  const routesByHostname = new Map<string, Set<string>>();
  let primaryProcesses = 0;
  for (const [index, process] of processes.entries()) {
    if (names.has(process.name)) {
      context.addIssue({
        code: "custom",
        path: ["processes", index, "name"],
        message: "Process names must be unique",
      });
    }
    names.add(process.name);
    if (process.primary) primaryProcesses += 1;
    if (process.environment && "PORT" in process.environment) {
      context.addIssue({
        code: "custom",
        path: ["processes", index, "environment", "PORT"],
        message: "PORT is managed by Legacy Hosting",
      });
    }
    if (process.primary && !process.public) {
      context.addIssue({
        code: "custom",
        path: ["processes", index, "public"],
        message: "The primary process must be public",
      });
    }
    if (process.primary && !process.enabled) {
      context.addIssue({
        code: "custom",
        path: ["processes", index, "enabled"],
        message: "The primary process must be enabled",
      });
    }
    if (process.primary && process.hostname) {
      context.addIssue({
        code: "custom",
        path: ["processes", index, "hostname"],
        message: "The public process uses the application hostname",
      });
    }
    if (process.public && !["web", "api"].includes(process.type)) {
      context.addIssue({
        code: "custom",
        path: ["processes", index, "type"],
        message: "Only web and API processes can use HTTP routing",
      });
    }
    if (process.public && process.routes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["processes", index, "routes"],
        message: "Public processes need at least one route",
      });
    }
    if (!process.public && (process.hostname || process.routes.length)) {
      context.addIssue({
        code: "custom",
        path: ["processes", index, "public"],
        message: "Only public processes can define hostnames and routes",
      });
    }
    if (process.public) {
      const routeHost = process.hostname ?? "__shared__";
      const routes = routesByHostname.get(routeHost) ?? new Set<string>();
      for (const [routeIndex, route] of process.routes.entries()) {
        const normalizedRoute = route.replace(/\*$/, "").replace(/\/$/, "") || "/";
        if (routes.has(normalizedRoute)) {
          context.addIssue({
            code: "custom",
            path: ["processes", index, "routes", routeIndex],
            message: "Routes must be unique for each hostname",
          });
        }
        routes.add(normalizedRoute);
      }
      routesByHostname.set(routeHost, routes);
    }
  }
  if (primaryProcesses !== 1) {
    context.addIssue({
      code: "custom",
      path: ["processes"],
      message: "Exactly one web or API process must be public",
    });
  }
}

const runtimeCommand = z.object({
  command: z.enum(["npm", "pnpm", "yarn", "bun", "node"]),
  args: z.array(z.string().min(1).max(500)).max(30),
});

const persistentPath = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        !value.startsWith("\\") &&
        !value.split(/[\\/]+/).includes(".."),
      "Persistent paths must stay inside the application directory",
    ),
  type: z.enum(["file", "directory"]).default("directory"),
});

const applicationName = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

export const updateApplicationSchema = z
  .object({
    name: applicationName,
    branch: z.string().trim().min(1).max(255),
    autoDeploy: z.boolean(),
    installCommand: runtimeCommand.optional(),
    buildCommand: runtimeCommand.nullable(),
    checkCommands: z.array(runtimeCommand).max(10),
    persistentPaths: z.array(persistentPath).max(50),
    processes: z.array(updatedApplicationProcess).min(1).max(10),
  })
  .superRefine((value, context) => validateProcesses(value.processes, context));

export const persistentFileWriteSchema = z.object({
  path: persistentPath.shape.path,
  content: z.string().min(1).max(65_536),
  restartProcesses: z.boolean().default(true),
});

export const createApplicationSchema = z
  .object({
    name: applicationName,
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
    additionalHostnames: z.array(hostname).max(20).default([]),
    environment: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(65535),
      )
      .default({}),
    processes: z.array(applicationProcess).max(10).default([]),
    installCommand: runtimeCommand.optional(),
    buildCommand: runtimeCommand.nullable().optional(),
    checkCommands: z.array(runtimeCommand).max(10).default([]),
    persistentPaths: z.array(persistentPath).max(50).default([]),
  })
  .refine((value) => !("PORT" in value.environment), {
    path: ["environment", "PORT"],
    message: "PORT is managed by Legacy Hosting",
  })
  .superRefine((value, context) => {
    validateProcesses(value.processes, context);
    const hostnames = new Set<string>([value.domain]);
    const sharedHostnames = new Set<string>(value.additionalHostnames);
    for (const [index, additionalHostname] of value.additionalHostnames.entries()) {
      if (hostnames.has(additionalHostname)) {
        context.addIssue({
          code: "custom",
          path: ["additionalHostnames", index],
          message: "Hostnames must be unique",
        });
      }
      hostnames.add(additionalHostname);
    }
    if (!value.processes.length) return;
    for (const [index, process] of value.processes.entries()) {
      if (process.hostname) {
        if (sharedHostnames.has(process.hostname)) {
          context.addIssue({
            code: "custom",
            path: ["processes", index, "hostname"],
            message: "A separate process hostname cannot also be a shared hostname",
          });
        }
        hostnames.add(process.hostname);
      }
    }
  });
