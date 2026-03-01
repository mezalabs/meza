FROM golang:1.24-alpine AS builder

ARG SERVICE

RUN apk add --no-cache git

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .

RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app ./cmd/${SERVICE}

FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata
RUN addgroup -g 1000 meza && adduser -u 1000 -G meza -D meza

COPY --from=builder /app /usr/local/bin/app

USER meza
EXPOSE 8080

ENTRYPOINT ["app"]
