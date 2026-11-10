# tempest-crash-reports

Posts crash reports from the [Tempest](https://github.com/LowRezStudio/Tempest) launcher's **Report logs** button to a private Discord forum, with one thread per anonymous installation ID.

It isn't a bot, and it needs no server or Discord login. It's one Cloudflare Worker that receives a report and passes it to a Discord webhook. The webhook lives here because anyone can read a URL out of the launcher, then spam the channel or delete the webhook.

For each report it allows 2 per minute per IP, accepts only a zip of at most 9 MiB, and rebuilds the message so a forged request can't ping anyone. Reports are not deduplicated or dropped: repeat crashes go into the same thread, rather than producing new top-level posts.

The launcher sends a random UUID as the multipart `installation_id` field. It is not a hardware fingerprint and does not contain an account name, computer name or hardware serial number. On Windows the launcher retains it in a dedicated per-user registry key outside installer data, so reinstalling the launcher does not change it. Other platforms keep it in a separate reporting-data directory. It identifies an OS user's launcher installation, not an entire PC shared by multiple users. It is only sent when the user clicks **Report logs**.

A SQLite-backed Durable Object per ID stores the Discord thread ID and serializes submissions, so simultaneous reports cannot create separate threads. Archived threads are automatically unarchived by Discord when receiving a webhook message. If a thread is deleted, the next report creates a replacement; locked threads and invalid webhooks return an error instead. Changing the webhook ID starts a new thread in the new destination. Older launchers without `installation_id` share a **Legacy launcher crash reports** thread; invalid IDs are rejected. No IP-derived identity is stored.

## Hosting

You need a Cloudflare account with Workers and SQLite-backed Durable Objects enabled (available on the free plan; both have usage limits).

1. **Create the forum webhook.** In Discord, enable Community if necessary to create a **forum channel**, then restrict **View Channel** to the team, because reports hold in-game names and can hold game memory. Do not require tags on posts, since the relay does not assign tags. Go to channel settings → Integrations → Webhooks → New Webhook and copy its URL. A webhook targeting the old text channel is not compatible with forum thread creation; replace it.
2. **Deploy the Worker.** Use either option:
   - **From GitHub (redeploys on every push):** in the Cloudflare dashboard, go to Workers & Pages → Create → Import a repository, pick this repo and deploy with the defaults.
   - **From a terminal, in this folder:** run `npx wrangler login`, then `npx wrangler deploy`.
3. **Add the forum webhook as a secret, never in a file in this repo.** Use either option:
   - **Dashboard:** open the Worker, go to Settings → Variables and Secrets and add a secret named `DISCORD_WEBHOOK`.
   - **Terminal:** run `npx wrangler secret put DISCORD_WEBHOOK` and paste the URL.
4. **Check it's live.** Open the Worker's URL (`https://tempest-crash-reports.<your-subdomain>.workers.dev`) in a browser. A "405" page means it's running.
5. **Send the Tempest team that URL with `/report` added to the end.** It goes in `REPORT_URL` in `Tempest.Launcher/electron/src/crash.ts`.

The checked-in `wrangler.toml` binds `CRASH_THREADS` and migrates the `CrashThread` SQLite Durable Object class. Keep that binding and migration when using dashboard deployment. Deploy the relay and set the forum webhook before releasing the updated launcher. Existing reports in the old text channel are not moved. This change does not require a bot token.

The launcher has this URL built in, so changing it later means a launcher release. To avoid that, put the Worker on a custom domain from the start (Worker → Settings → Domains & Routes).

## Testing

Run the isolated tests (Node 22 or newer); they mock Discord and Durable Object storage, never contacting the real webhook:

```bash
node --test worker.test.mjs
```

With a webhook in `.dev.vars` (`DISCORD_WEBHOOK=<url>`, ignored by git):

```bash
npx wrangler dev
```

Then run the launcher with `TEMPEST_CRASH_REPORT_URL=http://localhost:8787/report`.

## If it gets abused

Anyone can send requests here, and the limit only slows them down. Delete the webhook in Discord to stop everything at once, then set a new one as the secret. Treat attachments as untrusted: open them as data, and don't run anything from them.

Installation IDs are client-supplied grouping labels, not authentication or abuse prevention: a modified client can change them. The existing per-IP limit remains in place. The ID-to-thread mapping persists until its Durable Object storage is removed; do not delete stored thread IDs just because a forum post is archived.
