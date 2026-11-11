-- 三個帳號的角色設定
-- 步驟：先到 Supabase 後台 Authentication → Users → Add user，建立下列三個帳號（Email 可自訂，
-- 請把下面三個信箱換成你實際建立的，密碼請自己設定並妥善保管，勾選 Auto Confirm User），再執行本檔。
--   一般使用者：現場查驗輸入、查驗紀錄
--   審核者    ：另可匯入環資、配對、產生並審核報告
--   後台管理者：另可維護品項對照／廠商／使用者、解鎖更正

update public.profiles set role='inspector', active=true, display_name='一般使用者'
  where id=(select id from auth.users where email='kimlin@yungiee.com');
update public.profiles set role='office', active=true, display_name='審核者'
  where id=(select id from auth.users where email='b.d@yungiee.com');
update public.profiles set role='admin', active=true, display_name='後台管理者'
  where id=(select id from auth.users where email='fangyu@yungiee.com');

select p.display_name, p.role, p.active, u.email from public.profiles p join auth.users u on u.id=p.id;
