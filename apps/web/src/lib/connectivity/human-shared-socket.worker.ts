import { installHumanSharedSocketWorker, type SharedHumanWorkerScope } from "./human-shared-socket-worker";

installHumanSharedSocketWorker(self as unknown as SharedHumanWorkerScope);
