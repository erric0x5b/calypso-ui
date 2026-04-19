FROM python:3.11-slim

WORKDIR /app

# Toolchain minima per buildare dipendenze native anche su arm/v7.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg \
    libxml2-dev \
    libxslt1-dev \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

# Dipendenze minime (togli curl per ridurre peso e punti di failure)
RUN python -m ensurepip --upgrade

COPY backend /app/backend/

RUN pip install --no-cache-dir -r /app/backend/requirements.txt

ENV PYTHONUNBUFFERED=1
ENV DATA_DIR=/data

EXPOSE 80 14590/udp 14591/udp 5010/udp

# --- BlueOS labels (allineate alla doc) ---
LABEL version="0.4.5"

LABEL permissions='{\
  "ExposedPorts": {\
    "80/tcp": {},\
    "14590/udp": {},\
    "14591/udp": {},\
    "5010/udp": {}\
  },\
  "HostConfig": {\
    "ExtraHosts": ["host.docker.internal:host-gateway"],\
    "PortBindings": {\
      "80/tcp": [\
        {\
          "HostPort": ""\
        }\
      ],\
      "14590/udp": [\
        {\
          "HostPort": "14590"\
        }\
      ],\
      "14591/udp": [\
        {\
          "HostPort": "14591"\
        }\
      ],\
      "5010/udp": [\
        {\
          "HostPort": "5010"\
        }\
      ]\
    },\
    "Binds": [\
      "/usr/blueos/extensions/it.deepex.calypso-ui:/data"\
    ]\
  }\
}'

LABEL authors='[\
  {\
    "name": "DeepEx",\
    "email": "support@deepex.example"\
  }\
]'

LABEL company='{\
  "about": "ROV systems and marine exploration technologies",\
  "name": "DeepEx",\
  "email": "support@deepex.it"\
}'

LABEL type="interface"

LABEL readme="https://raw.githubusercontent.com/erric0x5b/calypso-ui/{tag}/README.md"

LABEL links='{\
  "website": "https://github.com/erric0x5b/calypso-ui",\
  "support": "https://github.com/erric0x5b/calypso-ui/issues"\
}'

LABEL requirements="core >= 1.1"

# Avvio server (come doc usa ENTRYPOINT; qui avviamo uvicorn)
ENTRYPOINT ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "80"]
