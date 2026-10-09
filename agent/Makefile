VERSION ?= dev
IMAGE   ?= ghcr.io/krystianslowik/skald-agent

.PHONY: build test lint run image

build:
	go build -o bin/skald-agent ./cmd/agent

test:
	go test -race ./...

lint:
	go vet ./...

run:
	go run ./cmd/agent

image:
	docker buildx build --platform linux/amd64 -t $(IMAGE):$(VERSION) --load .
