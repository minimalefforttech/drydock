# 0005 - Product identity and namespace

Status: Accepted - 2026-07-06

Refs: `docs/design/roadmap.md`

## Context

The project started with working names like "Security First Agent PoC" and
`vscode-ai`. Before release, the product name and public ids need to stop
moving.

## Decision

The product name is Drydock.

The VS Code extension id is `local.drydock`. Commands, views, and
configuration keys use the `drydock.*` prefix. Packages use the `@drydock/*`
scope. The diff baseline URI scheme is `drydock-baseline`.

Old names can stay in docs when they explain history. New product names and
APIs use Drydock.

## Consequences

Old settings do not automatically migrate. The state root follows the extension
id unless `drydock.stateRoot` points at an older store.
