import { sleep } from "k6";
import { commonThresholds, getCommonContext, ingestOnce } from "../lib/k6-runtime.js";

const context = getCommonContext();

const smokeStages = [
  { duration: "30s", target: 5 },
  { duration: "30s", target: 10 },
  { duration: "30s", target: 0 },
];

const stressStages = [
  { duration: "1m", target: 20 },
  { duration: "2m", target: 80 },
  { duration: "2m", target: 150 },
  { duration: "2m", target: 250 },
  { duration: "1m", target: 0 },
];

export const options = {
  stages: context.profile.name === "smoke" ? smokeStages : stressStages,
  thresholds: commonThresholds(),
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export default function runRampIngest() {
  ingestOnce(context);
  sleep(0.2);
}
