FROM python:3.11-slim

WORKDIR /app

# ... (la tua base image Python)
RUN python -m ensurepip --upgrade
RUN pip install --no-cache-dir -r /app/backend/requirements.txt
RUN pip install --no-cache-dir fastapi uvicorn[standard]
RUN pip install --no-cache-dir brping

COPY backend /app/backend

ENV PYTHONUNBUFFERED=1

EXPOSE 8080
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8080"]