import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import worker, { CrashThread } from "./worker.js";

const WEBHOOK = "https://discord.com/api/webhooks/123456/test-token";
const THREAD = "987654321";

function environment() {
	const states = new Map();
	const objects = new Map();
	const env = {
		DISCORD_WEBHOOK: WEBHOOK,
		REPORTS: { limit: async () => ({ success: true }) },
		CRASH_THREADS: {
			idFromName: (id) => id,
			get(id) {
				if (!objects.has(id)) {
					if (!states.has(id)) states.set(id, new Map());
					const state = states.get(id);
					let queue = Promise.resolve();
					const ctx = {
						storage: {
							get: async (key) => structuredClone(state.get(key)),
							put: async (key, value) => state.set(key, structuredClone(value)),
							delete: async (key) => state.delete(key),
						},
						blockConcurrencyWhile(callback) {
							const result = queue.then(callback);
							queue = result.catch(() => {});
							return result;
						},
					};
					objects.set(id, new CrashThread(ctx, env));
				}
				return {
					fetch: (url, options) => objects.get(id).fetch(new Request(url, options)),
				};
			},
		},
	};
	return { env, states, objects };
}

function report(id, { payload, zip, method = "POST" } = {}) {
	const form = new FormData();
	if (id !== undefined) form.set("installation_id", id);
	form.set(
		"payload_json",
		payload ??
			JSON.stringify({
				embeds: [{ title: "Crash: test", fields: [{ name: "Launcher", value: "1.5.1" }] }],
			}),
	);
	form.set(
		"files[0]",
		new Blob([zip ?? new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])]),
		"test.zip",
	);
	return new Request("https://reports.example/report", {
		method,
		headers: { "cf-connecting-ip": "192.0.2.1" },
		...(method === "POST" ? { body: form } : {}),
	});
}

function discord(t, replies = []) {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (input, options) => {
		const payload = JSON.parse(options.body.get("payload_json"));
		calls.push({
			url: new URL(input),
			payload,
			file: options.body.get("files[0]"),
		});
		const reply = replies.shift();
		if (reply instanceof Error) throw reply;
		return reply ?? Response.json({ channel_id: THREAD });
	});
	return calls;
}

test("first report creates a forum thread; subsequent reports reuse it, even after eviction", async (t) => {
	const { env, states, objects } = environment();
	const calls = discord(t);
	const id = randomUUID();
	assert.equal((await worker.fetch(report(id), env)).status, 204);
	assert.equal(calls[0].payload.thread_name, `Crash reports - ${id}`);
	assert.equal(calls[0].url.searchParams.get("wait"), "true");
	assert.equal(calls[0].url.searchParams.has("thread_id"), false);
	assert.deepEqual(states.get(id).get("thread"), { webhookId: "123456", threadId: THREAD });
	objects.clear();
	assert.equal((await worker.fetch(report(id), env)).status, 204);
	assert.equal(calls[1].url.searchParams.get("thread_id"), THREAD);
	assert.equal("thread_name" in calls[1].payload, false);
	assert.equal(calls[1].file.name, "crash-report.zip");
});

test("simultaneous reports create only one thread", async (t) => {
	const { env } = environment();
	const calls = discord(t);
	const id = randomUUID();
	const responses = await Promise.all([
		worker.fetch(report(id), env),
		worker.fetch(report(id), env),
	]);
	assert.deepEqual(
		responses.map((response) => response.status),
		[204, 204],
	);
	assert.equal(calls.filter((call) => call.payload.thread_name).length, 1);
	assert.equal(calls[1].url.searchParams.get("thread_id"), THREAD);
});

test("IDs are normalized and different installations use different threads", async (t) => {
	const { env } = environment();
	const calls = discord(t);
	const first = randomUUID();
	await worker.fetch(report(first), env);
	await worker.fetch(report(first.toUpperCase()), env);
	await worker.fetch(report(randomUUID()), env);
	assert.equal(calls.filter((call) => call.payload.thread_name).length, 2);
	assert.equal(calls[1].url.searchParams.get("thread_id"), THREAD);
});

test("older clients share a labeled legacy thread", async (t) => {
	const { env } = environment();
	const calls = discord(t);
	await worker.fetch(report(), env);
	await worker.fetch(report(), env);
	assert.equal(calls[0].payload.thread_name, "Legacy launcher crash reports");
	assert.equal(calls[1].url.searchParams.get("thread_id"), THREAD);
});

test("untrusted IDs, invalid payloads, and non-zip attachments are rejected", async (t) => {
	const { env, states } = environment();
	const calls = discord(t);
	for (const request of [
		report(""),
		report("not-an-id"),
		report(new Blob(["spoof"])),
		report(randomUUID(), { payload: "{" }),
		report(randomUUID(), { zip: "not a zip" }),
	]) {
		assert.equal((await worker.fetch(request, env)).status, 400);
	}
	assert.equal(calls.length, 0);
	assert.equal(states.size, 0);
});

test("mention settings, sender identity and thread names cannot be forged", async (t) => {
	const { env } = environment();
	const calls = discord(t);
	const id = randomUUID();
	await worker.fetch(
		report(id, {
			payload: JSON.stringify({
				username: "forged",
				content: "@everyone",
				allowed_mentions: { parse: ["everyone"] },
				thread_name: "forged thread",
				embeds: [{ title: "Crash", fields: [{ name: "Test", value: "value" }] }],
			}),
		}),
		env,
	);
	assert.equal(calls[0].payload.username, "Tempest crash reports");
	assert.deepEqual(calls[0].payload.allowed_mentions, { parse: [] });
	assert.equal(calls[0].payload.content, undefined);
	assert.equal(calls[0].payload.thread_name, `Crash reports - ${id}`);
});

test("IP rate limiting, method validation, and size limits still run before routing", async (t) => {
	const { env } = environment();
	const calls = discord(t);
	assert.equal((await worker.fetch(report(undefined, { method: "GET" }), env)).status, 405);
	const oversized = report();
	oversized.headers.set("content-length", String(10 * 1024 * 1024));
	assert.equal((await worker.fetch(oversized, env)).status, 413);
	assert.equal(
		(await worker.fetch(report(undefined, { zip: new Uint8Array(9 * 1024 * 1024 + 1) }), env))
			.status,
		400,
	);
	env.REPORTS.limit = async ({ key }) => {
		assert.equal(key, "192.0.2.1");
		return { success: false };
	};
	assert.equal((await worker.fetch(report(), env)).status, 429);
	assert.equal(calls.length, 0);
});

test("a deleted thread is replaced, and its replacement is reused", async (t) => {
	const { env } = environment();
	const calls = discord(t, [
		Response.json({ channel_id: "111111" }),
		Response.json({ code: 10003 }, { status: 404 }),
		Response.json({ channel_id: "222222" }),
	]);
	const id = randomUUID();
	await worker.fetch(report(id), env);
	assert.equal((await worker.fetch(report(id), env)).status, 204);
	await worker.fetch(report(id), env);
	assert.equal(calls[1].url.searchParams.get("thread_id"), "111111");
	assert.equal(calls[2].payload.thread_name, `Crash reports - ${id}`);
	assert.equal(calls[3].url.searchParams.get("thread_id"), "222222");
});

test("locked threads and revoked webhooks are not bypassed by creating new threads", async (t) => {
	const { env } = environment();
	const calls = discord(t, [
		Response.json({ channel_id: THREAD }),
		Response.json({ code: 50083 }, { status: 403 }),
		Response.json({ code: 10015 }, { status: 404 }),
	]);
	t.mock.method(console, "error", () => {});
	const id = randomUUID();
	await worker.fetch(report(id), env);
	assert.equal((await worker.fetch(report(id), env)).status, 502);
	assert.equal((await worker.fetch(report(id), env)).status, 502);
	assert.equal(calls.filter((call) => call.payload.thread_name).length, 1);
});

test("Discord rate limits and network failures preserve existing routing", async (t) => {
	const { env, states } = environment();
	const calls = discord(t, [
		Response.json({ channel_id: THREAD }),
		new Response(null, { status: 429 }),
		new Error("Network unavailable"),
	]);
	t.mock.method(console, "error", () => {});
	const id = randomUUID();
	await worker.fetch(report(id), env);
	assert.equal((await worker.fetch(report(id), env)).status, 429);
	assert.equal((await worker.fetch(report(id), env)).status, 502);
	assert.equal(states.get(id).get("thread").threadId, THREAD);
	assert.equal(calls.length, 3);
});

test("missing thread IDs and malformed Discord replies are explicit failures", async (t) => {
	const { env, states } = environment();
	discord(t, [Response.json({}), new Response("not JSON")]);
	t.mock.method(console, "error", () => {});
	const id = randomUUID();
	assert.equal((await worker.fetch(report(id), env)).status, 502);
	assert.equal((await worker.fetch(report(id), env)).status, 502);
	assert.equal(states.get(id).has("thread"), false);
});

test("changing the webhook ID starts a new thread instead of using the old destination", async (t) => {
	const { env } = environment();
	const calls = discord(t);
	const id = randomUUID();
	await worker.fetch(report(id), env);
	env.DISCORD_WEBHOOK = "https://discord.com/api/webhooks/654321/replacement";
	await worker.fetch(report(id), env);
	await worker.fetch(report(id), env);
	assert.equal(calls[1].url.pathname, "/api/webhooks/654321/replacement");
	assert.equal(calls[1].payload.thread_name, `Crash reports - ${id}`);
	assert.equal(calls[2].url.searchParams.get("thread_id"), THREAD);
});
