/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STATE_KEY } from "../src/config";
import worker from "../src/index";
import { entry, serviceState } from "./factories";

const lifecycleSpies = vi.hoisted(() => ({
  prepare: vi.fn(async (_deps: unknown, _nowMs: number) => undefined),
  promote: vi.fn(async (_deps: unknown, _nowMs: number) => undefined),
}));

function keylessEnv(): Parameters<NonNullable<typeof worker.fetch>>[1] {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "FLICKR_API_KEY") {
        throw new Error("worker read a legacy provider secret");
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as Parameters<NonNullable<typeof worker.fetch>>[1];
}

vi.mock("../src/lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lifecycle")>();
  return {
    ...actual,
    runPreparation: lifecycleSpies.prepare,
    runPromotion: lifecycleSpies.promote,
  };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  lifecycleSpies.prepare.mockClear();
  lifecycleSpies.promote.mockClear();
  await reset();
});

describe("Worker fetch entrypoint", () => {
  it("routes current metadata and rejects unknown paths", async () => {
    await env.STATE.put(
      STATE_KEY,
      JSON.stringify(
        serviceState({
          current: entry({
            providerId: "daily-cow",
            photoId: "wordpress:daily-cow",
          }),
        }),
      ),
    );
    const ctx = createExecutionContext();

    const metadata = await worker.fetch!(
      new Request("https://service.example/today.json") as Parameters<
        NonNullable<typeof worker.fetch>
      >[0],
      keylessEnv(),
      ctx,
    );
    const missing = await worker.fetch!(
      new Request("https://service.example/unknown") as Parameters<
        NonNullable<typeof worker.fetch>
      >[0],
      keylessEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      photoId: "wordpress:daily-cow",
    });
    expect(missing.status).toBe(404);
  });

  it("keeps the Workers fetch receiver valid while streaming an image", async () => {
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    vi.stubGlobal(
      "fetch",
      function (this: unknown): Promise<Response> {
        if (this !== globalThis) {
          throw new TypeError("Illegal invocation: incorrect fetch receiver");
        }
        return Promise.resolve(
          new Response(imageBytes, {
            headers: { "content-type": "image/jpeg" },
          }),
        );
      },
    );
    await env.STATE.put(
      STATE_KEY,
      JSON.stringify(
        serviceState({
          current: entry({
            sourceUrl: "data:image/jpeg;base64,/9j/2Q==",
          }),
        }),
      ),
    );
    const ctx = createExecutionContext();

    const response = await worker.fetch!(
      new Request("https://service.example/today") as Parameters<
        NonNullable<typeof worker.fetch>
      >[0],
      keylessEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      imageBytes,
    );
  });
});

describe("Worker scheduled entrypoint", () => {
  it.each([
    ["45 11,23 * * *", "prepare"],
    ["0 0 * * *", "promote"],
  ] as const)("keeps the %s scheduled invocation open until %s finishes", async (cron, operation) => {
    let releaseLifecycle!: () => void;
    const lifecycle = operation === "prepare" ? lifecycleSpies.prepare : lifecycleSpies.promote;
    lifecycle.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseLifecycle = () => resolve(undefined);
        }),
    );
    const ctx = createExecutionContext();
    const controller = {
      cron,
      scheduledTime: Date.parse("2026-08-26T23:45:00.000Z"),
      noRetry: vi.fn(),
    } satisfies ScheduledController;
    let settled = false;
    const scheduled = worker.scheduled!(controller, keylessEnv(), ctx).then(
      () => {
        settled = true;
      },
    );

    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      releaseLifecycle();
      await scheduled;
      await waitOnExecutionContext(ctx);
    }
  });

  it.each([
    ["45 11,23 * * *", "prepare"],
    ["0 0 * * *", "promote"],
  ] as const)("dispatches %s to only the %s lifecycle operation", async (cron, operation) => {
    const scheduledTime = Date.parse("2026-08-27T00:00:00.000Z");
    const ctx = createExecutionContext();
    const controller = {
      cron,
      scheduledTime,
      noRetry: vi.fn(),
    } satisfies ScheduledController;

    await worker.scheduled!(
      controller,
      keylessEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const expected = operation === "prepare" ? lifecycleSpies.prepare : lifecycleSpies.promote;
    const unexpected = operation === "prepare" ? lifecycleSpies.promote : lifecycleSpies.prepare;
    expect(expected).toHaveBeenCalledOnce();
    expect(expected.mock.calls[0]?.[1]).toBe(scheduledTime);
    expect(expected.mock.calls[0]?.[0]).not.toHaveProperty("flickr");
    expect(expected.mock.calls[0]?.[0]).toMatchObject({
      providers: {
        providers: [{ provider: "wordpress" }, { provider: "commons" }],
      },
    });
    expect(unexpected).not.toHaveBeenCalled();
    expect(controller.noRetry).not.toHaveBeenCalled();
  });

  it("disables retries and leaves state untouched for an unknown cron", async () => {
    const initial = JSON.stringify(serviceState({ current: entry() }));
    await env.STATE.put(STATE_KEY, initial);
    const ctx = createExecutionContext();
    const controller = {
      cron: "15 4 * * *",
      scheduledTime: Date.parse("2026-08-27T04:15:00.000Z"),
      noRetry: vi.fn(),
    } satisfies ScheduledController;

    await worker.scheduled!(
      controller,
      env as unknown as Parameters<NonNullable<typeof worker.scheduled>>[1],
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(controller.noRetry).toHaveBeenCalledOnce();
    expect(lifecycleSpies.prepare).not.toHaveBeenCalled();
    expect(lifecycleSpies.promote).not.toHaveBeenCalled();
    expect(await env.STATE.get(STATE_KEY, "text")).toBe(initial);
  });
});
