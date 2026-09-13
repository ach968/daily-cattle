export class SubrequestBudgetExceededError extends Error {
  constructor(limit: number) {
    super(`outside request budget exhausted after ${limit} requests`);
    this.name = "SubrequestBudgetExceededError";
  }
}

export function createSubrequestBudgetedFetch(
  fetcher: typeof fetch,
  limit: number,
): typeof fetch {
  let used = 0;
  return async (input, init) => {
    if (used >= limit) throw new SubrequestBudgetExceededError(limit);
    used += 1;
    return fetcher(input, init);
  };
}
