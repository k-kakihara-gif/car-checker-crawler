-- car_listings: カーセンサー掲載車両の属性テーブル（リテールプライシング用）
-- Supabase ダッシュボード > SQL Editor で実行してください

create table if not exists car_listings (
  car_id text primary key,
  maker text,
  model text,
  grade text,
  year int,
  mileage_km int,
  price_man numeric,
  total_price_man numeric,
  repair text,
  url text,
  last_seen_at timestamptz default now()
);

create index if not exists idx_car_listings_model_year on car_listings (model, year);
create index if not exists idx_car_listings_mileage on car_listings (mileage_km);
