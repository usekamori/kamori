import { sleep } from "k6";
import { commonThresholds, getCommonContext, ingestOnce, readChecks } from "../lib/k6-runtime.js";

const context = getCommonContext();

const ingestExecutors = context.profile.name === "smoke"
  ? {
      executor: "constant-vus",
      vus: 5,
      duration: "1m",
    }
  : {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1m", target: 30 },
        { duration: "2m", target: 120 },
        { duration: "2m", target: 200 },
        { duration: "1m", target: 0 },
      ],
    };

export const options = {
  scenarios: {
    ingest: {
      ...ingestExecutors,
      exec: "ingestFlow",
      tags: { scenario: "mixed-ingest", target: context.target },
    },
    reads: context.profile.name === "smoke"
      ? {
          executor: "constant-vus",
          vus: 2,
          duration: "1m",
          exec: "readFlow",
          tags: { scenario: "mixed-reads", target: context.target },
        }
      : {
          executor: "ramping-vus",
          startVUs: 0,
          stages: [
            { duration: "1m", target: 10 },
            { duration: "2m", target: 50 },
            { duration: "2m", target: 80 },
            { duration: "1m", target: 0 },
          ],
          exec: "readFlow",
          tags: { scenario: "mixed-reads", target: context.target },
        },
  },
  thresholds: commonThresholds(),
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function ingestFlow() {
  ingestOnce(context);
  sleep(0.25);
}

export function readFlow() {
  readChecks(context);
  sleep(0.5);
}
