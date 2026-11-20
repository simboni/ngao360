**NGAO360**

**SYSTEM BLUEPRINT & PRODUCT GUIDE**

Political Operations • Election Management • Results Verification •
Public Accountability

  -----------------------------------------------------------------------
  **ONE PLATFORM. COMPLETE OVERSIGHT.**
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

**Version 1.0 \| 16 November 2026**

*Prepared as an implementation-oriented product specification for the
NGAO360 concept.*

**WORKING DOCUMENT • NAME AND TRADEMARK CLEARANCE PENDING**

# Document control

  -----------------------------------------------------------------------
  **Item**           **Description**
  ------------------ ----------------------------------------------------
  Product name       NGAO360 (working name; subject to trademark,
                     business-name and domain clearance)

  Document           System Blueprint & Product Guide

  Version            1.0 -- Initial product definition

  Prepared           16 November 2026

  Primary market     Kenyan political organisations, elected offices and
  assumption         civic institutions

  Election reference Kenya General Election scheduled for 10 August 2027,
                     subject to any later lawful change \[1\]

  Status             Product concept and requirements baseline; not a
                     production certification or legal opinion
  -----------------------------------------------------------------------

## How to use this guide

This document is the shared reference for product design, software
engineering, user-interface work, implementation planning, testing and
early customer discussions. It defines what NGAO360 should do, who may
use it, how its workflows should operate and what the system must not
claim to do.

+-----------------------------------------------------------------------+
| **Important scope boundary**                                          |
|                                                                       |
| NGAO360 is a private operational and parallel-recordkeeping platform. |
| It is not an election management body, voter register, KIEMS          |
| replacement, official results transmission channel or statutory       |
| results-declaration authority. It must not present its parallel       |
| tallies as official IEBC results.                                     |
+=======================================================================+
+-----------------------------------------------------------------------+

# Contents

1\. Product overview and guiding principles

2\. Product environments and module map

3\. Users, roles and permissions

4\. Executive Command Centre

5\. Campaign and organisational operations

6\. Field operations and polling-agent management

7\. Election Day War Room

8\. NGAO TALLY: forms, capture and verification

9\. Office administration and citizen engagement

10\. Reporting, intelligence and communications

11\. Screen inventory and interaction specifications

12\. Visual identity and user-interface system

13\. Technical architecture and deployment

14\. Data model and core properties

15\. Security, privacy and legal controls

16\. Non-functional requirements and integrations

17\. Testing, acceptance criteria and release roadmap

18\. Risks, assumptions and decisions to confirm

Appendix A. Kenyan result-form reference matrix

Appendix B. Source register and legal-reference notes

# 1. Product overview and guiding principles

## 1.1 Product definition

NGAO360 is a configurable, multi-organisation software platform for
coordinating political and civic operations across the full
organisational lifecycle. It combines executive oversight, team and
campaign administration, field reporting, election-day operational
monitoring, statutory-form capture and parallel results verification,
finance and compliance records, office administration, citizen case
management, project monitoring and reporting.

The platform is organised into three connected environments: NGAO360
Campaign, NGAO360 Election and NGAO360 Office. A shared identity,
permissions, geography registry, document service, audit service and
reporting layer connect the environments while keeping data access
separated by organisation, purpose and role.

## 1.2 Product purpose

-   Give authorised leaders a reliable view of operational activity
    without relying on scattered spreadsheets and messaging threads.

-   Help teams coordinate people, assignments, events, field reports,
    budgets and records.

-   Provide a structured way to record election-agent deployment and
    station-level observations.

-   Capture copies of election result forms obtained lawfully by
    authorised users and maintain an auditable, independent parallel
    tally.

-   Enable political offices and civic organisations to manage
    correspondence, cases, projects and public-facing accountability
    records.

-   Provide a demonstrable enterprise software product that can be
    configured for different organisations without sharing their private
    data.

## 1.3 Product principles

  ------------------------------------------------------------------------
  **Principle**     **Product implication**
  ----------------- ------------------------------------------------------
  Accuracy before   Show source, status, confidence and reviewer for
  speed             important records.

  Human             OCR, alerts and automation assist staff; they do not
  accountability    approve disputed or official outcomes.

  Permission by     Users see only the modules, records and actions
  role              required for their assigned duties.

  Evidence-linked   Important records should link to documents,
  operations        timestamps, responsible users and audit history.

  Mobile-first,     Field users need a simple PWA; executive users need a
  desktop-strong    detailed desktop workspace.

  Offline           Allow controlled draft capture and queued
  resilience        synchronisation where connectivity is poor.

  Neutral and       No voter profiling, sensitive-trait segmentation,
  lawful use        deceptive content, coercion or interference with
                    electoral processes.

  Configurable      Forms, validation rules, reporting templates and
  legal rules       deadlines are versioned rather than hardcoded.
  ------------------------------------------------------------------------

## 1.4 What NGAO360 is not

-   Not an official IEBC system and not an interface to KIEMS or any
    protected IEBC infrastructure.

-   Not a voter-registration database and not a substitute for the
    official Register of Voters.

-   Not a platform for predicting, declaring or certifying election
    winners.

-   Not a tool for collecting biometric information or building
    political profiles of individual voters.

-   Not an automated legal adjudication or incident-verdict engine.

# 2. Product environments and module map

The product should feel like one coherent platform, but each operational
environment has its own landing page, workflow and permission set.

  --------------------------------------------------------------------------
  **Environment**   **Purpose**            **Core modules**
  ----------------- ---------------------- ---------------------------------
  NGAO360 Campaign  Prepare and coordinate Command Centre; organisation;
                    the organisation       tasks; events; field operations;
                    before polling day.    communications; finance;
                                           logistics; documents; training
                                           and readiness.

  NGAO360 Election  Coordinate authorised  Polling-station registry; agent
                    election-day records   deployment; station check-ins;
                    and operational        incident desk; form capture; NGAO
                    reporting.             TALLY; War Room; audit exports.

  NGAO360 Office    Support ongoing office Correspondence; appointments;
                    administration and     citizen cases; project register;
                    public accountability. public portal; office tasks;
                                           document archive; reports.
  --------------------------------------------------------------------------

## 2.1 Shared platform services

-   Organisation tenancy and workspace configuration.

-   User identity, multi-factor authentication and role-based access
    control.

-   Geographic reference data: county, constituency, ward, polling
    centre and polling station.

-   Document and media storage with versioning and secure access.

-   Notifications, task queues and scheduled reminders.

-   Audit event service and activity history.

-   Report generation, exports and dashboard aggregation.

-   Integration gateway for email, SMS, maps and approved payment
    providers.

## 2.2 Suggested navigation

  ------------------------------------------------------------------------
  **Primary        **Typical child pages**
  navigation**     
  ---------------- -------------------------------------------------------
  Overview         Executive dashboard; personal tasks; notifications.

  Campaign         Plans; workstreams; events; content calendar; budgets;
                   logistics.

  Organisation     Departments; teams; staff; volunteers; roles; training.

  Field            Area reports; field tasks; visit records; uploaded
                   evidence.

  Election         Station registry; agents; deployment; readiness; War
                   Room.

  NGAO TALLY       Form inbox; capture; OCR review; verification queue;
                   parallel tally; discrepancies.

  Office           Correspondence; appointments; cases; projects; public
                   portal.

  Reports          Saved reports; report builder; exports; audit
                   summaries.

  Administration   Workspace; form versions; reference data; integrations;
                   security; retention.
  ------------------------------------------------------------------------

+-----------------------------------------------------------------------+
| **Navigation rule**                                                   |
|                                                                       |
| The sidebar must only show modules a user is authorised to access. A  |
| user with no results permissions must not see NGAO TALLY in the menu, |
| search results, notifications or exported reports.                    |
+=======================================================================+
+-----------------------------------------------------------------------+

# 3. Users, roles and permissions

NGAO360 should support named roles with configurable permissions. A
person may hold more than one role, but privileged actions should remain
explicit and auditable. Use least-privilege access as the default.

  ----------------------------------------------------------------------------
  **Role**           **Typical access**           **Restricted actions**
  ------------------ ---------------------------- ----------------------------
  Platform operator  Tenant provisioning, service No routine access to
                     health, support diagnostics. customer content;
                                                  time-limited, approved
                                                  support elevation only.

  Organisation owner Workspace settings,          Cannot alter already
                     invitations, module          verified tally values
                     activation, retention        without workflow.
                     settings.                    

  Campaign director  Executive dashboards,        No direct editing of source
                     workstreams, departmental    result records unless
                     status, approved reports.    separately assigned.

  Operations         Tasks, events, field         No access to finance or
  director           reporting, readiness and     sensitive case details
                     deployment overview.         unless granted.

  Department lead    Own department records,      Cannot see unrelated
                     tasks, approvals and         departments by default.
                     reports.                     

  Coordinator        Assigned geographic area,    Cannot browse all areas or
                     team, tasks, activity        modify master station data.
                     reports.                     

  Polling agent      Own assignment, training,    Cannot view other agents'
                     incident submission and      personal details or approve
                     authorised form uploads.     own result submission.

  Data-entry clerk   Form metadata and draft      Cannot independently verify
                     result capture.              own entries.

  Results verifier   Review original image,       Cannot modify the original
                     extracted figures,           source image or delete
                     validations and source       submission history.
                     comparison.                  

  Tally supervisor   Approve/reject verification  Cannot declare an official
                     outcomes, release internal   result or issue IEBC
                     parallel aggregates.         certificates.

  Finance officer    Budgets, transactions,       Cannot approve own payment
                     supplier records, finance    request where segregation is
                     reports.                     required.

  Legal/compliance   Compliance records, incident Cannot alter source result
  officer            evidence, document holds and figures without a separate
                     escalations.                 tally role.

  Communications     Draft and publish approved   Cannot message users outside
  editor             public or internal content.  configured lawful lists or
                                                  access voter profiles.

  Citizen / public   Submit and track own         No access to internal notes,
  user               request; view public         personal data of others or
                     records.                     unpublished cases.
  ----------------------------------------------------------------------------

## 3.1 Permission dimensions

-   Module: view, create, edit, submit, approve, export, configure.

-   Geography: organisation-wide, county, constituency, ward, station,
    or specifically assigned locations.

-   Record sensitivity: public, internal, confidential, highly
    restricted.

-   Workflow state: draft, submitted, under review, verified, approved,
    released, archived.

-   Time: access may be granted for a defined election period or
    temporary task.

## 3.2 Separation of duties

The same user must not be able to submit, independently verify and
approve the same results record. Financial approvals should similarly
separate requester, reviewer and payment confirmer. High-risk changes
require re-authentication and an audit event.

# 4. Executive Command Centre

The Command Centre is the default executive landing page. It provides a
concise, reliable summary of the organisation's operational state and
directs authorised users to items requiring attention.

![Executive Command Centre concept with KPI cards, operational activity
chart, geographic operations panel, recent activity and priority
queue.](media/image1.png "NGAO360 software dashboard concept"){width="6.85in"
height="3.853125546806649in"}

Figure 1. Illustrative NGAO360 Executive Command Centre layout. All
figures are synthetic demonstration data.

## 4.1 Dashboard regions

  -----------------------------------------------------------------------
  **Region**     **Properties and behaviour**
  -------------- --------------------------------------------------------
  Global header  Organisation/workspace selector; current module; global
                 search; notification bell; help; user menu; environment
                 label.

  Left           Permission-aware links; collapsible labels; visible
  navigation     active state; module badges for assigned items.

  KPI row        Active workstreams; open tasks; approvals pending; open
                 cases; overdue count. KPI definitions and date range
                 visible on hover/details.

  Activity chart Time series of tasks, events, reports or case updates;
                 filters by period and department; drill-down to source
                 records.

  Geographic     Map or location summary using authorised operational
  panel          records; no individual voter plotting.

  Recent         Timestamp; actor; action; record; status; link to audit
  activity       details.

  Priority queue Overdue tasks, pending approvals, unreviewed cases,
                 field reports requiring action.

  Quick actions  Create task; schedule event; add field report; submit
                 expense; open incident; run report.
  -----------------------------------------------------------------------

## 4.2 KPI definitions

  -----------------------------------------------------------------------------
  **KPI**          **Definition**               **Rules**
  ---------------- ---------------------------- -------------------------------
  Active           Workstreams in active state  Exclude archived and cancelled
  workstreams      during selected period.      items.

  Open tasks       Tasks not completed,         Show overdue separately;
                   cancelled or archived.       respect access scope.

  Pending          Requests awaiting a named    Count unique requests, not
  approvals        approver.                    approval steps.

  Open cases       Citizen/service cases not    Separate referred,
                   closed or withdrawn.         resolved-pending-confirmation
                                                and closed.

  Agent deployment Assigned station slots with  Not a measure of voter
  coverage         confirmed agent assignment / preference or support.
                   planned slots.               

  Form             Verified submissions /       Display missing, pending,
  verification     expected forms in the        rejected and duplicate
  progress         configured registry.         separately; denominator must be
                                                visible.
  -----------------------------------------------------------------------------

## 4.3 Dashboard interaction requirements

-   Selecting a KPI opens a filtered record list; do not dead-end on
    charts.

-   Filters persist during navigation but are visibly removable.

-   Every KPI exposes its definition, date range and data freshness.

-   Use empty states with a clear next action instead of empty charts.

-   Refresh indicators must show last successful update and any queued
    offline submissions.

-   Do not display speculative winner forecasts or infer candidate
    support from field reports.

# 5. Campaign and organisational operations

## 5.1 Organisation structure

Configurable organisational hierarchy: organisation → campaign/office →
department → geographic unit or workstream → team → user. Avoid
hardcoding a single campaign structure. A tenant may use national,
county, constituency, ward or custom operational groupings.

  -----------------------------------------------------------------------
  **Feature**     **Properties**
  --------------- -------------------------------------------------------
  Department      Name; code; description; lead; parent department;
  registry        budget code; active dates; visibility.

  Team registry   Team name; department; coordinator; members; geographic
                  assignment; contact channel; status.

  User directory  Name; work email/phone; role; team; status; invitation
                  state; MFA status; last login.

  Assignment      Task; assignee; reviewer; due date; priority;
                  geography; supporting files; acceptance criteria.

  Training        Course/session; material; participant; completion date;
                  assessment; certificate reference.

  Document        Title; category; owner; version; sensitivity; retention
  register        date; approval state.
  -----------------------------------------------------------------------

## 5.2 Tasks and workstreams

-   Create task from dashboard, project, event, incident or case.

-   Assign one accountable owner and optional collaborators.

-   Set priority, due date, start date, dependency, geography and
    department.

-   Use statuses: draft, ready, in progress, blocked, submitted for
    review, completed, cancelled.

-   Attach files, checklist items, comments and completion evidence.

-   Maintain an activity timeline for assignment changes and status
    updates.

-   Provide list, board, calendar and workload views.

## 5.3 Events and logistics

  -----------------------------------------------------------------------
  **Screen /       **Required fields and actions**
  feature**        
  ---------------- ------------------------------------------------------
  Event create     Title; event type; purpose; date/time; venue;
                   coordinates; organiser; budget; invited teams;
                   logistics checklist; visibility.

  Event detail     Overview; agenda; assigned tasks; venue/map;
                   equipment; transport; approved communications;
                   documents; attendance; after-action report.

  Attendance       Check-in method; participant; time; event role;
                   optional consent-based contact details; export.

  Logistics        Vehicle/asset; supplier; quantity; assigned custodian;
                   collection/return time; incident/damage notes.

  After-action     What occurred; attendance totals; actual spend;
  report           issues; lessons; evidence attachments; approving
                   reviewer.
  -----------------------------------------------------------------------

## 5.4 Communications and media administration

Provide a content workflow for notices, press releases, internal
bulletins, website updates and event information. Draft → editorial
review → authorised approval → publication → archive. Keep a clear
record of author, approver, publication time, audience category and
correction history. The platform should not provide automated political
persuasion, personal voter targeting or unsolicited mass outreach.

# 6. Field operations and polling-agent management

## 6.1 Field operations

  ------------------------------------------------------------------------
  **Capability**   **Specification**
  ---------------- -------------------------------------------------------
  Field task       Task ID; assignment; location; due window; checklist;
                   reporting template; assigned person; status.

  Field report     Report type; author; date/time; area; observation;
                   attachments; optional location; supervisor; review
                   state.

  Visit record     Purpose; place; start/end time; outcome; follow-up
                   task; evidence. Collect only information necessary for
                   the assignment.

  Offline draft    Encrypted/minimised local record; local ID; created
                   time; sync state; retry state; conflict record.

  Supervisor       Accept; return for clarification; escalate; close. All
  review           actions audited.
  ------------------------------------------------------------------------

## 6.2 Polling-station registry

The registry is a reference-data module, not a substitute for the IEBC's
official station list. Import station data from an official source or
approved customer-provided file. Keep source, publication date, version
and import validation report. Never assume station codes, boundaries or
totals remain static between elections.

  -----------------------------------------------------------------------
  **Property**      **Type / rule**
  ----------------- -----------------------------------------------------
  Election cycle    Required reference to configured election cycle.

  County code/name  Required; sourced from approved reference dataset.

  Constituency      Required; parent county relationship.
  code/name         

  Ward code/name    Required; parent constituency relationship.

  Polling centre    Optional grouping of one or more stations.

  Polling station   Required unique identifier within the election-cycle
  code/name         registry.

  Registered voter  Optional, source-labelled and versioned; do not
  figure            silently substitute estimates.

  Location          Optional coordinates/address with source and
                    precision.

  Registry status   Active; amended; merged; split; withdrawn; pending
                    confirmation.

  Source metadata   Source URL/file; import date; version; approving
                    user; change notes.
  -----------------------------------------------------------------------

## 6.3 Agent management

-   Agent profile: legal name, contact, organisation, assigned role,
    emergency contact if required, and consent/privacy notice record.

-   Accreditation tracking: submitted, pending, approved, rejected,
    expired or not applicable; store reference/evidence where lawfully
    held. The platform does not grant accreditation.

-   Assignment: election; contest(s); county; constituency; ward;
    station; shift; supervisor; assignment start/end.

-   Training: materials issued; attendance; assessment; completion date;
    refresher status.

-   Check-in: user-initiated timestamp, assignment confirmation and
    optional location where justified and disclosed.

-   Replacement: record predecessor, successor, authorisation and time;
    never delete the original assignment history.

+-----------------------------------------------------------------------+
| **Field privacy rule**                                                |
|                                                                       |
| Do not track agents continuously. Use check-ins tied to a legitimate  |
| task, provide notice, and collect precise location only when          |
| necessary. Do not collect voters' political preferences, biometrics   |
| or copies of personal identification documents unless a separate      |
| lawful basis and approved process requires it.                        |
+=======================================================================+
+-----------------------------------------------------------------------+

# 7. Election Day War Room

The War Room is a time-limited, high-availability operational workspace
that brings together agent deployment, station updates, incident triage,
form intake and tally verification. It is not an election control room
and does not issue instructions to IEBC officers.

![Election operations dashboard concept with station registry, agent
check-ins, forms received, verification queue, station reporting
overview and attention
items.](media/image2.png "NGAO360 software dashboard concept"){width="6.85in"
height="3.853125546806649in"}

Figure 2. Illustrative election-day War Room. All station counts and
statuses shown are synthetic demonstration data.

## 7.1 War Room screen panels

  ------------------------------------------------------------------------
  **Panel**      **What it displays**           **Primary action**
  -------------- ------------------------------ --------------------------
  Agent          Assigned agents; check-ins;    View assignment / contact
  operations     pending station assignments;   supervisor.
                 training status.               

  Station        Stations with assignment; no   Open station record.
  registry       update; status update          
  status         received; form expected.       

  Incident queue Open incidents by severity,    Acknowledge, assign,
                 age, category and assigned     escalate or resolve.
                 reviewer.                      

  Form intake    Incoming document queue by     Open capture/review
                 contest, form type, geography  screen.
                 and status.                    

  Tally          Submitted, OCR complete,       Review record or release
  verification   awaiting second review,        approved aggregate.
                 verified, disputed.            

  System health  API latency, queue depth,      Open technical status
                 storage availability, sync     page.
                 backlog, last backup.          
  ------------------------------------------------------------------------

## 7.2 Operational status taxonomy

  -----------------------------------------------------------------------
  **Status**         **Meaning**
  ------------------ ----------------------------------------------------
  Not assigned       No agent assignment exists for the configured
                     station slot.

  Assigned           Assignment created; agent has not confirmed.

  Confirmed          Agent has acknowledged assignment.

  Checked in         Agent has made a task-linked check-in.

  Update received    A field update has been submitted.

  Form expected      The configured process expects a source form, but no
                     submission is recorded.

  Form received      Image/file has been accepted into intake; not yet
                     verified.

  Verification       Data awaits review.
  pending            

  Verified for       Image and extracted values have passed configured
  parallel tally     internal checks.

  Flagged            A reviewer or validation rule requires further
                     review.

  Closed             Operational record completed or formally closed.
  -----------------------------------------------------------------------

## 7.3 Incident management workflow

1.  Submitter creates incident with category, time, station/area,
    neutral factual description and optional evidence.

2.  System issues a unique incident reference and sets an initial
    priority based on configurable rules.

3.  A desk officer acknowledges and assigns the incident to the
    appropriate authorised team.

4.  Reviewer records actions, referral details, communications and
    evidence.

5.  Legal/compliance reviewer may place an evidence hold or refer the
    matter to a competent authority.

6.  Incident closes only with a closure note and authorised reviewer;
    disputed incidents remain open or marked unresolved.

# 8. NGAO TALLY: forms, capture and verification

NGAO TALLY is an independent parallel-recordkeeping and verification
module. It stores copies of results forms received through authorised
channels, captures the figures displayed on those forms, runs
transparent arithmetic and metadata checks, records human reviews and
produces internal aggregates. It must never be represented as IEBC's
official result system.

+-----------------------------------------------------------------------+
| **Legal baseline and versioning**                                     |
|                                                                       |
| The form matrix below reflects the Elections (General) Regulations as |
| amended by Legal Notice No. 72 of 2017 and associated schedules. It   |
| is a product-design baseline, not a guarantee that the 2027 forms or  |
| directives will remain identical. Before production, the              |
| legal/configuration administrator must load and approve the actual    |
| 2027 IEBC forms, instructions and version dates. \[2\]                |
+=======================================================================+
+-----------------------------------------------------------------------+

## 8.1 Form matrix for the six elective positions

  ------------------------------------------------------------------------------------
  **Elective        **Polling-station   **Next collation /           **Certificate**
  position**        form**              declaration stage**          
  ----------------- ------------------- ---------------------------- -----------------
  President         34A                 34B (constituency            34D
                                        collation); 34C (national    
                                        declaration)                 

  Member of         35A                 35B (constituency            35C
  National Assembly                     declaration / tally)         

  Member of County  36A                 36B (constituency            36C
  Assembly                              declaration / tally)         

  County Governor   37A                 37B (constituency            37D
                                        collation); 37C (county      
                                        declaration)                 

  Senator           38A                 38B (constituency            38D
                                        collation); 38C (county      
                                        declaration)                 

  County Woman      39A                 39B (constituency            39D
  Representative                        collation); 39C (county      
                                        declaration)                 
  ------------------------------------------------------------------------------------

The polling-station declaration forms are identified under regulation
79(2). The collation, declaration and certificate stages are set out in
regulations 83 and 87 and the prescribed schedules. For example, Form
37A records governor results at a polling station; Form 37B collates
county governor results at the constituency tallying centre; Form 37C
declares county governor results at the county tallying centre; and Form
37D is the certificate of the elected county governor. \[2\]

## 8.2 Result intake workflow

  ------------------------------------------------------------------------------
  **Step**       **Action**                       **System output**
  -------------- -------------------------------- ------------------------------
  1\. Source     Authorised user receives a copy  Unique submission ID; source
  receipt        of the completed official form   and submitter record.
                 and uploads it.                  

  2\. Metadata   Select election, contest, form   Validated geographic and form
  capture        version, county, constituency,   references.
                 ward and station/tally centre.   

  3\. Original   Store original image/PDF;        Read-only source object and
  preservation   calculate cryptographic hash;    integrity metadata.
                 record timestamp and uploader.   

  4\. OCR        Extract printed/handwritten      Draft extraction, never an
  assistance     fields where supported; return   approved result.
                 confidence per field.            

  5\. Manual     Clerk compares every value to    Corrected draft values with
  review         the visible source image.        change history.

  6\.            Second authorised reviewer       Verified, returned or disputed
  Independent    independently checks source and  status.
  verification   captured values.                 

  7\. Rule       Run form-version-specific        Pass/warning/fail checklist
  checks         arithmetic and metadata checks.  with explanation.

  8\. Aggregate  Include only eligible verified   Timestamped tally snapshot and
                 submissions in internal parallel coverage metrics.
                 aggregates.                      

  9\. Reconcile  Compare relevant lower-level     Variance report, versioned
  / archive      records to later                 export and archive manifest.
                 collation/declaration forms;     
                 archive the approved snapshot    
                 with its source material,        
                 reviewer and audit history.      
  ------------------------------------------------------------------------------

## 8.3 Form capture screen fields

  -----------------------------------------------------------------------
  **Field        **Properties**
  group**        
  -------------- --------------------------------------------------------
  Submission     Submission ID (system); organisation; election cycle;
  identity       contest; form number; form-template version; source
                 type; uploader; upload timestamp.

  Geography      County; constituency; ward; polling centre; polling
                 station code/name or tally centre; reference registry
                 version.

  Document       Original file; MIME type; file size; file hash; page
                 count; image quality; optional source-copy notes.

  Declaration    Form serial/sequence where printed; date/time fields
  details        where present; presiding/returning officer fields where
                 present; visible stamp/signature presence as
                 human-observed attributes only.

  Captured       Candidate identifier/name as printed; votes; valid
  figures        votes; rejected ballots; disputed/rejection-objected
                 counts; registered voters; total votes cast; other
                 fields required by the specific form.

  Workflow       Draft; submitted; OCR complete; data-entry reviewed;
                 second review pending; verified; returned; disputed;
                 excluded from aggregate; archived.

  Audit          All value changes; old/new value; actor; time; reason;
                 reviewer; related evidence.
  -----------------------------------------------------------------------

## 8.4 Validation rules

-   Confirm the selected form belongs to the selected contest and
    election cycle.

-   Confirm station/tally-centre identity exists in the approved
    registry version.

-   Check for duplicate file hashes, same station/form combination,
    matching serial values and near-duplicate images. Potential
    duplicates go to review; do not silently delete.

-   Check that candidate vote fields are numeric, non-negative and
    within configured format limits.

-   Where the form contains a total valid vote field, compare it to the
    sum of candidate vote fields.

-   Where the form contains counts for valid votes, rejected ballots,
    disputed votes or votes cast, apply only the published form-specific
    arithmetic rules approved for that version.

-   Compare vote totals with registered-voter and turnout fields where
    printed. Flag impossible or inconsistent combinations for human
    review; do not automatically invalidate or exclude an official form.

-   Check visible required fields such as signatures and stamps as
    reviewer observations. Software cannot establish that a signature is
    genuine.

-   Never use OCR confidence alone to approve a value. Low-confidence
    fields must be manually checked.

-   All validation rules must be versioned, testable and traceable to a
    form or legal reference.

+-----------------------------------------------------------------------+
| **Critical distinction**                                              |
|                                                                       |
| A cryptographic hash can demonstrate that the stored file has not     |
| changed since its hash was calculated. It does not prove that the     |
| photograph is genuine, that the uploader obtained it lawfully, or     |
| that the figures reflect the true ballot count. Source chain and      |
| human review remain essential.                                        |
+=======================================================================+
+-----------------------------------------------------------------------+

# 8. NGAO TALLY continued

## 8.5 Two-person verification and discrepancy management

A submission should not enter the verified aggregate until a second
authorised person has checked the captured data against the original
source. The submitter and verifier must be different users. A tally
supervisor may approve the workflow outcome but may not erase the
original submission or its previous values.

  -------------------------------------------------------------------------
  **Discrepancy   **Example**              **Required handling**
  type**                                   
  --------------- ------------------------ --------------------------------
  Arithmetic      Candidate votes do not   Hold from verified aggregate;
                  reconcile to form total. show exact fields and
                                           arithmetic; request second
                                           review.

  Metadata        Station code does not    Flag; verify against approved
                  match selected ward or   station registry; retain
                  constituency.            original submitted metadata.

  Image quality   Blurred/obscured number  Return for clearer copy or
                  or missing page.         manual escalation; do not guess.

  Duplicate       Potential same form      Link records; designate
                  uploaded twice.          canonical record after review;
                                           retain both audit trails.

  Cross-stage     Aggregated station data  Create variance case with both
  mismatch        differs from a later     source records; no automatic
                  official collation form. overwrite.

  Form version    Submission uses a form   Quarantine until configuration
  mismatch        template not approved    administrator confirms
                  for that cycle.          applicable version.

  Reviewer        Two reviewers capture    Escalate to tally supervisor;
  disagreement    different values.        require a reasoned resolution
                                           and a third check if configured.
  -------------------------------------------------------------------------

## 8.6 Parallel tally rules

-   Only records with status "Verified for parallel tally" may be
    included in the default verified aggregate.

-   The dashboard must distinguish received, transcribed, verified,
    flagged, excluded and missing records.

-   Every total must show the count of included stations and the
    expected denominator from the current approved station registry.

-   Filters by county/constituency/ward must not change the underlying
    source records.

-   Aggregate snapshots are immutable. A new verified submission creates
    a new snapshot rather than rewriting an old one.

-   Later-stage forms (B/C) must be stored and compared to the
    corresponding A-form records where the form design supports that
    comparison.

-   The system must not label a candidate "winner", "elected" or
    "officially declared" based on the parallel tally.

-   Public exports, if enabled, must show the source basis, verification
    coverage, caveats and update timestamp.

## 8.7 Results dashboard properties

  -----------------------------------------------------------------------
  **Component**   **Fields / behaviour**
  --------------- -------------------------------------------------------
  Coverage cards  Expected stations; forms received; verified; awaiting
                  review; flagged; missing; percentage denominator.

  Contest         Election cycle; elective position; form series;
  selector        candidate list as printed on approved form reference.

  Geographic      County; constituency; ward; polling station; tally
  filters         centre.

  Candidate       Verified votes by candidate; share of verified valid
  totals          votes only; included station count; last update.

  Completeness    Submissions and verification by hour/day or geography;
  chart           never present missing stations as zero votes.

  Map             Station status and form verification state; avoid
                  displaying private agent contact or precise live
                  location.

  Discrepancy     Open variance cases; issue category; age; assigned
  panel           reviewer; source comparison.

  Exports         Internal parallel tally CSV/XLSX/PDF with disclaimer,
                  sources, snapshot ID and audit manifest.
  -----------------------------------------------------------------------

# 9. Office administration and citizen engagement

## 9.1 Digital office

  -------------------------------------------------------------------------
  **Module**       **Feature properties**
  ---------------- --------------------------------------------------------
  Correspondence   Reference number; incoming/outgoing; sender/recipient;
                   subject; received/sent date; category; sensitivity;
                   assigned officer; response deadline; attachment; status.

  Appointments     Requester; contact; purpose; preferred time; assigned
                   office; confirmation; outcome; follow-up; privacy
                   notice.

  Meetings         Title; agenda; participants; date/time; venue/link;
                   minutes; actions; decision log; owner; due date.

  Documents        Folder/category; version; owner; access group; approval;
                   retention; archive; legal hold.

  Assets           Asset ID; description; serial; custodian; location;
                   condition; assignment; maintenance; disposal record.

  Handover         Open tasks; pending cases; active projects;
                   contracts/documents; assets; financial commitments;
                   handover notes; receiving officer acknowledgement.
  -------------------------------------------------------------------------

## 9.2 Citizen case management

A public portal allows a person to submit a service request or issue
report without creating an account for basic submissions. Optional
account creation may support status tracking. The portal must explain
what data is collected, why it is needed, who will receive it and how it
may be used.

  -----------------------------------------------------------------------
  **Case stage** **Workflow behaviour**
  -------------- --------------------------------------------------------
  Submitted      System assigns reference and timestamp; sends
                 acknowledgement if contact details are supplied.

  Triage         Administrator checks category, jurisdiction, urgency,
                 completeness and duplicate possibility.

  Assigned       Case goes to an authorised officer or is referred to a
                 responsible institution.

  In progress    Officer records actions, communications, evidence and
                 next review date.

  Referred       Referral destination, date, contact, evidence and
                 follow-up date are recorded.

  Resolution     Officer records claimed action and supporting evidence.
  proposed       

  Citizen        Submitter may confirm, dispute or provide additional
  feedback       information; this is optional.

  Closed /       Closure reason and approver recorded; reopening creates
  reopened       a new event, not a deletion.
  -----------------------------------------------------------------------

## 9.3 Development project monitoring

  -----------------------------------------------------------------------
  **Project       **Description**
  property**      
  --------------- -------------------------------------------------------
  Project         Project ID; name; description; category;
  identity        ward/constituency/county; map location.

  Governance      Responsible institution; implementing agency; named
                  project owner; source of commitment; approval
                  authority.

  Finance         Funding source; approved allocation; contract amount if
                  public; expenditure reported; source and verification
                  status.

  Schedule        Start date; expected completion date; milestones;
                  current milestone; delay reason.

  Evidence        Progress photographs; inspection notes; documents;
                  date; uploader; verifier; location metadata if
                  appropriate.

  Status          Proposed; committed; approved; funded; procurement;
                  ongoing; delayed; completed; verified completed;
                  cancelled.

  Public view     Publish approved fields only. Distinguish commitments,
                  approved projects and verified completion; name the
                  responsible institution and source. A photograph alone
                  is not proof of completion.
  -----------------------------------------------------------------------

Accountability control: do not imply that a political office controls a
project when another public body is legally responsible. Record the
implementing institution, source and verification status; a photograph
alone does not prove completion.

# 10. Reporting, intelligence and communications

## 10.1 Standard reports

  -----------------------------------------------------------------------
  **Report       **Example reports**
  group**        
  -------------- --------------------------------------------------------
  Executive      Daily operations summary; overdue work; open risks;
                 cross-department status.

  Campaign       Event schedule; task completion; team activity;
  operations     logistics; training completion.

  Field          Reports by geography; assignment completion; unresolved
                 operational issues.

  Election       Agent assignments; accreditation status; training;
  readiness      station coverage; device/sync readiness.

  Election-day   Station status; incident queue; form receipt;
                 verification queue; system health.

  Results        Verified parallel tally; form coverage; duplicates;
  verification   validation warnings; cross-stage variances.

  Finance        Budget vs actual; supplier spend; approvals;
                 contribution/expenditure registers; compliance exports.

  Office /       Cases by status; response times; referrals;
  citizen        appointments; correspondence backlog.
  services       

  Projects       Projects by stage; milestones; progress evidence;
                 delays; verification coverage.

  Audit /        User access; privileged actions; exports; data changes;
  security       authentication events; incidents.
  -----------------------------------------------------------------------

## 10.2 Report builder

> 1\. Choose module and approved dataset.
>
> 2\. Choose permitted fields and dimensions.
>
> 3\. Apply filters, geography and date range.
>
> 4\. Preview totals and sample records.
>
> 5\. Save report template with owner and permission scope.
>
> 6\. Export PDF/XLSX/CSV with generation time, filters and data
> classification.
>
> 7\. For sensitive results and finance exports, require elevated
> permission and record the export event.

## 10.3 Notification centre

  --------------------------------------------------------------------------
  **Notification   **Delivery / controls**
  type**           
  ---------------- ---------------------------------------------------------
  In-app           Default channel for operational updates; read/unread;
                   deep link; personal notification preferences.

  Email            Invitations, approvals, reports and case updates; only to
                   verified addresses.

  SMS              Short deadline, assignment or status notices; explicit
                   list/consent and opt-out rules where applicable.

  Push             PWA notifications for assigned tasks and status changes,
                   subject to browser/device permission.

  Critical alert   System incident or security event; escalation path;
                   acknowledgement and closure record.
  --------------------------------------------------------------------------

# 11. Screen inventory and interaction specifications

The table below defines the minimum screen set across the three product
environments. Each screen should share a consistent header, breadcrumb,
page title, action area, filters and role-aware content.

  -----------------------------------------------------------------------------------
  **ID / screen**  **Primary purpose**     **Key UI components and properties**
  ---------------- ----------------------- ------------------------------------------
  S01 Login / MFA  Secure access.          Email/username; password/passkey; MFA
                                           challenge; organisation selector;
                                           recovery; legal/privacy links;
                                           failed-login feedback.

  S02 Workspace    Create organisation     Organisation name/type; display name;
  setup            workspace.              timezone; logo; modules; data region;
                                           default geography; admin user.

  S03 Onboarding   Guide admin through     Progress steps; import reference data; add
  checklist        setup.                  teams; invite users; configure roles;
                                           choose module settings.

  S04 Executive    Overview and            KPI cards; activity chart; geo panel;
  dashboard        priorities.             recent actions; priority queue; quick
                                           actions; filters.

  S05 Organisation View and edit           Tree view; department cards; lead;
  tree             structure.              parent/child; active dates; edit drawer.

  S06 User         Manage users.           Search; filters; status; role chips; team;
  directory                                invite; suspend; reset MFA; access review.

  S07 Role editor  Configure access.       Permission matrix; module toggles;
                                           geography scope; export permission;
                                           expiry; preview effective access.

  S08 Task board   Coordinate work.        Kanban/list/calendar; assignee; priority;
                                           due date; dependencies; attachments;
                                           comments.

  S09 Event detail Manage event execution. Header status; agenda; venue map; tasks;
                                           people; logistics; budget; attendance;
                                           report.

  S10 Finance      Record and review       Account/category; transaction date;
  ledger           transactions.           amount; payee; reference; attachment;
                                           request/approve/pay states.

  S11 Field report Capture field           Template; geography; event time; factual
  form             observations.           notes; attachment; optional location;
                                           offline status.

  S12 Station      Maintain election       Hierarchical filter; station code; name;
  registry         geography.              parent units; registry version; status;
                                           import history.

  S13 Agent        Manage agent records.   Identity fields; contact; training;
  profile                                  accreditation reference/status; assigned
                                           station; status history.

  S14 Deployment   Assign agents to        Station grid/map; assignment slots;
  planner          stations.               conflicts; replacement history; export
                                           roster.

  S15 Election     Prepare for polling     Coverage cards; accreditation checklist;
  readiness        day.                    training completion; device status;
                                           missing assignments.

  S16 War Room     Coordinate election-day Live station panel; agent status; incident
                   operations.             queue; form intake; tally state; system
                                           health.

  S17 Incident     Report a factual issue. Category; time; location; description;
  intake                                   attachment; reporter; urgency; privacy
                                           classification.

  S18 Form inbox   Receive result forms.   Upload queue; filters; contest; form type;
                                           station; source; duplicate flag;
                                           processing state.

  S19 Form capture Capture metadata and    Image viewer; form metadata;
                   figures.                field-by-field entry; OCR confidence;
                                           validation checklist; save draft.

  S20 Verification Second-person review.   Original image; extracted values;
  workspace                                comparison panel; field comments;
                                           pass/return/dispute.

  S21 Parallel     View verified           Contest selector; geography; candidate
  tally            aggregate.              totals; verified station denominator;
                                           trend; source coverage.

  S22 Discrepancy  Resolve mismatch.       Source A/B; field comparison; issue type;
  case                                     actions; owner; reason; decision; closure.

  S23              Manage office letters.  Reference; sender; recipient; date;
  Correspondence                           category; assigned officer; due date;
  inbox                                    document preview.

  S24 Citizen      Public service request. Issue type; description; locality;
  portal                                   optional photo; contact preference;
                                           privacy notice; reference.

  S25 Case         Manage citizen request. Timeline; public updates; internal notes;
  workspace                                assignee; referral; due date; evidence;
                                           close/reopen.

  S26 Project      Monitor                 Map/list; stage; owner institution; budget
  register         commitments/projects.   source; milestone; evidence; verification
                                           label.

  S27 Project      Maintain project        Summary; milestones; documents;
  detail           record.                 photographs; financial fields; update
                                           history; public view toggle.

  S28 Report       Create operational      Dataset; filters; grouping; date range;
  builder          reports.                preview; saved templates; export access
                                           check.

  S29 Audit log    Inspect system events.  Actor; action; entity; timestamp;
                                           IP/device metadata; before/after; export;
                                           retention hold.

  S30 System       Configure tenant.       Organisation; modules; geography; form
  settings                                 versions; integrations; notification; data
                                           retention; backup status.
  -----------------------------------------------------------------------------------

# 11. Screen inventory: critical interactions

## 11.1 Form inbox and capture screen

The form intake queue should use a split-view layout. The left area
lists submissions and their statuses; the centre displays the original
image; the right panel displays metadata and extracted fields. Reviewers
should not need to navigate away from the image to compare numbers.

-   Image controls: zoom; rotate; fit-to-width; page navigation;
    download original only where permission allows.

-   Metadata: contest, form number, version, station/tally centre,
    upload source, submitter and time.

-   Field table: printed label, extracted value, confidence, reviewer
    value, validation status.

-   Actions: save draft; submit for second review; return to submitter;
    flag discrepancy; view audit history.

-   Never hide or overwrite the original document.

## 11.2 Result dashboard screen

-   Header: election cycle, contest, status and snapshot timestamp.

-   Coverage strip: expected stations; received; verified; pending;
    flagged; missing.

-   Candidate results: verified aggregate only, with explicit "parallel
    tally -- not official result" label.

-   Geography drill-down: county → constituency → ward → polling
    station, limited to configured contest.

-   Source access: click a station row to inspect its source form,
    reviewer state and audit history.

-   Discrepancy banner: unresolved variance count; link to cases.

-   Export: include methodology, denominator, record statuses, snapshot
    ID and disclaimer.

## 11.3 Mobile PWA screens

  -----------------------------------------------------------------------
  **Mobile        **Key behaviour**
  screen**        
  --------------- -------------------------------------------------------
  Home            Assigned tasks; station assignment; urgent notices;
                  sync status.

  My assignment   Station/unit; supervisor; contact; approved task
                  instructions; check-in.

  Field report    Short template; photo attachment; save draft; upload
                  queue.

  Incident report Factual report form; optional evidence; privacy
                  warning; submit reference.

  Result form     Choose contest/form; capture/upload image; station
  upload          metadata; review summary; submit.

  My submissions  Status; timestamps; return comments; resubmit; view
                  reference.

  Offline queue   Pending local records; last sync; retry; conflict
                  state; clear after confirmed sync.
  -----------------------------------------------------------------------

+-----------------------------------------------------------------------+
| **Mobile safety**                                                     |
|                                                                       |
| A shared phone or lost device should not expose stored documents. Use |
| session expiry, device PIN/biometric unlock where available, minimal  |
| encrypted local storage, remote session revocation and automatic      |
| removal of synced drafts after server confirmation.                   |
+=======================================================================+
+-----------------------------------------------------------------------+

# 12. Visual identity and user-interface system

NGAO360 should look like a premium enterprise operations platform:
confident, calm, data-rich and readable. The interface should not look
like a candidate poster or partisan campaign graphic. The design must
remain neutral so the platform can serve different organisations.

## 12.1 Brand and interface palette

  -----------------------------------------------------------------------
  **Token**      **Hex**      **Use**
  -------------- ------------ -------------------------------------------
  Midnight Navy  #102B46      Primary navigation, headings, high-contrast
                              panels.

  Deep Blue      #173D5B      Secondary navigation, selected controls,
                              section headers.

  Operational    #178B86      Primary actions, verified/success states,
  Teal                        active indicators.

  Warm Gold      #D5A64A      Attention and pending states; use
                              sparingly.

  Cloud          #F3F6F9      Page background.

  White          #FFFFFF      Cards and content surfaces.

  Slate          #657789      Secondary text and metadata.

  Error          #B54747      Errors, blocked states and critical alerts
                              only.

  Success        #2F855A      Completed and verified states, paired with
                              text/icon.
  -----------------------------------------------------------------------

## 12.2 Typography and spacing

-   Use Inter or Aptos for a clean enterprise appearance; use a single
    type family for most UI text.

-   Page title: 24--28 px; section title: 18--20 px; card title: 14--16
    px; body: 14--15 px; metadata: 12--13 px.

-   Use a consistent 4 px spacing base: 4, 8, 12, 16, 24, 32.

-   Cards: 12--16 px radius; subtle border; minimal shadow. Avoid
    excessive gradients and glass effects.

-   Tables should support sticky headers, column resizing where useful,
    sorting, filters, pagination and clear empty states.

-   Every status needs a word label and icon; do not rely on colour
    alone.

## 12.3 Desktop layout

  -----------------------------------------------------------------------
  **Element**     **Specification**
  --------------- -------------------------------------------------------
  Sidebar         Width 248 px expanded / 72 px collapsed; dark navy;
                  grouped modules; icons; active state.

  Top bar         Height 64--72 px; breadcrumb; workspace; global search;
                  notification; user profile.

  Content width   Fluid; use max width for forms; dashboards may use full
                  width.

  KPI card        Label; main value; trend/period only when statistically
                  meaningful; source freshness.

  Data grid       Dense but readable; row height 44--52 px; selectable
                  rows; sticky header; bulk actions by permission.

  Detail page     Summary header; state badge; primary actions; tabs for
                  overview, documents, activity and audit.
  -----------------------------------------------------------------------

## 12.4 Accessibility and localisation

-   Keyboard navigation and visible focus for all interactive controls.

-   WCAG 2.2 AA as the design target; test contrast, labels, focus order
    and screen-reader announcements.

-   English first; architecture should support Kiswahili labels and
    content localisation.

-   Date and number formats use configurable locale; store timestamps in
    UTC and display Africa/Nairobi time by default.

-   Forms should include inline validation, plain-language error
    messages and save-draft behaviour.

# 13. Technical architecture and deployment

## 13.1 Proposed stack

  -----------------------------------------------------------------------
  **Layer**     **Recommended          **Reason / notes**
                technology**           
  ------------- ---------------------- ----------------------------------
  Web           Next.js + TypeScript   Responsive executive and public
  application                          portals; shared component system.

  Mobile field  Progressive Web App    Installable web app; offline
  experience    (PWA)                  drafts and sync; no separate
                                       native app in first release.

  Backend API   NestJS on Node.js      Modular domain services,
                                       validation, background processing
                                       and role checks.

  Database      PostgreSQL             Relational records, transactions,
                                       tenant scope and reporting
                                       queries.

  ORM /         Prisma or TypeORM      Typed data access and controlled
  migrations                           schema migration; select one, not
                                       both.

  Object        S3-compatible storage  Original forms, attachments,
  storage       / MinIO                reports and versioned documents.

  Queue / cache Redis + BullMQ         OCR jobs, notifications, report
                                       generation and retries.

  OCR worker    Self-hosted OCR first; Return field confidence; all
                optional contracted    important values require human
                service after          confirmation.
                DPIA/vendor review.    

  Maps          Leaflet +              Station/location visualisation
                OpenStreetMap or       with source-aware coordinates.
                approved map provider  

  Charts        Recharts               Dashboard charts and reporting
                                       visuals.

  Deployment    Docker Compose         Practical for a small team;
                initially; Caddy       include staging and production
                reverse proxy; VPS or  separation.
                managed cloud.         

  Monitoring    Sentry or equivalent;  Error tracking, metrics, uptime,
                Prometheus/Grafana     queue depth and system health.
                where appropriate.     
  -----------------------------------------------------------------------

## 13.2 Logical architecture

  -----------------------------------------------------------------------
  **Layer**      **Components**
  -------------- --------------------------------------------------------
  Presentation   Executive web; mobile PWA; public portal; admin console.

  Access and API Authentication; MFA; rate limiting; tenant resolution;
                 API gateway/controller layer.

  Domain modules Organisation; tasks; events; field; election; tally;
                 finance; office; cases; projects; reporting.

  Shared         Audit; document storage; notification; geography;
  services       form-version registry; approval workflow.

  Persistence    PostgreSQL; object storage; Redis queue; backups;
                 immutable/append-only audit stream.

  External       Email; SMS; mapping; payment gateway if used; approved
  services       OCR; analytics/monitoring.
  -----------------------------------------------------------------------

## 13.3 Multi-tenant design

Use a tenant_id on all tenant-owned entities. PostgreSQL row-level
security can provide defence in depth, while the application layer
performs explicit authorisation checks. Cross-tenant queries should be
impossible by default. Platform support access must be time-bound,
approved, logged and visible to the tenant owner.

## 13.4 Offline and sync design

-   Cache only the application shell and low-risk reference data; do not
    cache sensitive datasets.

-   Save field drafts locally with minimal data and encryption; assign
    UUIDs before sync.

-   Each queued record has local status, server status, retry count,
    last attempt and error details.

-   Use idempotency keys on retries; resolve sync conflicts through
    explicit review and never silently overwrite server values. Show
    local saves separately from server-confirmed uploads.

# 14. Data model and core properties

The initial schema should prioritise clean boundaries between
operational records, personal data, election result sources and public
information. The list below is a logical data model, not final SQL.
Field names should be agreed before database migrations.

  -----------------------------------------------------------------------
  **Entity**       **Core properties (illustrative)**
  ---------------- ------------------------------------------------------
  Tenant           id; name; type; status; locale; timezone;
                   retention_profile; created_at.

  User             id; tenant_id; name; email/phone; account_status;
                   MFA_state; last_login; consent/notice references.

  Role /           role_id; name; permission_key; scope_type; resource;
  Permission       action; expiry.

  Department /     id; tenant_id; parent_id; code; name; lead_user_id;
  Team             geography_scope; active_dates.

  Election cycle   id; name; date; jurisdiction; legal_config_version;
                   status; official_sources.

  Contest /        id; election_id; office_type;
  Candidate        candidate_name_as_published; party/independent label;
  reference        ballot/reference code; source.

  Geographic unit  id; election_id; type; parent_id; official_code;
                   official_name; source_version; valid_from/to.

  Polling station  id; election_id; geographic_unit_id; code; name;
                   registry_version; status; location_source.

  Agent assignment id; election_id; station_id; user_id;
                   accreditation_status; training_state;
                   assignment_status; approved_by.

  Form template    id; election_id; contest_type; form_number; version;
                   effective_date; field_schema; validation_rules;
                   official_source.

  Result           id; tenant_id; election_id; contest_id;
  submission       form_template_id; station_id; submitter_id;
                   source_file_id; status; timestamps.

  Result value     id; submission_id; candidate_ref_id; field_key;
                   numeric_value/text_value; OCR_confidence;
                   confirmed_by; change_version.

  Verification     id; submission_id; reviewer_id; decision; checklist;
                   notes; reviewed_at; supervisor_action.

  Tally snapshot   id; election_id; contest_id; geography_scope;
                   calculation_version; included_submission_ids;
                   totals_json; created_at.

  Discrepancy case id; source_submission_ids; variance_type; severity;
                   assigned_to; status; resolution; closure_approver.

  Incident         id; tenant_id; category; geography; reporter_id;
                   factual_description; evidence_ids; priority; status;
                   assignee.

  Task / Event     id; tenant_id; owner; assignee; due_at; status;
                   priority; geography; evidence; approval_state.

  Finance          id; tenant_id; type; category; amount; currency;
  transaction      payee; reference; document_ids; approval_state;
                   authorised_by.

  Citizen case     id; public_reference; requester_contact_optional;
                   category; description; geography; consent_notice;
                   assignee; referral; status.

  Project /        id; tenant_id; institution; location; funding_source;
  Milestone        budget; milestone; evidence; verification_state.

  Audit event      id; tenant_id; actor_id; action; entity_type;
                   entity_id; before_hash; after_hash; source_ip/device;
                   timestamp; reason.
  -----------------------------------------------------------------------

## 14.1 Data-quality rules

-   Use stable UUID primary keys; keep official external codes in
    separate fields.

-   Use decimal or integer numeric types with explicit currency; do not
    store financial values as free text.

-   Store source timestamps and system timestamps separately where
    needed.

-   Use soft-delete only where lawful and appropriate; use
    archival/retention workflows for records under legal or operational
    hold.

-   Keep original source file and extracted values separate.

-   Version reference datasets, form templates, validation rules and
    aggregate calculation logic.

# 15. Security, privacy and legal controls

## 15.1 Security baseline

  ------------------------------------------------------------------------
  **Control**      **Minimum requirement**
  ---------------- -------------------------------------------------------
  Authentication   MFA for privileged users; secure password/session
                   controls; suspicious-login alerts; account recovery
                   safeguards.

  Authorisation    Role- and geography-based access; deny by default;
                   server-side checks on every request.

  Tenant isolation Tenant-aware database access; row-level security;
                   automated cross-tenant tests.

  Encryption       TLS in transit; encrypted disks/backups; object-store
                   encryption; secrets manager or protected environment
                   secrets.

  Audit            Append-only record of logins, exports, approvals,
                   changes, role grants and result verification actions.

  File security    File-type validation; malware scanning; size limits;
                   private buckets; short-lived signed URLs.

  Application      CSRF/XSS/SQL injection protection; rate limits; secure
  security         headers; dependency scanning; secure code review.

  Operations       Patch schedule; access review; backup testing; incident
                   response; restore drills; production change approval.

  Election         Load testing; failover drill; queue monitoring;
  readiness        read-only emergency mode; known-contact escalation
                   list.
  ------------------------------------------------------------------------

## 15.2 Data protection and electoral privacy

The ODPC Guidance Notes for Electoral Purposes apply to organisations
and stakeholders processing personal data in election contexts. They
describe lawfulness, fairness and transparency, purpose limitation, data
minimisation, accuracy, storage limitation, integrity/confidentiality
and accountability as core principles. \[4\]

-   Before processing personal data, document the role of each party as
    data controller or data processor and execute the appropriate
    data-processing agreement.

-   Complete a Data Protection Impact Assessment before high-risk
    processing. Electoral data, large-scale processing, sensitive data
    or new technology may create high risk and require additional
    safeguards.

-   Provide a clear privacy notice at collection. Record purpose, lawful
    basis, recipient categories, retention and user rights.

-   ODPC guidance says organisations canvassing political support among
    the electorate are not exempt from mandatory registration solely
    because they are small; obtain specific legal advice on each
    customer and the vendor's controller/processor status. \[5\]

-   Do not import voter registers, collect political preferences,
    ethnicity, religion, biometrics or sensitive personal data into the
    product for analytics or targeting.

-   Do not combine customer datasets to create individual political
    profiles or infer political beliefs.

-   Use separate data stores/permissions for campaign staff records,
    citizen case submissions, financial data and result-form evidence.

-   Implement retention schedules, deletion/archival workflows,
    data-subject request handling and breach response procedures.

## 15.3 Election integrity and legal boundary

-   Polling agents must operate only within their accreditation and the
    law; NGAO360 records assignments and reports but does not grant
    polling-station access.

-   The system must not connect to or impersonate IEBC technology,
    KIEMS, results transmission channels or official portals.

-   Only result-form copies lawfully received by authorised users may be
    uploaded. The system must not encourage obstruction, intimidation,
    unauthorised recording or interference with polling/counting.

-   The platform's tally is independent and non-statutory. IEBC remains
    the election management body and the authority for official
    declarations/certification.

-   All incident reports should be factual, time-stamped and reviewable.
    No auto-labeling of a person or institution as fraudulent or
    criminal.

-   Campaign finance settings must be configurable to the applicable
    2027 Act, Regulations, Gazette notices and official directions; do
    not hardcode unverified limits or reporting dates.

## 15.4 Data breach response

Maintain a documented response process: detect → contain → preserve
evidence → assess scope and risk → notify the controller and affected
parties/regulator where legally required → remediate → document lessons.
The product should provide a breach register and exportable incident
timeline.

# 16. Non-functional requirements and integrations

## 16.1 Proposed service targets

These are initial engineering targets for planning and must be confirmed
through load testing, deployment design and budget. They are not current
performance claims.

  ------------------------------------------------------------------------
  **Area**        **Initial target / requirement**
  --------------- --------------------------------------------------------
  Availability    99.5% monthly target for standard modules; election-day
                  enhanced operations target to be defined after
                  resilience testing.

  API response    95th percentile under 700 ms for common read operations
                  under the agreed pilot load, excluding external provider
                  delays.

  Search          Common tenant-scoped search results within 2 seconds at
                  pilot scale.

  Offline sync    Queued records retry safely; duplicate prevention by
                  idempotency; visible state at all times.

  Backup          Encrypted daily full backup plus frequent database
                  point-in-time recovery/WAL archive; test restoration
                  regularly.

  Recovery        Proposed RPO 15 minutes and RTO 2 hours for standard
                  service; election-day target requires dedicated
                  rehearsal and infrastructure.

  Scale           Architecture should be load-tested against forecast
                  concurrent field users and form-upload bursts before
                  operational use.

  Accessibility   WCAG 2.2 AA design target for key public and staff
                  workflows.

  Browser support Current stable Chrome, Edge, Firefox and Safari; test
                  Android Chrome and iOS Safari for PWA.

  Audit retention Configurable retention schedule; legal hold capability;
                  no silent deletion of verified result history.
  ------------------------------------------------------------------------

## 16.2 Integrations

  --------------------------------------------------------------------------------
  **Integration**        **Use**                    **Control**
  ---------------------- -------------------------- ------------------------------
  Email provider         Invitations, case          Verified sender domain;
                         acknowledgements,          delivery logs; bounce
                         approvals, reports.        handling.

  SMS gateway            Short operational notices. Consent/authorised lists;
                                                    template approval; opt-out;
                                                    delivery audit.

  Map tiles/geocoding    Location display and       Use approved data source;
                         station maps.              respect provider terms; cache
                                                    policy.

  Payment provider       Optional office fees or    Use official APIs; reconcile
                         merchant/supplier payments references; never store
                         if business case exists.   card/mobile-money PINs.

  OCR engine             Pre-fill values from form  DPIA/vendor review; data
                         images.                    minimisation; confidence
                                                    score; human review mandatory.

  Analytics/monitoring   System health and product  No personal political
                         usage.                     profiling; aggregate and
                                                    minimise telemetry.

  IEBC data              Official published forms,  Manual/approved import from
                         timetables and public      public sources; no assumption
                         station reference          of private APIs or formal
                         material.                  integration.
  --------------------------------------------------------------------------------

# 17. Testing, acceptance criteria and release roadmap

## 17.1 Testing strategy

  -----------------------------------------------------------------------
  **Test layer** **Coverage**
  -------------- --------------------------------------------------------
  Unit tests     Business rules; status transitions; amount calculations;
                 form-field rules; permission checks.

  Integration    Database transactions; file upload; queue retries;
  tests          SMS/email provider; audit event creation.

  End-to-end     Onboarding; create task; assign user; upload form;
  tests          second-person review; publish internal report.

  Form           One fixture for each supported form version and contest;
  regression     legibility cases; missing fields; edge arithmetic.
  tests          

  Security tests Cross-tenant isolation; privilege escalation; insecure
                 direct object reference; file upload; session handling.

  Load tests     Burst uploads; simultaneous logins; dashboard refresh;
                 tally recalculation; queue backlog recovery.

  Offline tests  Airplane mode; intermittent network; duplicate retries;
                 expired session; local draft recovery.

  Usability      New user onboarding; mobile form capture; low-bandwidth
  tests          use; accessible keyboard navigation.

  Disaster       Restore database and object store; validate hashes;
  recovery       reconcile queue; confirm RTO/RPO.
  -----------------------------------------------------------------------

## 17.2 Acceptance criteria for NGAO TALLY

-   Each supported form template is linked to its official source,
    version and effective date.

-   The user can upload and preserve an original form image with a
    unique submission ID and calculated hash.

-   The form capture interface records all configured fields and source
    metadata.

-   OCR is labelled as a draft extraction; a human must confirm every
    vote value.

-   The system prevents a user from independently verifying their own
    submission.

-   All validation warnings identify the exact field/rule and do not
    automatically discard or alter source data.

-   Only verified submissions are included in the default parallel
    tally; exclusions and missing records remain visible.

-   Any change to a captured result value records actor, old value, new
    value, time and reason.

-   Exports carry the explicit non-official parallel-tally disclaimer
    and snapshot reference.

-   No user interface or marketing copy suggests that NGAO360 declares
    or certifies election winners.

## 17.3 Proposed implementation roadmap

The schedule below is a planning sequence, not a delivery promise. The
release dates must be reset after the first engineering estimate, access
to official forms and pilot-user feedback.

  -------------------------------------------------------------------------
  **Stage**       **Indicative   **Deliverables**
                  duration**     
  --------------- -------------- ------------------------------------------
  0\. Discovery   2 weeks        Customer interviews; product scope; legal
  and validation                 review; current official form pack; data
                                 map; prototype.

  1\. Platform    3--4 weeks     Tenant model; login/MFA; RBAC; audit; file
  foundation                     service; design system; staging/production
                                 pipeline.

  2\. Command and 3--4 weeks     Executive dashboard; teams; users; tasks;
  organisation                   events; reports; notification centre.

  3\. Field and   3--4 weeks     Geography registry; agents; assignments;
  election                       training; field PWA; incident intake;
  operations                     readiness dashboard.

  4\. NGAO TALLY  4--6 weeks     Form version registry; capture; OCR draft;
  core                           human review; verification; validations;
                                 aggregate and reconciliation.

  5\. Office and  3--4 weeks     Correspondence; citizen cases; projects;
  public portal                  public information pages; access and
                                 privacy review.

  6\. Pilot and   4--6 weeks     User testing; security review; load test;
  hardening                      recovery drill; training; support
                                 procedures; controlled pilot.
  -------------------------------------------------------------------------

## 17.4 Suggested election readiness milestones

IEBC's Election Operations Plan states that the 2027 General Election is
scheduled for Tuesday, 10 August 2027 and shows a campaign period from
29 May to 7 August 2027. Treat the official IEBC notices and any
subsequent legal changes as authoritative. \[1\]

  -----------------------------------------------------------------------
  **Milestone**     **Target state**
  ----------------- -----------------------------------------------------
  Before pilot      Core Command Centre, organisation roles and audit
                    logging usable with synthetic data.

  Before field      Agent assignments, field reporting, offline queue and
  trial             station registry validated against the approved
                    public station list.

  Before tally      All 2027 form versions loaded; sample forms tested;
  rehearsal         two-person verification and audit trail demonstrated.

  Before election   Security review, load test, backup/restore drill,
  operations        support rota and incident response rehearsal
                    completed.

  Post-election     Archive and evidence retention plan; customer
                    handover; closure of temporary access;
                    lessons-learned report.
  -----------------------------------------------------------------------

# 18. Risks, assumptions and decisions to confirm

  --------------------------------------------------------------------------
  **Risk /           **Why it matters**   **Mitigation / decision**
  assumption**                            
  ------------------ -------------------- ----------------------------------
  2027 forms may     Static form fields   Make templates and rules
  change             or rules could       versioned; confirm latest IEBC
                     become incorrect.    forms before go-live.

  Brand clearance    NGAO360 name may     Complete trademark, business-name,
  not complete       conflict with        domain and social-handle checks.
                     existing use or      
                     marks.               

  No formal IEBC     Assuming a private   Use authorised documents and
  integration        API could create     public data only; no system
                     legal and technical  interconnection unless formally
                     risk.                approved.

  Poor source image  OCR may misread      Image quality guide; confidence
  quality            critical vote        display; manual entry and
                     digits.              second-person verification.

  Incorrect tally    A parallel tally may Persistent disclaimer; source
  interpretation     be confused with an  links; coverage; no
                     official result.     winner/certification language.

  Personal-data      Election-related     DPIA; controller/processor
  misuse             personal data can    contracts; ODPC compliance;
                     create high rights   minimum necessary data.
                     risks.               

  Political scope    Product could be     Explicit prohibited-use policy; no
  creep              used for voter       voter preference profiles; no
                     profiling or         sensitive-trait targeting.
                     manipulative         
                     targeting.           

  Connectivity       Field users may not  Offline draft queue;
  failure            submit in real time. store-and-forward; upload status;
                                          sync testing.

  Malicious insider  Privileged users     Segregation of duties; MFA; audit;
                     could alter or       least privilege; export review.
                     export sensitive     
                     records.             

  Single-developer   A broad platform is  Prioritise modular MVP; automate
  delivery risk      difficult to build   tests; document code; recruit
                     and maintain alone.  pilot testers; phase scope.
  --------------------------------------------------------------------------

## 18.1 Decisions required before implementation

-   Confirm target customer for the first pilot: one political
    organisation, one political office, or a civic institution.

-   Confirm whether the first deployment is Bungoma-focused for the
    station registry or county-agnostic from the beginning.

-   Confirm the first supported election contest for end-to-end
    rehearsal while keeping the common data model ready for all six
    elective positions.

-   Obtain the current IEBC 2027 forms, official instructions and
    station-list source.

-   Agree who is the data controller and who is the processor for each
    customer deployment.

-   Complete trademark and domain clearance for NGAO360.

-   Choose hosting region, backup region, SMS/email vendors and support
    model.

-   Approve the demo data policy: all public demonstrations use
    synthetic candidates, stations and totals.

# Appendix A. Kenyan result-form reference matrix

The following summary is a product configuration guide based on the
currently retrieved IEBC-hosted Elections (General) (Amendment)
Regulations, 2017. It should be revalidated against the official forms
and directives issued for the 2027 General Election before production
use. \[2\]

  --------------------------------------------------------------------------------
  **Office**       **Polling-station   **Collation / declaration** **Certificate
                   result                                          issued by
                   declaration**                                   election
                                                                   authority**
  ---------------- ------------------- --------------------------- ---------------
  President        34A                 34B at constituency stage;  34D
                                       34C at national stage       

  National         35A                 35B at constituency stage   35C
  Assembly                                                         

  County Assembly  36A                 36B at constituency stage   36C

  Governor         37A                 37B at constituency stage;  37D
                                       37C at county stage         

  Senator          38A                 38B at constituency stage;  38D
                                       38C at county stage         

  County Woman     39A                 39B at constituency stage;  39D
  Representative                       39C at county stage         
  --------------------------------------------------------------------------------

## A.1 Governor workflow in detail

-   Form 37A: County Governor election results at the polling station.
    The current schedule includes station, ward, constituency and county
    identifiers; votes per candidate; total valid votes; polling-station
    counts; disputed-vote details; declaration and agent
    signature/reasons fields. \[2\]

-   Form 37B: Collation of County Governor election results at the
    constituency tallying centre. The constituency-level record
    aggregates the station results for onward county handling. \[2\]

-   Form 37C: Declaration of County Governor election results at the
    county tallying centre. It includes constituency and polling-station
    identifiers, candidate figures, votes cast, rejected votes, valid
    votes, sub-totals and aggregate results. \[2\]

-   Form 37D: Certificate of the elected County Governor. This is an
    official certificate issued by the County Returning Officer, not
    generated by NGAO360. \[2\]

## A.2 Official handling of source forms

IEBC Gazette Notice No. 9280 set out 2022-specific directions for
handling result-form booklets, signatures, images, copies and sealing.
NGAO360 should use that as historical process context only; the actual
2027 handling instructions must be rechecked and configured from current
IEBC directions. \[3\]

# Appendix B. Source register and legal-reference notes

Sources checked for this initial blueprint on 16 November 2026. These
references support product assumptions and configuration guidance; they
do not replace advice from a Kenyan election-law or data-protection
professional.

**\[1\] Independent Electoral and Boundaries Commission. Election
Operations Plan 2025--2027.**

> https://www.iebc.or.ke/uploads/resources/tpFfOlBLRh.pdf
>
> Used for the 10 August 2027 election date; campaign-period timeline;
> election results management priorities; records archiving and general
> operational planning.

**\[2\] Independent Electoral and Boundaries Commission. Elections
(General) (Amendment) Regulations, 2017, Legal Notice No. 72.**

> https://www.iebc.or.ke/uploads/resources/o8K6y0Co5S.pdf
>
> Used for polling-station forms under regulation 79, tallying/collation
> requirements under regulation 83, and county/national returns and
> certificates under regulation 87, including forms 34A--39D.

**\[3\] Independent Electoral and Boundaries Commission. Gazette Notice
No. 9280: Directives on handling election result forms for the 9 August
2022 General Election.**

> https://www.iebc.or.ke/uploads/resources/ODdCkHH0ht.pdf
>
> Historical reference only for source-form handling. 2027 directives
> must be checked independently.

**\[4\] Office of the Data Protection Commissioner. Guidance Notes for
Electoral Purposes.**

> https://www.odpc.go.ke/wp-content/uploads/2024/02/ODPC-Guidance-Notes-for-Electoral-Purposes.pdf
>
> Used for electoral personal-data principles, lawful basis,
> sensitive-data safeguards and transparency requirements.

**\[5\] Office of the Data Protection Commissioner. Frequently Asked
Questions: Registration of Data Controllers and Data Processors.**

> https://www.odpc.go.ke/faqs/
>
> Used for ODPC registration requirements and the specific non-exemption
> category concerning canvassing political support.

**\[6\] Kenya Law. Laws of Kenya and subsidiary legislation index.**

> https://new.kenyalaw.org/legislation/
>
> Use to confirm current versions of the Elections Act, Elections
> (General) Regulations, Election Campaign Financing Act and 2026
> Regulations before production configuration.

**\[7\] Office of the Data Protection Commissioner. Data Protection Act
and regulatory framework.**

> https://www.odpc.go.ke/data-protection-laws-kenya/
>
> Official entry point for the Data Protection Act, General Regulations,
> Registration Regulations and other related instruments.

# Final product note

+-----------------------------------------------------------------------+
| **NGAO360 development principle**                                     |
|                                                                       |
| Build for traceability, correctness, privacy and operational          |
| usefulness. A polished dashboard is only the visible layer; the       |
| product's value depends on accurate source handling, clear            |
| permissions, trustworthy workflows, tested offline behaviour and an   |
| audit trail that stands up to scrutiny.                               |
+=======================================================================+
+-----------------------------------------------------------------------+
