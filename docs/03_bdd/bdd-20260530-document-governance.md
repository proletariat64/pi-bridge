---
title: "Document Governance Behavior"
doc_type: "bdd"
status: "draft"
owner: "product-agent"
source: "agent"
created: "2026-05-30"
updated: "2026-05-30"
related_issue: "#1"
related_pr: ""
supersedes: ""
---

# Document Governance Behavior

Feature: Dogsquard document governance
  Dogsquard must keep project documents organized, traceable, and protected while allowing agents to assist with drafting and cleanup.

  Background:
    Given Dogsquard uses `docs/` as the project documentation root
    And the human user is the final authority for business meaning
    And GitHub Issue `#1` is the Control Board

  Scenario: Generated document goes to inbox when type is unclear
    Given an agent creates a generated document
    And the document type is unclear
    When the agent stores the document
    Then the document must be placed in `docs/00_inbox/`
    And the document should receive inbox metadata when safely possible

  Scenario: BRD is protected from silent agent modification
    Given a BRD exists in `docs/01_brd/`
    When an agent wants to change business meaning in the BRD
    Then the agent must request explicit user approval
    And the agent must not silently rewrite the BRD

  Scenario: PRD and BDD must be updated when product behavior changes
    Given a change modifies product behavior or user-visible scope
    When the change is prepared for review
    Then a relevant PRD in `docs/02_prd/` must be updated or created
    And a relevant BDD document in `docs/03_bdd/` must be updated or created

  Scenario: ADR is required when architecture direction changes
    Given a change introduces or changes architecture direction
    When the change is prepared for review
    Then an ADR must be added or updated in `docs/04_adr/`
    And the ADR must describe context, decision, consequences, and alternatives

  Scenario: Doc Watch Guard can rename, move, and archive without inventing meaning
    Given Doc Watch Guard detects misplaced or badly named documents
    When it prepares a cleanup
    Then it may rename documents according to naming rules
    And it may move documents to the correct folder
    And it may archive superseded documents when safe
    But it must not invent product meaning

  Scenario: skip-docs is allowed only later through explicit label and justification
    Given a future documentation gate supports a `skip-docs` label
    When a PR uses `skip-docs`
    Then the PR must include explicit justification
    And the bypass must be visible in review
    And the bypass must not be treated as permission to ignore governance permanently

  Scenario: Approved documents cannot be silently rewritten
    Given a document has `status: "approved"`
    When an agent proposes a content change
    Then the change must be explicit in the PR
    And the change must not silently alter approved meaning

  Scenario: Stale inbox documents are reported
    Given documents exist in `docs/00_inbox/`
    When Doc Watch Guard scans the repository
    Then stale inbox documents must be reported
    And the report should recommend classify, archive, or keep actions

  Scenario: Duplicate generated documents are reported
    Given multiple generated documents appear to cover the same topic
    When Doc Watch Guard scans the repository
    Then duplicate documents must be reported
    And the documents must not be merged silently

  Scenario: Control Board is updated after major phase changes
    Given a major Dogsquard phase is completed
    When the implementation branch is prepared
    Then GitHub Issue `#1` must be updated when possible
    And the Current Task and Next Task must reflect the next project phase

