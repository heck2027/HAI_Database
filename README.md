<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/2e81340d-a45b-49c3-85ee-a39b89bbb247

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`


---

## Daily agent (automatic discovery + re-check)

Once a day the agent:

1. **Discovers** papers added to PubMed since the last run (date-windowed, so it never re-pulls the same top results), screens each with Gemini against the rubric, and adds passes as `AI Screened` / `Flagged for Review`. Rejected papers are remembered in a `seen` collection and never re-screened. Papers the agent could not screen (e.g. Gemini quota error) are retried the next day.
2. **Re-checks existing records** (oldest-checked first, `RECHECK_BATCH` per run):
   - PubMed records: flags retractions.
   - Web records (Tier 2/3, DOI links): flags links that return 404/410 on 2 checks or are unreachable on 3, and pages whose text changed by more than 10%.
3. Writes a summary to the `runs` collection and updates `meta/state`.

It **never** sets `Human Approved`, and never changes the status of a record a human already approved. It only adds a `needsRecheck` flag (shown in the UI with a "dismiss" button) — except that an `AI Screened` record that turns out to be retracted is moved to `Flagged for Review`.

### One-time setup

1. **Firestore**: in the Google Cloud console for your project, create a Firestore database (Native mode). On Cloud Run the service account needs the *Cloud Datastore User* role.
2. **Secrets / env vars** on the Cloud Run service: `GEMINI_API_KEY`, `NCBI_API_KEY`, `CRON_SECRET`. Also set **max instances = 1** (the app keeps a short-lived in-memory cache) and a **request timeout of 15 min**.
3. **Move existing data**: the first start on an empty Firestore automatically seeds it from the bundled `hai_database.json`.
4. **Schedule it** (Cloud Scheduler, daily at 6 am Eastern):

```bash
gcloud scheduler jobs create http hai-daily-run \
  --location=us-central1 \
  --schedule="0 6 * * *" --time-zone="America/New_York" \
  --uri="https://YOUR-SERVICE-URL/api/agent/daily-run" \
  --http-method=POST \
  --headers="x-cron-secret=YOUR_CRON_SECRET,Content-Type=application/json" \
  --message-body="{}" \
  --attempt-deadline=15m
```

### Testing and backfilling

```bash
# Dry run: screens and checks but writes nothing
curl -X POST $URL/api/agent/daily-run -H "x-cron-secret: $CRON_SECRET" \
     -H "Content-Type: application/json" -d '{"dryRun": true}'

# Backfill the last 90 days (repeat until "deferred" is 0; each call screens up to MAX_SCREEN_PER_RUN papers)
curl -X POST $URL/api/agent/daily-run -H "x-cron-secret: $CRON_SECRET" \
     -H "Content-Type: application/json" -d '{"sinceDays": 90}'

# Only re-check existing records
curl -X POST $URL/api/agent/daily-run -H "x-cron-secret: $CRON_SECRET" \
     -H "Content-Type: application/json" -d '{"skipDiscovery": true}'
```

`GET /api/agent/status` shows the last run, counts, and the 14 most recent run summaries.


### Deploying straight to Cloud Run (if AI Studio's Publish button fails)

The repo includes a `Dockerfile`. In the Cloud console: Cloud Run -> Create service -> "Continuously deploy from a repository" -> connect your GitHub repo (branch `main`, build type Dockerfile) -> allow public access -> under Containers > Variables, add `GEMINI_API_KEY`, `NCBI_API_KEY`, `CRON_SECRET`. The app reads Cloud Run's `PORT` automatically. Then point the Cloud Scheduler job at the new `https://...run.app/api/agent/daily-run` URL.
