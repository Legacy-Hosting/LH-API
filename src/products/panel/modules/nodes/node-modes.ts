export const nodeAgentModes = ["hosting-node", "monitor-only"] as const;

export type NodeAgentMode = (typeof nodeAgentModes)[number];
