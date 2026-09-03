import { PREPARE_CRON, PROMOTE_CRON } from "./config";
import { CommonsPhotoClient } from "./commons";
import { handleRequest, type ResponseCache } from "./http";
import {
  consoleLogger,
  promoteAvailableReserveIfCurrent,
  runPreparation,
  runPromotion,
} from "./lifecycle";
import type { AppEnv } from "./model";
import { ProviderRegistry } from "./providers";
import { QualityScorer } from "./quality";
import { SelectionEngine } from "./selector";
import { StateRepository } from "./state";
import { WordPressPhotoClient } from "./wordpress";

const runtimeFetch: typeof fetch = (...args) => globalThis.fetch(...args);

function createProviderRegistry(): ProviderRegistry {
  const wordpress = new WordPressPhotoClient(runtimeFetch, consoleLogger);
  const commons = new CommonsPhotoClient(runtimeFetch, consoleLogger);
  return new ProviderRegistry([wordpress, commons]);
}

const worker = {
  async fetch(request, env, ctx) {
    const repository = new StateRepository(env.STATE);
    const providers = createProviderRegistry();

    return handleRequest(
      request,
      {
        repository,
        cache: (caches as unknown as { default: ResponseCache }).default,
        fetcher: runtimeFetch,
        promoteFallback: (failedPhotoId, nowMs) =>
          promoteAvailableReserveIfCurrent(
            { repository, providers, logger: consoleLogger },
            failedPhotoId,
            nowMs,
          ),
        logger: consoleLogger,
        ctx,
      },
      Date.now(),
    );
  },

  async scheduled(controller, env, ctx) {
    const repository = new StateRepository(env.STATE);
    const providers = createProviderRegistry();
    const scorer = new QualityScorer(env.AI, runtimeFetch, (failure) => {
      consoleLogger.error({
        event: "quality_scoring_failed",
        at: new Date(controller.scheduledTime).toISOString(),
        ...failure,
      });
    });
    const selector = new SelectionEngine(providers, scorer, consoleLogger);
    const deps = { repository, providers, selector, logger: consoleLogger };

    if (controller.cron === PREPARE_CRON) {
      await runPreparation(deps, controller.scheduledTime);
      return;
    }
    if (controller.cron === PROMOTE_CRON) {
      await runPromotion(deps, controller.scheduledTime);
      return;
    }

    consoleLogger.error({
      event: "unknown_cron",
      at: new Date(controller.scheduledTime).toISOString(),
      cron: controller.cron,
    });
    controller.noRetry();
  },
} satisfies ExportedHandler<AppEnv>;

export default worker;
