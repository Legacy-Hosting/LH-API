import type { RowDataPacket } from "mysql2";
import { database } from "../../../core/database/mysql.js";

type CountValue = number | string | bigint | null;

type ApplicationCountsRow = RowDataPacket & {
  total: CountValue;
  running: CountValue;
  failed: CountValue;
  deploying: CountValue;
  stopped: CountValue;
  pending: CountValue;
};

type AgentCountsRow = RowDataPacket & {
  total: CountValue;
  online: CountValue;
  offline: CountValue;
  pending: CountValue;
  draining: CountValue;
  lastHeartbeatAt: Date | string | null;
};

type DeploymentCountsRow = RowDataPacket & {
  total: CountValue;
  succeeded: CountValue;
  failed: CountValue;
  inProgress: CountValue;
  queued: CountValue;
  cancelled: CountValue;
};

type RecentDeploymentRow = RowDataPacket & {
  id: string;
  applicationName: string;
  teamName: string;
  status: OperationsSummary["deployments"]["recent"][number]["status"];
  source: OperationsSummary["deployments"]["recent"][number]["source"];
  commitSha: string | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
};

export type OperationsSummary = {
  generatedAt: string;
  database: { state: "connected" };
  applications: {
    total: number;
    running: number;
    failed: number;
    deploying: number;
    stopped: number;
    pending: number;
  };
  agents: {
    total: number;
    online: number;
    offline: number;
    pending: number;
    draining: number;
    lastHeartbeatAt: string | null;
  };
  deployments: {
    windowHours: 24;
    total: number;
    succeeded: number;
    failed: number;
    inProgress: number;
    queued: number;
    cancelled: number;
    successRate: number | null;
    recent: Array<{
      id: string;
      applicationName: string;
      teamName: string;
      status: "queued" | "building" | "deploying" | "succeeded" | "failed" | "rolled_back" | "cancelled";
      source: "manual" | "github_push" | "rollback";
      commitSha: string | null;
      createdAt: string;
      startedAt: string | null;
      finishedAt: string | null;
    }>;
  };
};

function count(value: CountValue) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function timestamp(value: Date | string | null) {
  return value === null ? null : new Date(value).toISOString();
}

export function assembleOperationsSummary(input: {
  generatedAt?: Date;
  applications: ApplicationCountsRow;
  agents: AgentCountsRow;
  deployments: DeploymentCountsRow;
  recentDeployments: RecentDeploymentRow[];
}): OperationsSummary {
  const deployments = {
    total: count(input.deployments.total),
    succeeded: count(input.deployments.succeeded),
    failed: count(input.deployments.failed),
    inProgress: count(input.deployments.inProgress),
    queued: count(input.deployments.queued),
    cancelled: count(input.deployments.cancelled),
  };
  const completed = deployments.succeeded + deployments.failed;
  return {
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    database: { state: "connected" },
    applications: {
      total: count(input.applications.total),
      running: count(input.applications.running),
      failed: count(input.applications.failed),
      deploying: count(input.applications.deploying),
      stopped: count(input.applications.stopped),
      pending: count(input.applications.pending),
    },
    agents: {
      total: count(input.agents.total),
      online: count(input.agents.online),
      offline: count(input.agents.offline),
      pending: count(input.agents.pending),
      draining: count(input.agents.draining),
      lastHeartbeatAt: timestamp(input.agents.lastHeartbeatAt),
    },
    deployments: {
      windowHours: 24,
      ...deployments,
      successRate: completed === 0
        ? null
        : Math.round((deployments.succeeded / completed) * 1_000) / 10,
      recent: input.recentDeployments.map((deployment) => ({
        id: deployment.id,
        applicationName: deployment.applicationName,
        teamName: deployment.teamName,
        status: deployment.status,
        source: deployment.source,
        commitSha: deployment.commitSha,
        createdAt: timestamp(deployment.createdAt)!,
        startedAt: timestamp(deployment.startedAt),
        finishedAt: timestamp(deployment.finishedAt),
      })),
    },
  };
}

export async function readOperationsSummary(): Promise<OperationsSummary> {
  const pool = database();
  const [applicationsResult, agentsResult, deploymentsResult, recentResult] =
    await Promise.all([
      pool.query<ApplicationCountsRow[]>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status='running'),0) AS running,
                COALESCE(SUM(status='failed'),0) AS failed,
                COALESCE(SUM(status='deploying'),0) AS deploying,
                COALESCE(SUM(status='stopped'),0) AS stopped,
                COALESCE(SUM(status='pending'),0) AS pending
         FROM applications
         WHERE deleted_at IS NULL`,
      ),
      pool.query<AgentCountsRow[]>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status='online'),0) AS online,
                COALESCE(SUM(status='offline'),0) AS offline,
                COALESCE(SUM(status='pending'),0) AS pending,
                COALESCE(SUM(status='draining'),0) AS draining,
                MAX(last_heartbeat_at) AS lastHeartbeatAt
         FROM nodes`,
      ),
      pool.query<DeploymentCountsRow[]>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status IN ('succeeded','rolled_back')),0) AS succeeded,
                COALESCE(SUM(status='failed'),0) AS failed,
                COALESCE(SUM(status IN ('building','deploying')),0) AS inProgress,
                COALESCE(SUM(status='queued'),0) AS queued,
                COALESCE(SUM(status='cancelled'),0) AS cancelled
         FROM deployments
         WHERE created_at >= UTC_TIMESTAMP(3) - INTERVAL 24 HOUR`,
      ),
      pool.query<RecentDeploymentRow[]>(
        `SELECT BIN_TO_UUID(d.id) AS id,a.name AS applicationName,t.name AS teamName,
                d.status,d.source,d.commit_sha AS commitSha,d.created_at AS createdAt,
                d.started_at AS startedAt,d.finished_at AS finishedAt
         FROM deployments d
         INNER JOIN applications a ON a.id=d.application_id
         INNER JOIN teams t ON t.id=a.team_id
         ORDER BY d.created_at DESC
         LIMIT 12`,
      ),
    ]);

  return assembleOperationsSummary({
    applications: applicationsResult[0][0]!,
    agents: agentsResult[0][0]!,
    deployments: deploymentsResult[0][0]!,
    recentDeployments: recentResult[0],
  });
}
