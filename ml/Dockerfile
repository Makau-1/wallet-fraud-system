# SecureWallet fraud scoring service (Python / FastAPI)
FROM python:3.12-slim

WORKDIR /srv/ml

COPY requirements-service.txt .
RUN pip install --no-cache-dir -r requirements-service.txt

COPY ml ./ml
COPY data/paysim_processed.csv data/paysim_processed.type_mapping.json ./data/
COPY train_model.py .

# The trained model is not committed, so it is built here from the
# committed data with the same parameters and seed as the notebook.
RUN python train_model.py

# Models trained or promoted from the admin console are kept in a volume,
# so they survive a rebuild. The first time, the volume is seeded with the
# model built above.
ENV MODEL_DIR=/srv/ml/models
VOLUME /srv/ml/models

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"

CMD ["sh", "-c", "mkdir -p \"$MODEL_DIR\" && { [ -f \"$MODEL_DIR/fraud_model.pkl\" ] || cp fraud_model.pkl \"$MODEL_DIR/\"; } && exec python -m uvicorn ml.app:app --host 0.0.0.0 --port 8000"]
