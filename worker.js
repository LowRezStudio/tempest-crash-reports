// Takes the launcher's crash reports and posts them to a Discord channel. The webhook stays here
// because anything shipped in the launcher can be read out of it, and whoever has a webhook URL can
// post anything or delete it.

const MAX_REPORT_BYTES = 9 * 1024 * 1024;
const MAX_FIELDS = 8;

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
		try {
			const form = await request.formData();
			file = form.get("files[0]");
			payload = JSON.parse(form.get("payload_json"));
		} catch {
			return status(400);
		}
		if (!(file instanceof File) || file.size > MAX_REPORT_BYTES || !(await isZip(file))) {
			return status(400);
		}

		const out = new FormData();
		out.set("payload_json", JSON.stringify(cleanPayload(payload)));
		out.set("files[0]", file, "crash-report.zip");

		const response = await fetch(`${env.DISCORD_WEBHOOK}?wait=true`, {
			method: "POST",
			body: out,
		});
		if (response.ok) return status(204);
		return status(response.status === 429 ? 429 : 502);
	},
};
