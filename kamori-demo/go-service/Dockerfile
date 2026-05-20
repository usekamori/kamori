# ── Build stage ────────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder
WORKDIR /project
COPY sdks/go ./sdks/go
COPY kamori-demo/go-service ./kamori-demo/go-service
WORKDIR /project/kamori-demo/go-service
RUN go build -o /ingest .

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM alpine:3.19
COPY --from=builder /ingest /ingest
CMD ["/ingest"]
