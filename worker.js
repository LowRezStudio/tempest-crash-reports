// Takes the launcher's crash reports and posts them to a Discord channel. The webhook stays here
// because anything shipped in the launcher can be read out of it, and whoever has a webhook URL can
// post anything or delete it.

const MAX_REPORT_BYTES = 9 * 1024 * 1024;
const MAX_FIELDS = 8;
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const text = (value, length) => (typeof value === "string" ? value.slice(0, length) : "");

// The launcher's payload is rebuilt rather than forwarded, so a forged request can only fill in
// these fields: no mentions, no other sender name, no links in titles.
function cleanPayload(payload) {
	const embed = payload?.embeds?.[0] ?? {};
	const fields = Array.isArray(embed.fields) ? embed.fields : [];
	return {
		username: "Tempest crash reports",
		allowed_mentions: { parse: [] },
		embeds: [
			{
				title: text(embed.title, 200) || "Crash",
				color: 0xe05561,
				description: text(embed.description, 2000),
				timestamp: new Date().toISOString(),
				fields: fields
					.slice(0, MAX_FIELDS)
					.map((field) => ({
						name: text(field?.name, 64),
						value: text(field?.value, 1024),
						inline: field?.inline === true,
					}))
					.filter((field) => field.name && field.value),
			},
		],
	};
}

async function isZip(file) {
	const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
	return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

const status = (code) => new Response(null, { status: code });

export default {
	async fetch(request, env) {
		if (request.method !== "POST") return status(405);

		const declared = Number(request.headers.get("content-length") ?? 0);
		if (declared > MAX_REPORT_BYTES + 64 * 1024) return status(413);

		const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
		const { success } = await env.REPORTS.limit({ key: ip });
		if (!success) return status(429);

		let file;
		let payload;
		let installationId;
		try {
			const form = await request.formData();
			file = form.get("files[0]");
			const rawPayload = form.get("payload_json");
			if (typeof rawPayload !== "string") return status(400);
			payload = JSON.parse(rawPayload);
			const id = form.get("installation_id");
			if (id !== null && (typeof id !== "string" || !INSTALLATION_ID.test(id))) {
				return status(400);
			}
			installationId = id === null ? "legacy" : id.toLowerCase();
		} catch {
			return status(400);
		}
		if (!(file instanceof File) || file.size > MAX_REPORT_BYTES || !(await isZip(file))) {
			return status(400);
		}

		const out = new FormData();
		out.set("payload_json", JSON.stringify(cleanPayload(payload)));
		out.set("files[0]", file, "crash-report.zip");

		const thread = env.CRASH_THREADS.get(env.CRASH_THREADS.idFromName(installationId));
		return thread.fetch("https://crash-thread/report", {
			method: "POST",
			headers: { "X-Installation-ID": installationId },
			body: out,
		});
	},
};

export class CrashThread {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}

	async fetch(request) {
		// Keep the first Discord request and its saved thread ID in the same critical section.
		return this.ctx.blockConcurrencyWhile(() => this.report(request));
	}

	async report(request) {
		const installationId = request.headers.get("X-Installation-ID");
		if (installationId !== "legacy" && !INSTALLATION_ID.test(installationId ?? "")) {
			return status(400);
		}
		const form = await request.formData();
		const payload = JSON.parse(form.get("payload_json"));
		const webhook = new URL(this.env.DISCORD_WEBHOOK);
		const webhookId = /\/webhooks\/(\d+)\//.exec(webhook.pathname)?.[1];
		if (!webhookId) {
			console.error("DISCORD_WEBHOOK is not a Discord webhook URL.");
			return status(502);
		}
		webhook.searchParams.set("wait", "true");
		webhook.searchParams.delete("thread_id");
		const saved = await this.ctx.storage.get("thread");
		let threadId = saved?.webhookId === webhookId ? saved.threadId : null;

		for (let attempt = 0; attempt < 2; attempt++) {
			if (threadId) {
				webhook.searchParams.set("thread_id", threadId);
				delete payload.thread_name;
			} else {
				webhook.searchParams.delete("thread_id");
				payload.thread_name =
					installationId === "legacy"
						? "Legacy launcher crash reports"
						: `Crash reports - ${installationId}`;
			}
			form.set("payload_json", JSON.stringify(payload));
			let response;
			try {
				response = await fetch(webhook, {
					method: "POST",
					body: form,
					signal: AbortSignal.timeout(10_000),
				});
			} catch {
				console.error("Discord crash-report request failed or timed out.");
				return status(502);
			}
			if (response.ok) {
				if (!threadId) {
					let message;
					try {
						message = await response.json();
					} catch {
						console.error("Discord did not return the created thread's message.");
						return status(502);
					}
					if (
						typeof message?.channel_id !== "string" ||
						!/^\d+$/.test(message.channel_id)
					) {
						console.error("Discord did not return a valid thread ID.");
						return status(502);
					}
					await this.ctx.storage.put("thread", {
						webhookId,
						threadId: message.channel_id,
					});
				}
				return status(204);
			}
			if (response.status === 429) return status(429);
			const error = await response.json().catch(() => null);
			// Only replace deleted threads. A locked thread or revoked webhook must remain an error.
			if (threadId && response.status === 404 && error?.code === 10003) {
				await this.ctx.storage.delete("thread");
				threadId = null;
				continue;
			}
			console.error("Discord rejected a crash report.", response.status, error?.code);
			return status(502);
		}
		return status(502);
	}
}
