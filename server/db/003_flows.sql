-- The configurable intake conversation.
--
-- Until now the clerk asked three hard-coded questions. A flow replaces that
-- with a small graph the owner edits in /admin: message, question, condition
-- and end steps, wired together by ids. Tenants with no flow fall back to the
-- legacy tenants.qualification_config.questions array, and then to the built-in
-- default, so nothing breaks on the way in.

alter table tenants add column if not exists flow jsonb;

-- Where a live conversation currently stands in that graph: the step awaiting
-- an answer, every answer collected so far, and the re-ask counters. Kept on
-- the conversation rather than in qualifications because it is runtime state,
-- not a verdict.
alter table conversations add column if not exists flow_state jsonb not null default '{}'::jsonb;

-- Every save, kept forever. The editor is the only writer and a bad flow can
-- silence a live WhatsApp number, so rolling back has to be one click.
create table if not exists flow_revisions (
  id         bigserial primary key,
  tenant_id  uuid not null references tenants(id) on delete cascade,
  flow       jsonb not null,
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists flow_revisions_tenant_idx on flow_revisions (tenant_id, created_at desc);
