import { describe, expect, it, beforeEach } from "vitest";
import { setupExtension, type IndexHarness } from "./index-fixture.js";

let harness: IndexHarness;

beforeEach(async () => {
  harness = await setupExtension();
});

describe("index extension lifecycle", () => {
  it("registers session hooks", () => {
    const { handlers } = harness;
    // Should also register session hooks
    expect(handlers.session_start).toBeDefined();
    expect(handlers.before_agent_start).toBeDefined();
    expect(handlers.session_shutdown).toBeDefined();
  });
});
