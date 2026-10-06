import process from "node:process";

/**
 * Whether this job has its machine to itself. GitHub runs every job on a
 * fresh virtual machine of its own; a self-hosted machine is shared by several
 * runners (and, here, by agents). Compile and test parallelism are sized from
 * the job's share of the machine, which on a GitHub-hosted runner is all of it.
 */
export function dedicatedMachine(env = process.env) {
  return env.RUNNER_ENVIRONMENT === "github-hosted";
}
