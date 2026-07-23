SHELL := /bin/bash

.PHONY: help doc-check doc-guard fake-check fake-check-test agent-docs lint test release-check

help:
	@echo "Available commands:"
	@echo "  make help          Show this help"
	@echo "  make doc-check     Run local documentation checks"
	@echo "  make doc-guard     Run Doc Watch Guard report"
	@echo "  make fake-check    Run AI fake-completion implementation guard"
	@echo "  make agent-docs    Print a safe agent documentation review prompt"
	@echo "  make lint          Run docs-only lint placeholder"
	@echo "  make test          Run docs-only test placeholder"
	@echo "  make release-check Run documentation release checks"

doc-check:
	@./scripts/doc-check-local.sh

doc-guard:
	@./scripts/doc-guard.sh

fake-check:
	@./scripts/fake-implementation-guard.sh

fake-check-test:
	@./scripts/test-fake-implementation-guard.sh

agent-docs:
	@./scripts/agent-doc-review.sh

lint:
	@echo "No app lint configured for docs-only profile."

test:
	@echo "No app tests configured for docs-only profile."

release-check: doc-check doc-guard fake-check lint test
