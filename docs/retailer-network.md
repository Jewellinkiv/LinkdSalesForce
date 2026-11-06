# Retailer network

Open **Retailer network** from the sidebar. This is a store/location directory for possible leads; importing a retailer does not create an opportunity, infer permission, or queue communication.

## Import and grouping

Sales and admin users can upload CSV or XLSX files up to 2 MB. Select the worksheet and header row, review the suggested column mapping, and specify a group and list/event. The preview shows new locations, matching rows, exclusions and review flags before import. Each preview is stored on the server; applying it is transactional and repeatable without creating duplicate records. Identical file content with the same sheet, mapping, group and list is recognized even when its filename changes.

Headers used by common membership and event exports are recognized. Names and locations combined in a CBG-style cell are separated while the original cell is retained. Blank/footer rows and explicitly non-retailer event categories are excluded with row-level reasons. Instruction worksheets are not automatically imported. Choose each data sheet explicitly, including membership hold lists when relevant.

Matching uses normalized name, city and state. Differing supplied street addresses stay separate and receive a review tag; missing locations also stay separate. This is deliberately conservative: alternate spellings and abbreviations can leave multiple records requiring review. It is not a fuzzy account merge tool. Each group/list membership retains filename, worksheet, source row and original values. Shared store phone numbers do not collapse different people into one contact.

## Client status and outreach

Imported retailers start with **Client status unverified**. Membership status is independent of Linkd client status. An explicitly linked account supplies its lifecycle: active/onboarding means current, paused remains unverified, and prospect/churned means not current. Unmatched records can be manually verified with required evidence. A missing match is never automatically classified as a non-client.

Filter by group, client status, outreach stage, tag or location/name. Select records on a page to add or remove a tag in bulk. Profile edits record an audit event and reject stale versions. Assign a teammate, set a next action and date, and track outreach from not started through contacted, replied, meeting booked or nurture. Follow-ups are visible in the retailer directory; they do not yet create tasks or reminder notifications until the prospect enters the sales workflow.

Log completed calls, email, SMS, meetings and internal notes. Logging does not send anything. Linked accounts expose their recent sales activity, calls and messages, with simulated communications labeled separately. The outreach metric counts logged contact activity and actual sent/received messages or completed provider calls, excluding simulated messages/calls. Marking a linked retailer do-not-contact also restricts its account and cancels queued contact outreach. Removing the retailer stage alone does not clear the account restriction.

Use **Start sales review** to create one research record with a named primary contact. Team workflows retains its existing review/approval process. Source phone/email text is retained for correction; a single valid email is required for the research handoff when an email is supplied. No permission is inferred. A retailer already linked to an account must retain that account during conversion.

## People and photos

Each store has editable team members with names, roles, email/phone source text and contact notes. Upload JPEG, PNG or WebP team photos up to 2 MB, add a caption (such as names from left to right), and optionally associate a photo with one person. Photos are stored in the database and served only to authenticated staff with private/no-store headers. No public asset URL is created.

## Operational limits

Migration 009 adds the retailer tables. Local imports and private source data belong in the ignored `.local/` directory or the database, never in this public repository. The app does not synchronize Monday or the production customer roster automatically. Current-client reconciliation requires the agreed authoritative roster and explicit account matching/evidence. The importer accepts XLSX/CSV, not the older binary XLS format. Worksheets are bounded to 10,000 rows/100 columns, with at most 5,000 mapped retailer rows per import. Name/location collisions need human review; no automatic merge or deletion is performed.

The XLSX reader uses [ExcelJS](https://github.com/exceljs/exceljs). Upload validation bounds archive size and rejects macros; printer-settings entries are allowed only for cell extraction and are not executed. The dependency's UUID package is overridden to the patched compatible CommonJS version.
