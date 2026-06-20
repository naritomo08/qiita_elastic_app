FROM golang:1.24-alpine AS builder

WORKDIR /src
COPY backend_go/go.mod backend_go/*.go ./
RUN go test ./...
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server .

FROM alpine:3.20

RUN apk add --no-cache ca-certificates
COPY --from=builder /out/server /usr/local/bin/server

EXPOSE 5000
CMD ["server"]
