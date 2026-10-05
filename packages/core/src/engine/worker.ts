import { parentPort, workerData } from "node:worker_threads";
import { parseScenario } from "../scenario/load.js";
import { Engine } from "./engine.js";
import type { FromWorker, ToWorker, WorkerInit } from "./protocol.js";

// Worker: reconstrói o cenário a partir do texto (com a semente do coordenador) e roda um Engine.
const port = parentPort!;
const post = (m: FromWorker) => port.postMessage(m);

try {
  const init = workerData as WorkerInit;
  const sc = parseScenario(init.scenario.text, init.scenario.file, {
    baseDir: init.scenario.baseDir,
    seed: init.scenario.seed,
  });
  sc.target.baseUrl = init.scenario.baseUrl;
  const engine = new Engine(sc, init.config, (bucket) => post({ type: "bucket", bucket }));
  port.on("message", (msg: ToWorker) => {
    if (msg.type === "start") {
      engine
        .run(msg.startEpochMs)
        .then(({ result, finalBuckets }) => post({ type: "done", result, finalBuckets }))
        .catch((e: Error) => post({ type: "error", message: e.message, stack: e.stack }));
    } else if (msg.type === "stop") engine.stop();
  });
  post({ type: "ready" });
} catch (e) {
  post({ type: "error", message: (e as Error).message, stack: (e as Error).stack });
}
