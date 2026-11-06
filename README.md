# tempest-crash-reports

Posts crash reports from the [Tempest](https://github.com/LowRezStudio/Tempest) launcher's **Report logs** button to a Discord channel.

It isn't a bot, and it needs no server or Discord login. It's one Cloudflare Worker that receives a report and passes it to a Discord webhook. The webhook lives here because anyone can read a URL out of the launcher, then spam the channel or delete the webhook.

For each report it allows 2 per minute per IP, accepts only a zip of at most 9 MiB, and rebuilds the message so a forged request can't ping anyone.

## Hosting

You need a free Cloudflare account. The free plan should be plenty, since it allows 100,000 requests a day.

1. **Create the webhook.** In Discord, make a **private** channel for the team, because the reports hold in-game names and can hold game memory. Then go to channel settings → Integrations → Webhooks → New Webhook and copy its URL.
2. **Deploy the Worker.** Use either option:
   - **From GitHub (redeploys on every push):** in the Cloudflare dashboard, go to Workers & Pages → Create → Import a repository, pick this repo and deploy with the defaults.
   - **From a terminal, in this folder:** run `npx wrangler login`, then `npx wrangler deploy`.
3. **Add the webhook as a secret, never in a file in this repo.** Use either option:
   - **Dashboard:** open the Worker, go to Settings → Variables and Secrets and add a secret named `DISCORD_WEBHOOK`.
   - **Terminal:** run `npx wrangler secret put DISCORD_WEBHOOK` and paste the URL.
4. **Check it's live.** Open the Worker's URL (`https://tempest-crash-reports.<your-subdomain>.workers.dev`) in a browser. A "405" page means it's running.
5. **Send the Tempest team that URL with `/report` added to the end.** It goes in `REPORT_URL` in `Tempest.Launcher/electron/src/crash.ts`.

The launcher has this URL built in, so changing it later means a launcher release. To avoid that, put the Worker on a custom domain from the start (Worker → Settings → Domains & Routes).

## Testing

With a webhook in `.dev.vars` (`DISCORD_WEBHOOK=<url>`, ignored by git):

```bash
npx wrangler dev
```

Then run the launcher with `TEMPEST_CRASH_REPORT_URL=http://localhost:8787/report`.

## If it gets abused

Anyone can send requests here, and the limit only slows them down. Delete the webhook in Discord to stop everything at once, then set a new one as the secret. Treat attachments as untrusted: open them as data, and don't run anything from them.
