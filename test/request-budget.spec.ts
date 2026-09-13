import { describe, expect, it, vi } from "vitest";

import {
  createSubrequestBudgetedFetch,
  SubrequestBudgetExceededError,
} from "../src/request-budget";

describe("createSubrequestBudgetedFetch", () => {
  it("stops before an outside request exceeds the shared limit", async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 204 }));
    const fetcher = createSubrequestBudgetedFetch(
      upstream as unknown as typeof fetch,
      3,
    );

    await fetcher("https://example.com/1");
    await fetcher("https://example.com/2");
    await fetcher("https://example.com/3");

    await expect(fetcher("https://example.com/4")).rejects.toBeInstanceOf(
      SubrequestBudgetExceededError,
    );
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});
