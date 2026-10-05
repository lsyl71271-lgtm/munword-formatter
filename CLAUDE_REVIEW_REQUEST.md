# Independent review request

Review the complete Munword v1.8.2 source, shared strategies, browser/Python engines, local daily UI, installers, tests and packaging. First read README, docs/architecture.md, docs/release-1.8.2.md and shared/document-policy.json.

Priorities: independently reproduce the separator/missing-field/provenance fixes; challenge content guards with forged edit logs, revisions, hidden/struck styles, resources and numbered content; compare both engines including every text character, list value, blank line and effective formatting; test repeat processing on adversarial cases, not just samples. Trace every Step 03 field through recognition, authorization, writeback and validation. Treat unknown/ambiguous/historical names conservatively; do not infer country names.

Keep all existing features and the manual Step 03 entry. Automated acceptance runs must not fill Step 03 to repair failed automatic recognition; specifically targeted manual-edit tests should be separate. Do not introduce filename/sample-specific rules, disable full-content validation, upload documents, disclose secrets, use paid services, change repository visibility or publish. Review and report first; source edits and deployment need separate user approval.

Reports should distinguish reproduced defects, suspicions and untested real-OS/Office behavior, with severity, minimal reproduction, root cause and proposed general fix. Pay special attention to older partial-hidden-label/header/title idempotence probes that the previous review reported but did not provide as local fixtures. This ZIP includes offline assets but no Python runtime or Node dependencies.
