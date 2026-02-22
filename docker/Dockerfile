FROM python:3.11-slim

WORKDIR /app

# (opzionale ma consigliato) pacchetti utili per healthcheck e debug base
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY backend /app/backend

RUN python -m ensurepip --upgrade \
 && pip install --no-cache-dir -r /app/backend/requirements.txt \
 && pip install --no-cache-dir brping

ENV PYTHONUNBUFFERED=1
ENV DATA_DIR=/data

EXPOSE 80

# BlueOS Extension permissions
LABEL permissions="\
{\
  \"ExposedPorts\": { \"80/tcp\": {} },\
  \"HostConfig\": {\
    \"ExtraHosts\": [\"host.docker.internal:host-gateway\"],\
    \"PortBindings\": { \"80/tcp\": [{ \"HostPort\": \"\" }] },\
    \"Binds\": [\"/usr/blueos/extensions/calypso-ui:/data\"]\
  }\
}"

# BlueOS Extension metadata (mostrata in UI)
LABEL permissions="\
{\
  \"ExposedPorts\": { \"80/tcp\": {} },\
  \"HostConfig\": {\
    \"ExtraHosts\": [\"host.docker.internal:host-gateway\"],\
    \"PortBindings\": { \"80/tcp\": [{ \"HostPort\": \"\" }] },\
    \"Binds\": [\"/usr/blueos/extensions/calypso-ui:/data\"]\
  }\
}"

LABEL metadata="\
{\
  \"name\": \"Calypso UI\",\
  \"version\": \"0.4.0\",\
  \"description\": \"DeepEx ROV UI\",\
  \"company\": \"DeepEx\",\
  \"authors\": [\"DeepEx\"],\
  \"icon\": \"mdi-submarine\",\
  \"website\": \"https://github.com/erric0x5b/calypso-ui\",\
  \"tags\": [\"rov\",\"ui\",\"telemetry\"],\
  \"category\": \"Interface\"\
}"

# (opzionale) healthcheck: assume che il backend risponda su /health
# Se non hai /health, puoi puntare a /register_service o /docs (FastAPI) ma meglio /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:80/register_service >/dev/null || exit 1

CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "80"]