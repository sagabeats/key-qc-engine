# key-qc

Key QC as a service: a producer key and a WAV go in, and PASS or HOLD comes out.

This is the `/api/key-qc` path of the Key Detector, taken out of its Vite dev
server so it can run on the VPS. The detection and the verdict are unchanged:

| Part | Source in Key Detector | Here |
| --- | --- | --- |
| S-KEY engine and weights | `engine/skey/`, `engine/LICENSE`, `engine/UPSTREAM.md` | `engine/` (byte-identical; the files are LF, and the SHA-256 values in `UPSTREAM.md` were taken from CRLF copies) |
| Python adapter | `skey-adapter/analyze.py` | `skey-adapter/analyze.py` |
| Relation, thresholds, verdict | `qc-ui/src/key-relation.js`, `qc-status.js`, `production-decision.js` | `src/rules/` (verbatim) |
| HTTP endpoint | `/api/key-qc` in `qc-ui/vite.config.js` | `src/server.js` |

The staff UI, Benchmark Mode and the Review Queue stay in the Key Detector.
If you change a rule or the engine there, copy it here too.

## API

`POST /api/key-qc`

| Header | Value |
| --- | --- |
| `X-API-Key` | `KEY_QC_API_KEY` |
| `X-Producer-Key` | URL-encoded key, e.g. `D%23%20minor` (or `?producerKey=`) |
| `X-File-Name` | optional, echoed back |
| `Content-Length` | required |

The body is the raw audio. The response has the same shape the Key Detector
returns: `producerKey`, `detectedKey`, `relation`, `verdict`, `qcStatus`,
`action`, `reason`, `winnerProbability`, `winnerMarginPp`, `thresholds` and
`candidates`.

`GET /health` returns 200 once the Python runtime, the engine and the adapter
are all in place.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `KEY_QC_DOMAIN` | none | Host Traefik routes (compose only) |
| `KEY_QC_API_KEY` | none | Required when `NODE_ENV=production` |
| `KEY_QC_MAX_CONCURRENT` | `2` | Analyses at once; further requests wait their turn |
| `KEY_QC_TIMEOUT_MS` | `600000` | Per analysis |
| `KEY_QC_MAX_AUDIO_BYTES` | `1073741824` | |
| `SKEY_PYTHON` | `/opt/venv/bin/python` in the image | |

## Run locally

```bash
docker build -t key-qc:local .
docker run --rm -p 8080:8080 -e KEY_QC_API_KEY=dev key-qc:local
```

## Deploy (VPS)

This follows the crm-monorepo's setup: Traefik (`reverse-proxy`, `websecure`,
`myresolver`, `crowdsec@docker`) on the external `project-network`, images on
GHCR, and Watchtower pulling `:prod`.

1. Push to `main`. The workflow builds `ghcr.io/sagabeats/key-qc:prod`.
2. Point a DNS A record for `KEY_QC_DOMAIN` at the VPS.
3. On the VPS, once:
   ```bash
   git clone https://github.com/sagabeats/key-qc.git && cd key-qc
   cp .env.example .env
   docker compose pull && docker compose up -d
   ```
   In `.env`, set `KEY_QC_DOMAIN`, and set `KEY_QC_API_KEY` to the output of
   `openssl rand -hex 32`.
4. Check it: `curl https://$KEY_QC_DOMAIN/health`.
5. In lana-frontend, set `KEY_QC_URL=https://$KEY_QC_DOMAIN` and
   `KEY_QC_API_KEY` to the same key.

After that, every push to `main` is picked up by Watchtower within a few minutes.
A change to compose or `.env` needs `git pull && docker compose up -d` on the VPS.

In a local test, a 4-minute 24-bit stereo WAV (63 MB) took 6 s and peaked at
about 400 MB. The container is limited to 2 GB, which leaves headroom for the
default of 2 concurrent analyses.
