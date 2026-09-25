import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { JsonMetadataStore } from "./store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("JsonMetadataStore", () => {
  it("persists only local project, agent, and thread mapping metadata outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrion-desktop-store-"));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, "project");
    const metadataPath = join(root, "user-data", "metadata.json");
    await mkdir(projectDirectory);
    const store = new JsonMetadataStore(metadataPath);
    const project = await store.createProject({ name: "Project", path: projectDirectory });
    const agent = await store.createAgent({ projectId: project.id, name: "Agent", instructions: "Local instructions" });
    const session = await store.createSession({
      agentId: agent.id,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
    expect(session).toMatchObject({
      title: "Untitled session",
      titleSource: "provisional",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
    session.threadId = "codex-thread";
    await store.updateSession(session);

    const reloaded = await new JsonMetadataStore(metadataPath).read();
    expect(reloaded.sessions[0].threadId).toBe("codex-thread");
    expect(Object.keys(JSON.parse(await readFile(metadataPath, "utf8")) as object).sort()).toEqual(["agents", "projects", "sessions"]);
    expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);
  });

  it("persists a provisional first-message title and can roll the session back", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrion-desktop-store-draft-"));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, "project");
    const metadataPath = join(root, "metadata.json");
    await mkdir(projectDirectory);
    const store = new JsonMetadataStore(metadataPath);
    const project = await store.createProject({ name: "Project", path: projectDirectory });
    const agent = await store.createAgent({ projectId: project.id, name: "Agent", instructions: "" });
    const session = await store.createSession({ agentId: agent.id, title: "Review the release", titleSource: "provisional" });

    expect(session).toMatchObject({ title: "Review the release", titleSource: "provisional" });
    await store.deleteSession(session.id);
    await expect(new JsonMetadataStore(metadataPath).read()).resolves.toMatchObject({ sessions: [] });
  });

  it("normalizes model settings missing from legacy session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrion-desktop-store-legacy-"));
    temporaryDirectories.push(root);
    const metadataPath = join(root, "metadata.json");
    await writeFile(metadataPath, JSON.stringify({
      projects: [],
      agents: [],
      sessions: [{
        id: "legacy-session",
        agentId: "legacy-agent",
        title: "Legacy",
        threadId: "legacy-thread",
        createdAt: "now",
        updatedAt: "now",
      }],
    }));

    const metadata = await new JsonMetadataStore(metadataPath).read();
    expect(metadata.sessions[0]).toMatchObject({
      id: "legacy-session",
      model: null,
      modelProvider: null,
      reasoningEffort: null,
      serviceTier: null,
      titleSource: "codex",
    });
  });
});
