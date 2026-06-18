import { describe, expect, it } from "vitest";
import path from "node:path";
import { createFixtureProject } from "../helpers/fixtures.js";
import { runSetup } from "../../src/cli.js";
import { runDoctor, tunnelClientCommand, type DoctorCommand } from "../../src/doctor.js";

const command: DoctorCommand = async (file) => ({ stdout: `${file} 1.0.0\n` });

describe("planbridge doctor", () => {
  it("reports a setup hint when config has not been written", async () => {
    const fixture = await createFixtureProject("alpha");

    const result = await runDoctor([], { HOME: fixture.home }, command);

    expect(result.ok).toBe(false);
    expect(result.stdout).toContain("PlanBridge config not found");
    expect(result.stdout).toContain("planbridge setup");
  });

  it("checks config, allowlist, ripgrep, and codex-cli readiness", async () => {
    const fixture = await createFixtureProject("alpha");
    await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--port",
      "0",
      "--localhost",
      "--execution-adapter",
      "codex-cli"
    ], { HOME: fixture.home });

    const result = await runDoctor([], { HOME: fixture.home }, command);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("[pass] config:");
    expect(result.stdout).toContain("[pass] allowlist:alpha:");
    expect(result.stdout).toContain("[pass] ripgrep: rg 1.0.0");
    expect(result.stdout).toContain("[pass] codex: codex 1.0.0");
    expect(result.stdout).toContain("[pass] codex subscription mode: no API-key env detected");
    expect(result.stdout).toContain("[pass] pro consult: disabled");
  });

  it("fails when codex-cli would run in API-key mode", async () => {
    const fixture = await createFixtureProject("alpha");
    await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--localhost",
      "--execution-adapter",
      "codex-cli"
    ], { HOME: fixture.home });

    const result = await runDoctor([], { HOME: fixture.home, OPENAI_API_KEY: "sk-test" }, command);

    expect(result.ok).toBe(false);
    expect(result.stdout).toContain("[fail] codex subscription mode:");
    expect(result.stdout).toContain("will refuse execution");
  });

  it("checks tunnel-client and runtime key for secure tunnel configs", async () => {
    const fixture = await createFixtureProject("alpha");
    await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--tunnel-id",
      "tunnel_0123456789abcdef0123456789abcdef"
    ], { HOME: fixture.home });

    const missingKey = await runDoctor([], { HOME: fixture.home }, command);
    expect(missingKey.ok).toBe(false);
    expect(missingKey.stdout).toContain("[pass] tunnel-client:");
    expect(missingKey.stdout).toContain("[fail] tunnel runtime key:");

    const withKey = await runDoctor([], { HOME: fixture.home, CONTROL_PLANE_API_KEY: "sk-test" }, command);
    expect(withKey.ok).toBe(true);
    expect(withKey.stdout).toContain("[pass] tunnel runtime key: CONTROL_PLANE_API_KEY present");
  });

  it("resolves tunnel-client from PlanBridge runtime storage, not the configured projects root", async () => {
    const fixture = await createFixtureProject("alpha");
    await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--tunnel-id",
      "tunnel_0123456789abcdef0123456789abcdef"
    ], { HOME: fixture.home });

    const expectedTunnelClient = path.join(
      fixture.home,
      ".planbridge",
      "tunnel-client",
      "bin",
      "tunnel-client"
    );
    const files: string[] = [];
    const captureCommand: DoctorCommand = async (file) => {
      files.push(file);
      return { stdout: `${file} 1.0.0\n` };
    };

    const result = await runDoctor([], { HOME: fixture.home, CONTROL_PLANE_API_KEY: "sk-test" }, captureCommand);

    expect(result.ok).toBe(true);
    expect(files).toContain(expectedTunnelClient);
    expect(files.some((file) => file.startsWith(fixture.projectsRoot))).toBe(false);
    expect(tunnelClientCommand({ PLANBRIDGE_TUNNEL_RUNTIME: "/tmp/planbridge-runtime" })).toBe("/tmp/planbridge-runtime/bin/tunnel-client");
    expect(tunnelClientCommand({ PLANBRIDGE_TUNNEL_CLIENT: "/custom/tunnel-client" })).toBe("/custom/tunnel-client");
  });

  it("checks oracle availability when pro consult is enabled without launching the browser", async () => {
    const fixture = await createFixtureProject("alpha");
    await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--localhost",
      "--enable-pro-consult",
      "--pro-consult-oracle-path",
      "/custom/oracle"
    ], { HOME: fixture.home });
    const files: string[] = [];
    const captureCommand: DoctorCommand = async (file, args) => {
      files.push(`${file} ${args.join(" ")}`);
      return { stdout: `${file} 1.0.0\n` };
    };

    const result = await runDoctor([], { HOME: fixture.home }, captureCommand);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("[pass] pro consult: enabled; oracle=/custom/oracle; chromeProfile=Default; cookieWait=10s");
    expect(result.stdout).toContain("[pass] oracle: /custom/oracle 1.0.0");
    expect(files).toContain("/custom/oracle --version");
  });
});
