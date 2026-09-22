FROM node:22-bookworm-slim AS node

FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NODE_ENV=production \
    PORT=8080 \
    SKEY_PYTHON=/opt/venv/bin/python

COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

COPY engine/requirements.txt engine/requirements.txt
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.1 torchaudio==2.7.1 \
 && /opt/venv/bin/pip install -r engine/requirements.txt \
 && /opt/venv/bin/python -c "import torch, torchaudio, nnAudio, soundfile, einops, scipy"

COPY package.json ./
COPY engine/ engine/
COPY skey-adapter/ skey-adapter/
COPY src/ src/

RUN useradd --system --uid 10001 --home-dir /app keyqc \
 && mkdir -p /tmp/key-qc && chown keyqc /tmp/key-qc
USER keyqc

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
