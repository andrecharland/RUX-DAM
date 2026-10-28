# RUX DAM

A very simple cloud digital asset manager for RUX. It indexes images and videos in
one or more Google Drive folders (subfolders included) and serves them in a
searchable web gallery. Drive stays the source of truth: to add, rename or delete
assets, do it in Drive and the DAM picks it up on the next sync.

**Features**
- Grid of all images and videos with thumbnails, infinite scroll
- Search by file name or folder path; filter by type (image or video) and by top-level folder
- Preview images and stream videos (with seeking) in the browser
- Download originals, open in Drive, copy a direct link
- Auto re-sync every 10 minutes, plus a manual **Sync** button
- Optional shared password
- Works with My Drive and Shared Drives

## How it works

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
`--min-instances 1` keeps the index warm so it isn't rebuilt on every cold start.
For Google-account sign-in in place of a shared password, put Cloud Run behind
Identity-Aware Proxy and drop `DAM_PASSWORD`.

The included `Dockerfile` also runs on any container host (Fly.io, Render, Railway).
There, pass the key through `GOOGLE_SERVICE_ACCOUNT_JSON`.

## Development
```sh
npm test   # runs without Google credentials (uses a fake Drive)
```

## Limits (by design, to keep it simple)
- Read-only: uploads, tags and edits happen in Drive.
- The index lives in memory: fine for tens of thousands of assets, and it rebuilds on restart.
- One shared password; there are no per-user accounts.
