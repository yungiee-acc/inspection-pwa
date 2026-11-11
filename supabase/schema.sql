-- =====================================================================
-- 進貨查驗 PWA ── Supabase 資料庫結構、權限(RLS)、異動紀錄
-- 使用方式：Supabase 後台 → SQL Editor → 貼上整份執行（可重複執行）。
-- 執行完再執行 seed.sql（ERP 品號與廠商主檔）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 使用者資料（登入由 Supabase Auth 負責；這裡存姓名與角色）
--    角色：inspector 查驗人員 / office 辦公室 / admin 管理員
--    新註冊的人預設 active=false（停用），必須由管理員啟用才能使用資料
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role         text not null default 'inspector' check (role in ('inspector','office','admin')),
  active       boolean not null default false,
  created_at   timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name',''), split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 目前登入者的角色（未啟用或沒有 profile → null）
create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

-- ---------------------------------------------------------------------
-- 2. 主檔
-- ---------------------------------------------------------------------
create table if not exists public.erp_items (
  code        text primary key,
  name        text not null,
  unit        text,
  report_name text,                      -- 對照查驗報告（ERP 主檔 D 欄）；空白＝尚未對照
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);
create table if not exists public.vendors (
  code        text primary key,
  short_name  text not null,
  full_name   text not null,
  tax_id      text,
  in_scope    boolean not null default false,   -- 納入手機廠商選單
  report_name text,                             -- 報告「回收商」欄顯示名稱；空白＝用簡稱
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. 現場查驗
-- ---------------------------------------------------------------------
create table if not exists public.inspections (
  id             uuid primary key default gen_random_uuid(),
  inspection_id  text not null unique,           -- 例 INS-20261109-8M7H1（人看的唯一編號）
  client_uuid    uuid not null unique,           -- 手機端產生；防止同一次輸入被重複送出
  inspected_at   timestamptz not null,
  vendor_code    text not null references public.vendors(code),
  vendor_name    text,                           -- 當時的廠商全名（快照）
  vehicle_no     text not null,
  erp_code       text not null references public.erp_items(code),  -- 手機選擇的原始 ERP 品號，永久保留
  sample_code    text not null,
  gross_kg       numeric(10,2) not null check (gross_kg > 0),
  water_kg       numeric(10,2) not null default 0 check (water_kg >= 0),
  impurity_kg    numeric(10,2) not null default 0 check (impurity_kg >= 0),
  wire_kg        numeric(10,2) not null default 0 check (wire_kg >= 0),
  impurity_types text[] not null default '{}',
  inspector_name text not null,
  note           text,
  status         text not null default 'active' check (status in ('active','void')),
  rev            integer not null default 1,     -- 每次修改 +1（用於多人同時修改的衝突偵測與配對失效）
  locked         boolean not null default false, -- 已納入「已審核」報告 → 鎖定
  change_reason  text,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_by     uuid,
  updated_at     timestamptz not null default now(),
  check (water_kg + impurity_kg + wire_kg < gross_kg)
);
create index if not exists inspections_at_idx on public.inspections(inspected_at);
create index if not exists inspections_plate_idx on public.inspections(upper(vehicle_no));

create or replace function public.inspections_before() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.rev := 1; new.locked := false; new.status := 'active';
    new.created_by := auth.uid(); new.created_at := now(); new.updated_at := now();
  else
    new.id := old.id; new.inspection_id := old.inspection_id; new.client_uuid := old.client_uuid;
    new.created_by := old.created_by; new.created_at := old.created_at;
    -- 只是「鎖定／解鎖」(審核報告時)：內容沒變，不增加版次，否則剛確認的配對會被誤判為「查驗被修改」而失效
    if new.locked is distinct from old.locked
       and (to_jsonb(new) - array['locked','rev','updated_at','updated_by','change_reason'])
         = (to_jsonb(old) - array['locked','rev','updated_at','updated_by','change_reason']) then
      new.rev := old.rev; return new;
    end if;
    if old.status = 'void' then raise exception '已作廢的查驗不能再修改'; end if;
    new.rev := old.rev + 1; new.updated_by := auth.uid(); new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists inspections_before_trg on public.inspections;
create trigger inspections_before_trg before insert or update on public.inspections
  for each row execute function public.inspections_before();

-- ---------------------------------------------------------------------
-- 4. 環資匯入資料
-- ---------------------------------------------------------------------
create table if not exists public.hz_imports (
  id          uuid primary key default gen_random_uuid(),
  file_name   text, file_hash text unique, weigh_date date not null, row_count int,
  imported_by uuid default auth.uid(), imported_at timestamptz not null default now()
);
create table if not exists public.hz_rows (
  weigh_date date not null,
  seq_no     text not null,                -- 環資「序號」（過磅流水號）
  weigh_time timestamptz,
  category   text, vendor_name text not null, item_name text not null, vehicle_no text not null,
  ship_no    text not null,                -- 環資「出貨序號」（不是 ERP 地磅單號！）
  gross_kg numeric(12,2), tare_kg numeric(12,2), deduct_kg numeric(12,2), net_kg numeric(12,2), bricks numeric(10,0),
  remark text, weigher text, src_row int,
  import_id uuid references public.hz_imports(id),
  primary key (weigh_date, seq_no)
);

-- ---------------------------------------------------------------------
-- 5. 配對決定 / 報告版本
-- ---------------------------------------------------------------------
create table if not exists public.match_decisions (
  key         text primary key,            -- row:序號 / ack:序號 / trip:出貨序號 / insp:查驗編號
  report_date date not null,
  value       jsonb not null,
  updated_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now()
);
create or replace function public.touch_decision() returns trigger language plpgsql as $$
begin new.updated_by := auth.uid(); new.updated_at := now(); return new; end $$;
drop trigger if exists match_decisions_touch on public.match_decisions;
create trigger match_decisions_touch before insert or update on public.match_decisions
  for each row execute function public.touch_decision();

create table if not exists public.reports (
  id             uuid primary key default gen_random_uuid(),
  report_date    date not null,
  version        int  not null,
  status         text not null default 'draft' check (status in ('draft','approved','superseded')),
  snapshot       jsonb not null,           -- 報告當下的完整內容（之後再怎麼改資料，這個版次的內容都不變）
  data_hash      text not null,
  inspection_ids text[] not null default '{}',
  reason         text,
  created_by     uuid default auth.uid(), created_at timestamptz not null default now(),
  approved_by    uuid, approved_at timestamptz,
  unique (report_date, version)
);

-- ---------------------------------------------------------------------
-- 6. 異動紀錄（資料庫觸發器自動寫入，使用者無法修改或刪除）
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid, actor_name text,
  table_name text not null, pk text, action text not null,
  old jsonb, new jsonb
);
create or replace function public.audit_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; nm text; j jsonb;
begin
  select display_name into nm from public.profiles where id = auth.uid();
  j := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  k := j ->> tg_argv[0];
  insert into public.audit_log(actor, actor_name, table_name, pk, action, old, new)
  values (auth.uid(), nm, tg_table_name, k, lower(tg_op),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return null;
end $$;

do $$ declare t record; begin
  for t in select * from (values ('inspections','inspection_id'),('erp_items','code'),('vendors','code'),
      ('hz_rows','seq_no'),('match_decisions','key'),('reports','id'),('profiles','id')) as v(tbl, pkcol) loop
    execute format('drop trigger if exists audit_%1$s on public.%1$s', t.tbl);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function public.audit_trg(%2$L)', t.tbl, t.pkcol);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. 權限：先全部收回，再逐項開放；所有資料表啟用 RLS
-- ---------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.erp_items       enable row level security;
alter table public.vendors         enable row level security;
alter table public.inspections     enable row level security;
alter table public.hz_imports      enable row level security;
alter table public.hz_rows         enable row level security;
alter table public.match_decisions enable row level security;
alter table public.reports         enable row level security;
alter table public.audit_log       enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon;

grant select on public.profiles, public.erp_items, public.vendors, public.inspections,
                public.hz_imports, public.hz_rows, public.match_decisions, public.reports, public.audit_log to authenticated;
grant update (display_name, role, active) on public.profiles to authenticated;
grant update (report_name, active, name, unit) on public.erp_items to authenticated;
grant update (report_name, in_scope) on public.vendors to authenticated;
grant insert (inspection_id, client_uuid, inspected_at, vendor_code, vendor_name, vehicle_no, erp_code, sample_code,
              gross_kg, water_kg, impurity_kg, wire_kg, impurity_types, inspector_name, note) on public.inspections to authenticated;
grant update (inspected_at, vendor_code, vendor_name, vehicle_no, erp_code, sample_code, gross_kg, water_kg, impurity_kg, wire_kg,
              impurity_types, inspector_name, note, status, change_reason) on public.inspections to authenticated;   -- 不含 locked / rev：只有函式能改
grant insert, update, delete on public.match_decisions to authenticated;
grant delete on public.reports to authenticated;       -- 僅限草稿（見 policy）

-- profiles
drop policy if exists p_sel on public.profiles;
create policy p_sel on public.profiles for select to authenticated using (id = auth.uid() or public.app_role() = 'admin');
drop policy if exists p_upd on public.profiles;
create policy p_upd on public.profiles for update to authenticated using (public.app_role() = 'admin') with check (public.app_role() = 'admin');
-- 主檔
drop policy if exists erp_sel on public.erp_items;  create policy erp_sel on public.erp_items for select to authenticated using (public.app_role() is not null);
drop policy if exists erp_upd on public.erp_items;  create policy erp_upd on public.erp_items for update to authenticated using (public.app_role() = 'admin') with check (public.app_role() = 'admin');
drop policy if exists ven_sel on public.vendors;    create policy ven_sel on public.vendors for select to authenticated using (public.app_role() is not null);
drop policy if exists ven_upd on public.vendors;    create policy ven_upd on public.vendors for update to authenticated using (public.app_role() = 'admin') with check (public.app_role() = 'admin');
-- 查驗：所有啟用的人可讀；新增需登入；修改：本人(未鎖定)、辦公室(未鎖定)、管理員(含已鎖定)
drop policy if exists i_sel on public.inspections;  create policy i_sel on public.inspections for select to authenticated using (public.app_role() is not null);
drop policy if exists i_ins on public.inspections;  create policy i_ins on public.inspections for insert to authenticated with check (public.app_role() is not null);
drop policy if exists i_upd on public.inspections;
create policy i_upd on public.inspections for update to authenticated
  using (public.app_role() = 'admin'
         or (not locked and (public.app_role() = 'office' or (public.app_role() = 'inspector' and created_by = auth.uid()))))
  with check (public.app_role() = 'admin'
         or (not locked and (public.app_role() = 'office' or (public.app_role() = 'inspector' and created_by = auth.uid()))));
-- 環資、配對決定、報告：只有辦公室與管理員
drop policy if exists hi_sel on public.hz_imports;  create policy hi_sel on public.hz_imports for select to authenticated using (public.app_role() in ('office','admin'));
drop policy if exists hr_sel on public.hz_rows;     create policy hr_sel on public.hz_rows for select to authenticated using (public.app_role() in ('office','admin'));
drop policy if exists md_all on public.match_decisions;
create policy md_all on public.match_decisions for all to authenticated using (public.app_role() in ('office','admin')) with check (public.app_role() in ('office','admin'));
drop policy if exists r_sel on public.reports;      create policy r_sel on public.reports for select to authenticated using (public.app_role() in ('office','admin'));
drop policy if exists r_del on public.reports;      create policy r_del on public.reports for delete to authenticated using (status = 'draft' and public.app_role() in ('office','admin'));
-- 異動紀錄：辦公室與管理員可讀；任何人都不能直接寫入（只有觸發器）；查驗人員可讀「自己查驗」的歷程
drop policy if exists a_sel on public.audit_log;
create policy a_sel on public.audit_log for select to authenticated
  using (public.app_role() in ('office','admin') or (public.app_role() = 'inspector' and table_name = 'inspections'));

-- ---------------------------------------------------------------------
-- 8. 函式（security definer：在函式內自己檢查角色）
-- ---------------------------------------------------------------------
-- 8.1 匯入環資：新增、相同略過、不同則回報（overwrite=true 且該日報告未審核才覆蓋）
create or replace function public.import_hz(p_file_name text, p_file_hash text, p_weigh_date date, p_rows jsonb, p_overwrite boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; ex public.hz_rows; imp uuid; added int := 0; same int := 0; over int := 0; changed text[] := '{}';
        approved boolean; dupfile boolean; d date;
begin
  if public.app_role() not in ('office','admin') then raise exception '權限不足'; end if;
  select exists(select 1 from public.reports where report_date = p_weigh_date and status = 'approved') into approved;
  select exists(select 1 from public.hz_imports where file_hash = p_file_hash) into dupfile;
  if not dupfile then
    insert into public.hz_imports(file_name, file_hash, weigh_date, row_count) values (p_file_name, p_file_hash, p_weigh_date, jsonb_array_length(p_rows)) returning id into imp;
  else select id into imp from public.hz_imports where file_hash = p_file_hash; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    d := (r->>'weigh_date')::date;
    select * into ex from public.hz_rows where weigh_date = d and seq_no = r->>'seq_no';
    if not found then
      insert into public.hz_rows(weigh_date, seq_no, weigh_time, category, vendor_name, item_name, vehicle_no, ship_no, gross_kg, tare_kg, deduct_kg, net_kg, bricks, remark, weigher, src_row, import_id)
      values (d, r->>'seq_no', nullif(r->>'weigh_time','')::timestamptz, r->>'category', r->>'vendor_name', r->>'item_name', r->>'vehicle_no', r->>'ship_no',
              (r->>'gross_kg')::numeric, (r->>'tare_kg')::numeric, (r->>'deduct_kg')::numeric, (r->>'net_kg')::numeric, (r->>'bricks')::numeric,
              r->>'remark', r->>'weigher', (r->>'src_row')::int, imp);
      added := added + 1;
    elsif ex.vendor_name = r->>'vendor_name' and ex.item_name = r->>'item_name' and ex.vehicle_no = r->>'vehicle_no' and ex.ship_no = r->>'ship_no'
          and ex.gross_kg = (r->>'gross_kg')::numeric and ex.tare_kg = (r->>'tare_kg')::numeric and ex.net_kg = (r->>'net_kg')::numeric and ex.bricks = (r->>'bricks')::numeric then
      same := same + 1;
    elsif p_overwrite and not approved then
      update public.hz_rows set weigh_time = nullif(r->>'weigh_time','')::timestamptz, vendor_name = r->>'vendor_name', item_name = r->>'item_name', vehicle_no = r->>'vehicle_no',
             ship_no = r->>'ship_no', gross_kg = (r->>'gross_kg')::numeric, tare_kg = (r->>'tare_kg')::numeric, deduct_kg = (r->>'deduct_kg')::numeric,
             net_kg = (r->>'net_kg')::numeric, bricks = (r->>'bricks')::numeric, import_id = imp
       where weigh_date = d and seq_no = r->>'seq_no';
      over := over + 1;
    else changed := changed || (r->>'seq_no'); end if;
  end loop;
  return jsonb_build_object('added', added, 'same', same, 'changed', to_jsonb(changed), 'overwritten', over, 'dupFile', dupfile, 'approvedLock', approved);
end $$;

-- 8.2 建立報告草稿（版次自動 +1；同一天已有草稿就不能再建）
create or replace function public.create_report_draft(p_date date, p_snapshot jsonb, p_hash text, p_ids text[], p_reason text)
returns public.reports language plpgsql security definer set search_path = public as $$
declare v int; rec public.reports;
begin
  if public.app_role() not in ('office','admin') then raise exception '權限不足'; end if;
  if exists(select 1 from public.reports where report_date = p_date and status = 'draft') then raise exception '這一天已有草稿，請先審核或刪除'; end if;
  select coalesce(max(version), 0) + 1 into v from public.reports where report_date = p_date;
  insert into public.reports(report_date, version, snapshot, data_hash, inspection_ids, reason)
  values (p_date, v, p_snapshot, p_hash, coalesce(p_ids, '{}'), case when v = 1 and coalesce(p_reason,'') = '' then '初版' else p_reason end)
  returning * into rec;
  return rec;
end $$;

-- 8.3 審核：審核者(office)與後台管理者(admin)。舊的已審核版次 → superseded；本版納入的查驗 → 鎖定
create or replace function public.approve_report(p_id uuid)
returns public.reports language plpgsql security definer set search_path = public as $$
declare rec public.reports;
begin
  if public.app_role() not in ('office','admin') then raise exception '只有審核者或後台管理者可以審核'; end if;
  select * into rec from public.reports where id = p_id for update;
  if not found then raise exception '找不到報告'; end if;
  if rec.status <> 'draft' then raise exception '只有草稿可以審核'; end if;
  update public.reports set status = 'superseded' where report_date = rec.report_date and status = 'approved';
  update public.reports set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_id returning * into rec;
  update public.inspections set locked = true where inspection_id = any(rec.inspection_ids);
  return rec;
end $$;

-- 8.4 解鎖：僅管理員，用於更正。必須填原因（寫入異動紀錄）
create or replace function public.unlock_report_date(p_date date, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare rec public.reports; nm text;
begin
  if public.app_role() <> 'admin' then raise exception '只有管理員可以解鎖'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '請填寫解鎖原因'; end if;
  select * into rec from public.reports where report_date = p_date and status = 'approved';
  if not found then raise exception '這一天沒有已審核的報告'; end if;
  update public.inspections set locked = false where inspection_id = any(rec.inspection_ids);
  select display_name into nm from public.profiles where id = auth.uid();
  insert into public.audit_log(actor, actor_name, table_name, pk, action, new) values (auth.uid(), nm, 'reports', rec.id::text, 'unlock', jsonb_build_object('reason', p_reason, 'report_date', p_date, 'version', rec.version));
end $$;

grant execute on function public.app_role(), public.import_hz(text,text,date,jsonb,boolean), public.create_report_draft(date,jsonb,text,text[],text),
      public.approve_report(uuid), public.unlock_report_date(date,text) to authenticated;

-- 備註：
--  * 第一位管理員：在 Authentication → Users 新增使用者後，執行
--      update public.profiles set role='admin', active=true where id=(select id from auth.users where email='你的信箱');
--  * 請到 Authentication → Providers → Email 關閉「Allow new users to sign up」，只由管理員建立帳號。
