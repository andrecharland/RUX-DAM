# RUX DAM

A very simple cloud digital asset manager for RUX. It indexes images and videos in
one or more Google Drive folders (subfolders included) and serves them in a
searchable web gallery. Drive stays the source of truth: to add, rename or delete
assets, do it in Drive and the DAM picks it up on the next sync.

**Features**
- Justified grid that keeps each photo's shape, grouped by month, with a size slider and a
  jump-to-date scrubber; infinite scroll
- Browse by the Google Drive folder tree, or by shoot cards with cover photos and date spans
- Active filters shown as removable chips above the grid, with **Clear all**
- Viewer with previous/next (arrow keys), a filmstrip, zoom to 100%/200% (Z, drag to pan),
  **More from this shoot** and **More like this**
- Visual similarity and search by description with Vertex AI (optional)
- Metadata fields (Product, Activity, Color, Vehicle, Season, Collection season, Event, Location,
  People, Tags, plus your own) on files or whole folders (a folder's details panel folds away), with bulk tagging and sidebar filters
- Search by file name, folder path or metadata; filter by type (image or video)
- Filter by file details: date taken (presets or a custom range), year, format (JPG, RAW, HEIC,
  MP4, MOV…), orientation, resolution, file size, video length and camera; sort by date taken,
  date added, name, file size or video length
- Tag suggestions from Claude (product, activity, color, vehicle, season, keywords) that you accept or dismiss
- Star ratings (one per photo for the team), personal favorites, and team collections
- Shareable links: the URL always reflects the current folder, filters, search and open asset
- Preview images and stream videos (with seeking) in the browser; videos the browser can't play
  (H.265/HEVC, some MOVs) switch to Google Drive's own player, which streams any format Drive has
  processed for people who can open the file in Drive (an **Original / Drive player** switch is in the viewer)
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
| `GOOGLE_CLIENT_ID` | no | OAuth client ID. Turns on "Sign in with Google" (replaces `DAM_PASSWORD`) |
| `GOOGLE_CLIENT_SECRET` | with sign-in | OAuth client secret (use Secret Manager) |
| `ALLOWED_DOMAINS` | with sign-in | Google Workspace domains allowed in, e.g. `rux.life` |
| `ALLOWED_EMAILS` | no | Individual Google accounts allowed in besides those domains (freelancers, agencies) |
| `SESSION_SECRET` | with sign-in | Random string that signs sessions (use Secret Manager); without it, restarts sign everyone out |
| `DAM_PASSWORD` | no | Shared password (browser login prompt, any username), used only when Google sign-in is off |
| `REFRESH_MINUTES` | no | Re-scan interval, default `10` |
| `DATA_BUCKET` | no | Cloud Storage bucket for metadata (`tags.json`), usage rights (`rights.json`), Claude's suggestions (`suggestions.json`), ratings, favorites and collections (`curation.json`), the last synced asset list (`index.json`) and cached previews (`thumbs/`). Without it, all of these are lost on every restart or deploy. `RIGHTS_BUCKET` is accepted as an older name |
| `SYNC_CONCURRENCY` | no | Drive folders listed in parallel during a sync, default `8` |
| `ANTHROPIC_API_KEY` | no | Claude API key. Turns on tag suggestions |
| `SUGGEST_MODEL` | no | Claude model for suggestions, default `claude-haiku-5-5` (`claude-sonnet-5-5` or `claude-opus-5-5` for higher accuracy at higher cost) |
| `SUGGEST_FIELDS` | no | Fields Claude fills in, default `product,activity,color,vehicle,season,tags` |
| `SUGGEST_CONCURRENCY` | no | Images sent to Claude in parallel, default `4` |
| `VERTEX_EMBEDDINGS` | no | `on` turns on visual similarity and search by description (see below) |
| `VERTEX_LOCATION` | no | Vertex AI region, default `us-central1` |
| `VERTEX_RPM` | no | Fingerprinting requests per minute, default `100` |
| `GOOGLE_CLOUD_PROJECT` | no | Project for Vertex AI; detected automatically on Cloud Run |
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

## Speed

- Previews come from Drive once per size (256, 512, 1024 or 2048 px, rounded up from what's
  displayed), then from memory or the bucket's `thumbs/` folder. Each preview URL carries the file's
  version, so browsers keep previews until the file changes in Drive.
- The grid asks for the size each tile needs (row height, shape and screen density); dragging the
  size slider larger swaps in bigger previews.
- The viewer opens on the grid's preview and sharpens when the large one arrives; the previews
  either side are loaded in the background, so ← → is instant.
- API responses are compressed.

`thumbs/` grows with use (a few hundred KB per photo across sizes). To cap it, add a lifecycle rule
to the bucket that deletes objects under `thumbs/` after, say, 180 days; they're refetched on demand.

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

## Ratings, favorites and collections

- **Ratings**: 1 to 5 stars per photo or video, one rating shared by the whole team. In the viewer
  press 1–5 (0 clears) or click the stars; for a selection use **★ Rate…** in the selection bar.
  Filter with **Rating** in the sidebar ("★★★★ and up") and sort by **Highest rated**.
- **Favorites**: ♥ on a tile, the ♥ in the viewer, or F. Favorites are personal (by Google
  account; shared by everyone when sign-in is off) and listed under **My favorites**.
- **Collections**: hand-picked sets anyone on the team can make and edit, independent of the Drive
  folders (an asset can be in several). Use **+ Collection** in the viewer or **Add to collection…**
  for a selection; tick or untick collections, or name a new one. Collections are listed in the
  sidebar, keep the order items were added (other sorts still work), and can be renamed, described,
  linked to (**Copy link**) or deleted; **Remove from this collection** works on a selection.
  Links work for anyone who can sign in to the DAM.

All three are stored as `curation.json` in the data bucket.

## Titles and RUX file names

Titles come from metadata. The naming fields, Product, Concept family, Format (Photo or Video),
Aspect, Creator, Shoot date and Version, make up the RUX Paid Social Creative Playbook convention:

`RUX_[Product]_[ConceptFamily]_[Format]_[Aspect]_[Creator]_[YYYY-MM-DD]_v01`
e.g. `RUX_GearBox70L_Proof_Video_9x16_Cal_2026-06-08_v01`

A folder or file with any naming field of its own gets:

- a **title** in plain words, shown in place of the Drive name (folder tree, breadcrumbs, cards,
  viewer), e.g. "Gear Box 70L · Proof · Video 9x16 · by Cal · Jun 8, 2026 · version 1"; several values
  are all listed ("Gear Box 70L + Duffel");
- a **RUX_ name**, shown in its details and used as the download file name (original extension
  kept). It uses the first value of each field, leaves out empty ones, and is built as you'd expect:
  "Gear Box 70L" becomes `GearBox70L`, a leading "RUX" is dropped from products, "9:16" becomes `9x16`.

Every field is optional. Each field uses the item's own values, else the ones inherited from its
folders: files in a named shoot keep their Drive file name, while a final edit given its own
Version gets a title with the shoot's Product and its own version. Change a tag and the title and
name change with it; nothing in Drive is renamed. **Start from file details** fills in Format, Shoot
date and (for files) Aspect from Drive, or every part when the Drive name already follows the
convention. Shoot dates are stored as YYYY-MM-DD and versions as plain numbers ("v2" becomes 2).

Labels saved by earlier versions were moved into these fields on first load.

## Platform readiness

Every photo and video is checked against the platform specs in the RUX Paid Social Creative
Playbook: Reels and Stories (9:16, 1080×1920), Feed 4:5 (1080×1350), Feed 1:1 and Carousel
(1080×1080), and Google landscape (1.91:1, 1200×628), square (1200×1200) and portrait (4:5,
960×1200). For each placement an asset is:

- **Ready**: the right shape and at least the minimum size;
- **Crop needed**: a centered crop to that shape would still meet the minimum (the playbook asks for
  deliberate crops rather than relying on auto-cropping), with the crop size;
- **Too small**: not enough pixels either way.

The **Ready for** filter (under File details) lists assets usable for a placement, as they are or
with a deliberate crop. (The viewer's per-placement table and 9:16 safe-zone overlay were removed
for now; they may come back with an export or crop feature.)

## More like this and search by description

The viewer's **More like this** shows assets that look similar; **See all** opens them as a
grid (`?like=<id>`). Without Vertex AI it ranks by shared tags, the same shoot folder, a nearby
date and the same shape. With Vertex AI it compares the photos themselves, and the search box
also finds photos by description ("snowy ride", "red bag on a tailgate"), shown after the name
and tag matches under **Looks like "…"**.

To turn on Vertex AI (Google's multimodal embeddings; about $0.0001 per image, once):

```bash
gcloud services enable aiplatform.googleapis.com
gcloud projects add-iam-policy-binding rux-dam \
  --member=serviceAccount:rux-dam@rux-dam.iam.gserviceaccount.com --role=roles/aiplatform.user
gcloud run services update rux-dam --region us-west2 --update-env-vars VERTEX_EMBEDDINGS=on
```

After each sync, new assets are fingerprinted in the background from a 512px preview and the
results are saved as `embeddings.json` in `DATA_BUCKET`, so it happens only once per file.
Progress is in `/api/status` under `similarity` (`indexed`, `total`, `pending`, and
`lastError` if requests fail).

## Finding files by date, format and size

The **File details** filters in the sidebar come from Google Drive's file information:

- **Date taken**: Last 7 days, Last 30 days, Last 12 months, This year, or a custom range. It uses
  the capture date the camera wrote into the photo when there is one, otherwise the date the
  file was added to Drive (videos always use the date added). **Year taken** lists years with counts.
- **File type** (RAW covers CR2/CR3, NEF, ARW, DNG, RAF and other camera raw files), **Orientation**
  (landscape, portrait, square, panorama), **Resolution** (under 2 MP for web up to 24 MP+ for print),
  **File size**, **Video length** and **Camera**.

Values within one group are combined with OR, different groups with AND, and each group's counts
show what selecting another value would add. The header's sort menu orders results by newest or
oldest taken, recently added, name, largest file or longest video. The search box also matches
camera, format and year (e.g. `raw 2025`, `iphone`). All of it is kept in the address bar, so
links like `?range=30d&f=orientation:Portrait` can be shared.

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

## Google sign-in

With `GOOGLE_CLIENT_ID` set, everyone signs in with their Google account and only accounts in
`ALLOWED_DOMAINS` (checked with Google's Workspace domain claim, not just the email text) or listed
in `ALLOWED_EMAILS` get in. Sessions last 7 days; the header shows who's signed in, with **Sign out**.

Setup:

1. **Google Cloud Console → Google Auth Platform** (formerly *OAuth consent screen*) → **Get started**:
   app name `RUX Assets`, your support email, and audience **Internal** if the project belongs to the
   rux.life Google Workspace organization (otherwise **External**; the app only asks for name and
   email, so it needs no Google verification).
2. **Clients → Create client → Web application**, with the authorized redirect URI
   `https://<your-service-url>/auth/callback`. Copy the client ID and secret.
3. In Cloud Shell:

```sh
read -rs -p "OAuth client secret: " S; echo
printf '%s' "$S" | gcloud secrets create oauth-client-secret --data-file=-; unset S
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create session-secret --data-file=-
for s in oauth-client-secret session-secret; do
  gcloud secrets add-iam-policy-binding $s \
    --member=serviceAccount:rux-dam@<project-id>.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
done
gcloud run services update rux-dam --region <region> \
  --update-env-vars GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com,ALLOWED_DOMAINS=rux.life \
  --update-secrets GOOGLE_CLIENT_SECRET=oauth-client-secret:latest,SESSION_SECRET=session-secret:latest
```

Keep the Cloud Run service's public access on: the app itself does the sign-in.

## Development
```sh
npm test           # unit and API tests; no Google credentials needed (fake Drive)
npm run test:e2e   # drives the real front end in headless Chromium against a fake Drive,
                   # Claude and Vertex AI (needs Playwright: npm i -D playwright && npx playwright install chromium;
                   # skipped when it isn't installed). Makes a short test video with ffmpeg if available.
```

## Code layout

```
src/
  server.js        createApp(): middleware order (headers, access, CSRF, static) and the API routers
  start.js         production start-up: builds every service from environment variables
  routes/          API by area: assets (browse, search, similar, status, sync), metadata (fields,
                   tags, rights), curation, suggest (Claude), media (previews and file proxy)
  security.js      security headers, CSRF check, rate limits, video range limits
  auth.js          Google sign-in and signed session cookies; access.js: shared password
  library.js       the in-memory index, search and filters, folder stats
  drive.js         Google Drive client (crawl, previews, media); google.js: auth and retries
  store.js         JSON documents in Cloud Storage with conditional writes
  tags.js, rights.js, curation.js, suggest.js, embeddings.js, thumbcache.js: the stores and services
public/
  index.html, style.css
  js/              ES modules: core (state, DOM, API), url, previews, grid, filters, folders,
                   tags, selection, suggest, curation, titles, viewer; main.js wires events and starts
  naming.js, shopify.js, specs.js   shared with the server (UMD)
test/              unit and API tests (npm test)
e2e/               browser tests against a fake Drive, Claude and Vertex AI (npm run test:e2e)
```

## Security

- Access needs Google sign-in or the shared password; the server refuses to start with neither
  unless `ALLOW_ANONYMOUS=1` is set. Sessions are signed cookies (HttpOnly, SameSite=Lax, Secure),
  re-checked against the allowed domains and emails on every request.
- Requests that change anything are refused when they come from another site (CSRF).
- Pages send a Content-Security-Policy (scripts only from the app; only Google's Drive player may be
  framed; the app can't be framed), `nosniff`, `X-Frame-Options` and HSTS. API answers aren't cached.
- The file proxy serves only files in the index; anything but raster images and video (e.g. SVG,
  which can contain scripts) is downloaded rather than shown.
- Claude and visual search are rate-limited per person (30 Claude requests and 60 visual searches a
  minute); asking again for photos that already have suggestions is limited to 500 at a time.
- File names and text in images are treated as data in Claude's instructions; its suggestions only
  apply when someone accepts them.

## Limits (by design, to keep it simple)
- Read-only: uploads, tags and edits happen in Drive.
- The asset index lives in memory (fine for tens of thousands of assets). With a data bucket it is also
  saved after each sync, so a restart shows it immediately and re-checks Drive in the background.
- Access is all-or-nothing per person: anyone allowed in sees every indexed folder (it doesn't
  mirror each Drive folder's own sharing).
