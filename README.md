# RUX DAM

A very simple cloud digital asset manager for RUX. It indexes images and videos in
one or more Google Drive folders (subfolders included) and serves them in a
searchable web gallery. Drive stays the source of truth: to add, rename or delete
assets, do it in Drive and the DAM picks it up on the next sync.

**Features**
- Grid of all images and videos with thumbnails, infinite scroll
- Browse by the Google Drive folder tree, with asset counts per folder
- Metadata fields (Product, Activity, Color, Vehicle, Season, Event, Location, People,
  Tags, plus your own) on files or whole folders, with bulk tagging and sidebar filters
- Search by file name, folder path or metadata; filter by type (image or video)
- Tag suggestions from Claude (product, activity, color, vehicle, season, keywords) that you accept or dismiss
- Shareable links: the URL always reflects the current folder, filters, search and open asset
- Preview images and stream videos (with seeking) in the browser
- Download originals, open in Drive, copy a direct link
- Usage-rights flags: mark a file or a whole folder **Do not use** (with a note), filter by rights
- Auto re-sync every 10 minutes, plus a manual **Sync** button
- Optional shared password
- Works with My Drive and Shared Drives

## How it works

Sync only reads Google Drive: it finds new, changed, moved and removed images and videos.
Metadata (tags, usage rights, suggestions) is stored separately, keyed by each file's Drive
ID, so a sync or a redeploy never changes it. If a folder can't be read during a sync (a
Drive outage, a lost share), the assets already known under it are kept.

```
Browser ──► Node/Express (Cloud Run) ──► Google Drive API (read-only, service account)
```

The server crawls the configured folders and keeps an in-memory index. Thumbnails and
files are streamed through the server, so the Drive folders never have to be public.
The server only serves files that are in the index.

## Setup

### 1. Google Cloud
1. Create or choose a Google Cloud project and enable the **Google Drive API**:
   `gcloud services enable drive.googleapis.com`
2. Create a service account, for example `rux-dam@<project>.iam.gserviceaccount.com`. It needs no IAM roles.
3. In Google Drive, **share each asset folder with the service account's email** as *Viewer*.
   For a Shared Drive, add the service account as a member.

### 2. Configure

| Variable | Required | Description |
|---|---|---|
| `DRIVE_FOLDER_IDS` | yes | Folder IDs or full folder URLs, separated by spaces or commas (use spaces with `gcloud --set-env-vars`, which splits on commas) |
| `DAM_PASSWORD` | no | Shared password (browser login prompt, any username) |
| `REFRESH_MINUTES` | no | Re-scan interval, default `10` |
| `DATA_BUCKET` | no | Cloud Storage bucket for metadata (`tags.json`), usage rights (`rights.json`), Claude's suggestions (`suggestions.json`) and the last synced asset list (`index.json`). Without it, all of these are lost on every restart or deploy. `RIGHTS_BUCKET` is accepted as an older name |
| `SYNC_CONCURRENCY` | no | Drive folders listed in parallel during a sync, default `8` |
| `ANTHROPIC_API_KEY` | no | Claude API key. Turns on tag suggestions |
| `SUGGEST_MODEL` | no | Claude model for suggestions, default `claude-haiku-5-5` (`claude-sonnet-5-5` or `claude-opus-5-5` for higher accuracy at higher cost) |
| `SUGGEST_FIELDS` | no | Fields Claude fills in, default `product,activity,color,vehicle,season,tags` |
| `SUGGEST_CONCURRENCY` | no | Images sent to Claude in parallel, default `4` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | no | Service account key as raw JSON (if not using ADC) |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | Path to a key file (local dev) |
| `PORT` | no | Default `8080` |

On Cloud Run you don't need a key: the app uses the service account it runs as.

### 3. Run locally
```sh
npm install
export DRIVE_FOLDER_IDS="https://drive.google.com/drive/folders/XXXX"
export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
npm start   # http://localhost:8080
```

### 4. Deploy to Cloud Run
```sh
gcloud run deploy rux-dam \
  --source . \
  --region us-central1 \
  --service-account rux-dam@<project>.iam.gserviceaccount.com \
  --set-env-vars DRIVE_FOLDER_IDS="<id1> <id2>",DAM_PASSWORD="<password>" \
  --allow-unauthenticated \
  --min-instances 1
```
`--min-instances 1` keeps the index warm so it isn't rebuilt on every cold start. Also add
`--no-cpu-throttling` ("CPU is always allocated" in the console): otherwise Cloud Run
throttles the CPU between requests, which stalls the startup scan and the periodic re-sync.
For Google-account sign-in in place of a shared password, put Cloud Run behind
Identity-Aware Proxy and drop `DAM_PASSWORD`.

The included `Dockerfile` also runs on any container host (Fly.io, Render, Railway).
There, pass the key through `GOOGLE_SERVICE_ACCOUNT_JSON`.

## Folders and metadata

The sidebar shows the Drive folder tree; selecting a folder shows everything inside it,
including subfolders.

Each asset can carry several values in each metadata field. The default fields are
Product, Activity, Color, Vehicle, Season, Event, Location, People and Tags; add more
with **+ Add a field** in the sidebar.

- **Tag a folder**: select it in the tree and add values in the panel above the grid.
  Folder values apply to everything inside it (shown as dashed chips on the assets).
  Folders with tags have a dot in the tree.
- **Tag one asset**: open it and use the **Metadata** section.
- **Tag many at once**: tick the checkbox on a card (shift-click to select a range, or
  **Select all loaded**), then use the bar at the bottom to add or remove a value.
- **Filter**: the sidebar lists the values in use with counts. Values within a field are
  combined with OR, different fields with AND. Search also matches metadata values.

Values are case-insensitive and reuse the first spelling entered, so "duffel" becomes
"Duffel" if that already exists. Metadata is keyed by Drive ID, so it survives renames
and moves inside the indexed folders.

## Tag suggestions from Claude

With `ANTHROPIC_API_KEY` set, Claude looks at previews (768px Drive thumbnails; for videos,
the poster frame) along with file and folder names, and suggests metadata plus a one-line
description that search also matches. It reuses values already in use and your preset values
(see below), so suggestions stay consistent. Nothing becomes a tag until you accept it.

The cheapest way to tag a library, in order:

1. **Shoot tags (one request per folder).** Select a shoot folder and click **Suggest shoot tags
   from 6 sample photos**. Claude looks at up to 6 photos spread across the folder and suggests
   Activity, Season, Location, Event, Vehicle and Tags that fit the whole shoot. Accept them and
   every photo in the folder inherits them.
2. **Per-photo tags.** **✨ Suggest tags for each of the N photos** (or **✨ Suggest tags** on a
   selection, or **Suggest tags** in the viewer) fills in what varies per photo, like Product and
   Color. Values already inherited from the folder aren't suggested again.
   - Up to 50 photos run right away.
   - **More than 50 photos run through the Message Batches API at half price.** Results usually
     arrive within an hour (at most 24 hours). Batches are tracked in the data bucket, so results
     are collected even if the service restarts; the page can be closed meanwhile.

A bar shows progress, running batches and the running cost; **Stop** cancels queued work and
running batches. Photos that already have suggestions are skipped. To review, choose
**✨ Suggestions to review** in the header: suggested values show in purple on each card. In the
viewer (or folder panel), ✓ accepts a value, × dismisses it, or use **Accept all**; to accept
everything for many photos, select them and click **Accept suggestions**.

**Cost.** The default model is Claude Haiku 5.5: roughly $0.0004 per photo, so about $4 per 10,000
photos, and half that in batches. Instructions and the vocabulary come first in every request and
are cached, so after the first request they cost about a tenth. For higher accuracy (e.g. telling
similar products apart) set `SUGGEST_MODEL=claude-sonnet-5-5` (~20× the cost) or `claude-opus-5-5`
(~40×); the cost estimates in the app follow the model.

Suggestions are stored as `suggestions.json` in the data bucket.

### Product catalog and preset values

**Edit field values** (sidebar) holds a preset list per field: these appear in autocomplete,
and Claude uses these exact names when suggesting tags, even before anything is tagged with
them. To load the RUX catalog, export products from Shopify (**Products → Export → All
products, CSV for Excel, Numbers, or other spreadsheet programs**) and click **Import a
Shopify products CSV**. It adds every active product's title to Product and every value of a
Color/Colour option to Color; review and edit both lists, then **Save**.

**Cost**: about $0.02 per image with the default model (≈2,000 input and ≈600 output
tokens), so ~$100 per 5,000 images. `SUGGEST_MODEL=claude-sonnet-5-5` roughly halves that and
`claude-haiku-5-5` is far cheaper, with less accurate results; try a folder first and compare.

**Setup** (keep the key in Secret Manager rather than a plain environment variable):

```sh
printf '%s' 'sk-ant-...' | gcloud secrets create anthropic-api-key --data-file=-
gcloud secrets add-iam-policy-binding anthropic-api-key \
  --member=serviceAccount:rux-dam@<project-id>.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
gcloud run services update rux-dam --region <region> --update-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest
```

Background runs need CPU allocated outside requests (`--no-cpu-throttling`), and a run in
progress is lost if the service restarts; finished suggestions are kept, so just start it again.

## Shareable links

The address bar always reflects what's on screen: folder, search, type, rights, metadata
filters and the open asset. **Copy link to this view** (above the grid) and **Copy link to
this asset** (in the viewer) copy it, e.g.
`…/?tag=product:Duffel&tag=season:Winter&rights=cleared` opens straight to cleared Duffel
photos tagged Winter. People opening the link need the app's password, if one is set.

## Usage rights

Every asset is **Cleared** by default. In the viewer, choose **Do not use** (optionally
with a note), pick whether it applies to *this file only* or to one of its enclosing
folders, and click **Save rights**. A folder flag covers everything inside it; a flag on
a file or a deeper folder overrides it. **Remove flag** deletes the flag from the selected
file or folder so it falls back to the folder above (or the default).

Restricted assets show a red **Do not use** badge, can be filtered with the rights
selector, and ask for confirmation before downloading.

Flags are keyed by Drive ID, so they survive renames and moves inside the indexed folders.
They are stored as `rights.json` in the Cloud Storage bucket, next to `tags.json`:

```sh
gcloud storage buckets create gs://<project-id>-rux-dam-rights --location=<region> --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding gs://<project-id>-rux-dam-rights \
  --member=serviceAccount:rux-dam@<project-id>.iam.gserviceaccount.com --role=roles/storage.objectUser
gcloud run services update rux-dam --region <region> --update-env-vars DATA_BUCKET=<project-id>-rux-dam-rights
```

Turn on object versioning on the bucket (`gcloud storage buckets update gs://… --versioning`)
if you want to be able to restore earlier flags.

Anyone who can open the app can change flags (there are no per-user accounts), so keep
`DAM_PASSWORD` on outside of testing.

## Development
```sh
npm test   # runs without Google credentials (uses a fake Drive)
```

## Limits (by design, to keep it simple)
- Read-only: uploads, tags and edits happen in Drive.
- The asset index lives in memory (fine for tens of thousands of assets). With a data bucket it is also
  saved after each sync, so a restart shows it immediately and re-checks Drive in the background.
- One shared password; there are no per-user accounts.
