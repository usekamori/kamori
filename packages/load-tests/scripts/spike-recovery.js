import { sleep } from "k6";
import { commonThresholds, getCommonContext, ingestOnce } from "../lib/k6-runtime.js";

const context = getCommonContext();

export const options = {
  stages: context.profile.name === "smoke"
    ? [
        { duration: "20s", target: 5 },
        { duration: "20s", target: 30 },
        { duration: "20s", target: 5 },
        { duration: "20s", target: 0 },
      ]
    : [
        { duration: "1m", target: 20 },
        { duration: "30s", target: 250 },
        { duration: "2m", target: 250 },
        { duration: "1m", target: 30 },
        { duration: "2m", target: 30 },
        { duration: "1m", target: 0 },
      ],
  thresholds: commonThresholds(),
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export default function runSpikeRecovery() {
  ingestOnce(context);
  sleep(0.2);
}
