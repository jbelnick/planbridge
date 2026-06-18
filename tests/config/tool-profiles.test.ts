import { describe, expect, it } from "vitest";
import { ConfigSchema, effectiveTools } from "../../src/config.js";
import { runSetup } from "../../src/cli.js";
import { createFixtureProject } from "../helpers/fixtures.js";

function baseConfig(projectsRoot: string) {
  return {
    schemaVersion: "1.0" as const,
    projectsRoot,
    allowlist: ["alpha"],
    port: 7676,
    transport: "streamable-http" as const,
    connection: { kind: "localhost" as const },
    auth: { mode: "none" as const }
  };
}

describe("tool profiles", () => {
  it("keeps missing tools.profile in legacy mode for existing configs", async () => {
    const fixture = await createFixtureProject("alpha");
    const parsed = ConfigSchema.parse(baseConfig(fixture.projectsRoot));

    expect(parsed.tools).toEqual({ profile: "legacy" });
    expect(effectiveTools(baseConfig(fixture.projectsRoot)).profile).toBe("legacy");
  });

  it("validates explicit profile names", async () => {
    const fixture = await createFixtureProject("alpha");

    expect(effectiveTools({ ...baseConfig(fixture.projectsRoot), tools: { profile: "guided" } }).profile).toBe("guided");
    expect(effectiveTools({ ...baseConfig(fixture.projectsRoot), tools: { profile: "advanced" } }).profile).toBe("advanced");
    expect(() => ConfigSchema.parse({ ...baseConfig(fixture.projectsRoot), tools: { profile: "kitchen-sink" } })).toThrow();
  });

  it("setup writes guided by default and advanced when requested", async () => {
    const fixture = await createFixtureProject("alpha");
    const guided = await runSetup(
      ["setup", "--projects-root", fixture.projectsRoot, "--allowlist", "alpha", "--localhost"],
      { HOME: fixture.home }
    );

    expect(guided.stdout).toContain("Tool profile: guided");

    const advancedFixture = await createFixtureProject("alpha");
    const advanced = await runSetup(
      ["setup", "--projects-root", advancedFixture.projectsRoot, "--allowlist", "alpha", "--localhost", "--advanced-tools"],
      { HOME: advancedFixture.home }
    );

    expect(advanced.stdout).toContain("Tool profile: advanced");
  });
});
