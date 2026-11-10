import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { MemoryMapLayoutRepo } from "./repo";
import { createMapLayoutRouter } from "./routes";

function app(repo = new MemoryMapLayoutRepo(), ready: () => Promise<void> = () => Promise.resolve()) {
  const server = express();
  server.use("/api/map-layout", createMapLayoutRouter(repo, { ready }));
  return server;
}

interface ErrorBody { error: string; message: string }
const errorBody = (res: { body: unknown }): ErrorBody => res.body as ErrorBody;

const move = (nodeKey: string, x: number, y: number) => ({ nodeKey, x, y });

describe("map layout routes", () => {
  it("returns the positions after two saves", async () => {
    const a = app();
    expect((await request(a).post("/api/map-layout/moves").send({ direction: "LR", moves: [move("job:a", 1, 2)] })).status).toBe(204);
    expect((await request(a).post("/api/map-layout/moves").send({ direction: "LR", moves: [move("job:a", 5, 6), move("service:s", 7, 8)] })).status).toBe(204);
    const res = await request(a).get("/api/map-layout?direction=LR");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ direction: "LR", positions: [move("job:a", 5, 6), move("service:s", 7, 8)] });
  });

  it("clears a direction on reset", async () => {
    const a = app();
    await request(a).post("/api/map-layout/moves").send({ direction: "TB", moves: [move("job:a", 1, 2)] });
    expect((await request(a).post("/api/map-layout/reset").send({ direction: "TB" })).status).toBe(204);
    expect((await request(a).get("/api/map-layout?direction=TB")).body).toEqual({ direction: "TB", positions: [] });
  });

  it("records the forwarded email as the person who moved the boxes", async () => {
    const repo = new MemoryMapLayoutRepo();
    const a = app(repo);
    await request(a).post("/api/map-layout/moves").set("x-forwarded-email", "me@example.com").send({ direction: "LR", moves: [move("job:a", 1, 2)] });
    await request(a).post("/api/map-layout/reset").set("x-forwarded-email", "you@example.com").send({ direction: "LR" });
    expect(repo.log.map((e) => e.by)).toEqual(["me@example.com", "you@example.com"]);
  });

  it.each([
    ["a direction that is not LR or TB", { direction: "XY", moves: [move("job:a", 1, 2)] }],
    ["an x that is not finite", { direction: "LR", moves: [{ nodeKey: "job:a", x: Infinity, y: 2 }] }],
    ["an x that is a string", { direction: "LR", moves: [{ nodeKey: "job:a", x: "1", y: 2 }] }],
    ["an x past 1,000,000", { direction: "LR", moves: [move("job:a", 1_000_001, 2)] }],
    ["an empty node key", { direction: "LR", moves: [move("", 1, 2)] }],
    ["a node key over 300 characters", { direction: "LR", moves: [move("j".repeat(301), 1, 2)] }],
    ["no moves", { direction: "LR", moves: [] }],
    ["501 moves", { direction: "LR", moves: Array.from({ length: 501 }, (_, i) => move(`job:${i}`, i, i)) }],
  ])("answers 400 for %s", async (_name, payload) => {
    const res = await request(app()).post("/api/map-layout/moves").send(payload);
    expect(res.status).toBe(400);
    expect(errorBody(res).error).toBe("invalid");
    expect(typeof errorBody(res).message).toBe("string");
  });

  it("accepts 500 moves", async () => {
    const moves = Array.from({ length: 500 }, (_, i) => move(`job:${i}`, i, i));
    expect((await request(app()).post("/api/map-layout/moves").send({ direction: "LR", moves })).status).toBe(204);
  });

  it("answers 400 for a bad direction on read and on reset", async () => {
    expect((await request(app()).get("/api/map-layout?direction=XY")).status).toBe(400);
    expect((await request(app()).get("/api/map-layout")).status).toBe(400);
    expect((await request(app()).post("/api/map-layout/reset").send({ direction: "XY" })).status).toBe(400);
  });

  it("answers 503 while the schema is not ready", async () => {
    const res = await request(app(new MemoryMapLayoutRepo(), () => Promise.reject(new Error("timeout")))).get("/api/map-layout?direction=LR");
    expect(res.status).toBe(503);
  });

  it("answers 503 no_access when Postgres refuses", async () => {
    const denied = Object.assign(new Error("permission denied"), { code: "42501" });
    const res = await request(app(new MemoryMapLayoutRepo(), () => Promise.reject(denied))).get("/api/map-layout?direction=LR");
    expect(res.status).toBe(503);
    expect(errorBody(res).error).toBe("no_access");
  });
});
