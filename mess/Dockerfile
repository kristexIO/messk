FROM golang:1.26-alpine AS build

ARG APP_VERSION=dev
ARG COMMIT_SHA=unknown
ARG BUILD_TIME=unknown

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.appVersion=${APP_VERSION} -X main.commitSHA=${COMMIT_SHA} -X main.buildTime=${BUILD_TIME}" -o /out/e2ee-messenger .

FROM alpine:3.22

WORKDIR /app
RUN adduser -D -H appuser && mkdir -p /app/uploads /app/data && chown -R appuser:appuser /app
COPY --from=build /out/e2ee-messenger /app/e2ee-messenger

USER appuser
EXPOSE 8080

ENV PORT=8080
ENV DB_PATH=/app/data/messenger.db
ENV UPLOAD_DIR=/app/uploads
ENV MAX_UPLOAD_MB=25
ENV ALLOWED_UPLOAD_MIME_TYPES=application/octet-stream
ENV FILE_TOKEN_TTL_MINUTES=60
ENV SESSION_TOKEN_TTL_MINUTES=1440
ENV RATE_LIMIT_PER_MINUTE=200
ENV ENABLE_METADATA_PROXY=false

CMD ["/app/e2ee-messenger"]
